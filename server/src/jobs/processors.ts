import type { Job } from 'agenda';
import { config } from '../config';
import type { BillForAudit, Finding } from '../domain/types';
import { totalsReconcile, verifyItem } from '../extraction/verify';
import { AllModelsBusyError } from '../llm/modelChain';
import { EobExtractionSchema, ExtractionSchema, type LlmProvider } from '../llm/provider';
import { Bill } from '../models/Bill';
import { classifyBill } from '../rules/classify';
import { codesNeeded, fullyDisputedLineIds, ncciVersionFor, runAudit } from '../rules/engine';
import { reconcile, type Eob, type EobLine } from '../rules/reconcile';
import { readPdfText } from '../services/pdfText';
import { loadCmsDescriptions, loadReferenceData } from '../services/referenceData';
import { downloadFile } from '../services/storage';
import { enqueue, getAgenda, JOBS, type BillJobData, type JobName } from './queue';

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [10_000, 40_000];
// When every Gemini model is overloaded, waiting longer helps more than retrying quickly.
const BUSY_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];

class PermanentError extends Error {}

/**
 * Retrying only helps with temporary failures (timeouts, rate limits, server errors).
 * A 4xx response other than 429 (bad model name, invalid key) will fail the same way every time.
 */
function isPermanent(err: unknown): boolean {
  if (err instanceof PermanentError) return true;
  const status = (err as { status?: unknown })?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
}

/**
 * Wraps a processor with retries: failures are rescheduled with growing delays, and after
 * the last attempt the bill is marked failed with a readable error. Each processor
 * overwrites its own step's results, so a retry never duplicates data.
 */
function withRetries(name: JobName, handler: (billId: string, data: BillJobData) => Promise<void>) {
  return async (job: Job<BillJobData>) => {
    const { billId, attempt = 1, eobId } = job.attrs.data;
    // Shows the patient when the next automatic attempt happens while Gemini is busy.
    const setRetryAt = (at: Date | undefined) => {
      const op = at ? '$set' : '$unset';
      if (name === JOBS.extractEob) return Bill.updateOne({ _id: billId, 'eobs.id': eobId }, { [op]: { 'eobs.$.retryAt': at ?? '' } });
      if (name === JOBS.extract) return Bill.updateOne({ _id: billId }, { [op]: { 'retryAt.extract': at ?? '' } });
    };
    try {
      await handler(billId, job.attrs.data);
      if (attempt > 1) await setRetryAt(undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof AllModelsBusyError) console.error(`[${name}] every model failed:`, err.attempts);
      console.error(`[${name}] bill ${billId} attempt ${attempt} failed: ${message}`);
      const busy = err instanceof AllModelsBusyError;
      const delays = busy ? BUSY_RETRY_DELAYS_MS : RETRY_DELAYS_MS.slice(0, MAX_ATTEMPTS - 1);
      if (!isPermanent(err) && attempt <= delays.length) {
        const at = new Date(Date.now() + delays[attempt - 1]);
        await getAgenda().schedule<BillJobData>(at, name, { ...job.attrs.data, attempt: attempt + 1 });
        if (busy) await setRetryAt(at);
        return;
      }
      await setRetryAt(undefined);
      if (name === JOBS.extractEob) {
        // A failed insurance statement shouldn't fail the bill itself.
        await Bill.updateOne(
          { _id: billId, 'eobs.id': eobId },
          { $set: { 'eobs.$.status': 'failed', 'eobs.$.error': `We couldn't read this statement: ${message}` } },
        );
      } else {
        // The busy message already reads as a full sentence for the patient.
        const error = err instanceof AllModelsBusyError ? message : `We couldn't process this bill: ${message}`;
        await Bill.updateOne({ _id: billId }, { status: 'failed', error });
      }
    }
  };
}

/** Matches a version counter, treating a missing field (bills saved before it existed) as 0. */
const atVersion = (field: 'inputsVersion' | 'findingsVersion', v: number | null | undefined) =>
  v ? { [field]: v } : { [field]: { $in: [0, null] } };

/** A newer analysis is needed whenever the audit's inputs change after the patient's review. */
async function reanalyzeIfReviewed(billId: string) {
  const bill = await Bill.findById(billId).select('status').lean();
  if (bill && (bill.status === 'complete' || bill.status === 'analyzing')) await enqueue(JOBS.analyze, billId);
}

export function toBillForAudit(bill: InstanceType<typeof Bill>): BillForAudit {
  return {
    billType: bill.billType ?? 'uncertain',
    statedTotal: bill.statedTotal ?? undefined,
    admissionDate: bill.admissionDate ?? undefined,
    dischargeDate: bill.dischargeDate ?? undefined,
    lineItems: bill.lineItems.map((li) => ({
      id: li.id,
      code: li.code,
      description: li.description,
      revenueCode: li.revenueCode ?? undefined,
      modifiers: li.modifiers,
      units: li.units,
      unitPrice: li.unitPrice ?? undefined,
      charge: li.charge,
      dateOfService: li.dateOfService,
      placeOfService: li.placeOfService ?? undefined,
      notReceived: li.notReceived,
    })),
  };
}

export async function extractBill(billId: string, llm: LlmProvider) {
  const bill = await Bill.findById(billId);
  if (!bill) throw new PermanentError('Bill not found');
  const started = Date.now();
  bill.status = 'extracting';
  bill.error = undefined;
  await bill.save();

  const pdf = await downloadFile(bill.fileKey);
  const pageTexts = await readPdfText(pdf);
  const { data, model } = await llm.extractBill(pdf);
  const parsed = ExtractionSchema.safeParse(data);
  if (!parsed.success) throw new Error('The extraction response did not match the expected format');
  const extraction = parsed.data;
  if (extraction.lineItems.length === 0) throw new PermanentError('No line items were found. Is this an itemized bill?');

  const descriptions = await loadCmsDescriptions([...new Set(extraction.lineItems.map((i) => i.code))]);
  bill.set({
    providerName: extraction.providerName,
    accountNumber: extraction.accountNumber,
    typeOfBill: extraction.typeOfBill,
    admissionDate: extraction.admissionDate,
    dischargeDate: extraction.dischargeDate,
    statedTotal: extraction.statedTotal,
    amountDue: extraction.amountDue,
    totalsReconcile: totalsReconcile(extraction.lineItems.map((i) => i.charge), extraction.statedTotal),
    lineItems: extraction.lineItems.map((item, i) => {
      const v = verifyItem(item, pageTexts, descriptions.get(item.code));
      const { sourceText: _ignored, ...fields } = item;
      return { ...fields, id: `li-${i + 1}`, extractionStatus: v.extractionStatus, verification: v.verification, reviewReasons: v.reasons, source: v.source };
    }),
  });
  const suggestion = classifyBill({
    revenueCodes: extraction.lineItems.flatMap((i) => (i.revenueCode ? [i.revenueCode] : [])),
    typeOfBill: extraction.typeOfBill,
    admissionDate: extraction.admissionDate,
    dischargeDate: extraction.dischargeDate,
  });
  bill.suggestedBillType = suggestion.billType;
  bill.classificationReasons = suggestion.reasons;
  bill.status = 'awaiting_review';
  bill.set('timings.extractionMs', Date.now() - started);
  bill.set('models.extraction', model);
  await bill.save();
}

function toEobLine(l: InstanceType<typeof Bill>['eobs'][number]['lines'][number]): EobLine {
  return {
    id: l.id,
    eobId: l.eobId,
    dateOfService: l.dateOfService,
    code: l.code ?? undefined,
    description: l.description,
    billed: l.billed,
    allowed: l.allowed ?? undefined,
    planPaid: l.planPaid ?? undefined,
    patientResponsibility: l.patientResponsibility,
  };
}

/** Reads an insurance statement, checks each line against the PDF's text, then re-runs the audit. */
export async function extractEob(billId: string, eobId: string, llm: LlmProvider) {
  const bill = await Bill.findById(billId);
  const eob = bill?.eobs.find((e) => e.id === eobId);
  if (!bill || !eob) throw new PermanentError('Statement not found');
  // Statements are updated by id with the positional operator, never by array index, so removing
  // another statement while this one is being read can't shift the write onto the wrong one.
  const thisEob = { _id: billId, 'eobs.id': eobId };
  await Bill.updateOne(thisEob, { $set: { 'eobs.$.status': 'extracting' }, $unset: { 'eobs.$.error': '' } });

  const pdf = await downloadFile(eob.fileKey);
  const pageTexts = await readPdfText(pdf);
  const { data, model } = await llm.extractEob(pdf);
  const parsed = EobExtractionSchema.safeParse(data);
  if (!parsed.success) throw new Error('The statement response did not match the expected format');
  if (parsed.data.lines.length === 0) throw new PermanentError('No service lines were found. Is this an Explanation of Benefits?');

  const normalized = pageTexts.map((t) => t.toLowerCase().replace(/\s+/g, ' '));
  const lines = parsed.data.lines.map(({ sourceText, ...line }, i) => ({
    ...line,
    id: `${eobId}-${i + 1}`,
    eobId,
    // Same independent check as bills: the line the model read must exist in the PDF itself.
    foundInDocument: normalized.some((page) => page.includes(sourceText.toLowerCase().replace(/\s+/g, ' ').trim())),
  }));
  const saved = await Bill.updateOne(thisEob, {
    $set: {
      'eobs.$.lines': lines,
      'eobs.$.status': 'ready',
      'eobs.$.model': model,
      ...(parsed.data.payer && { 'eobs.$.payer': parsed.data.payer }),
      ...(parsed.data.claimNumber && { 'eobs.$.claimNumber': parsed.data.claimNumber }),
    },
    $inc: { inputsVersion: 1 },
  });
  if (saved.matchedCount === 0) return; // the statement was removed while it was being read
  // Results already shown (or being computed)? Re-run the audit so the comparison appears.
  await reanalyzeIfReviewed(billId);
}

export async function analyzeBill(billId: string) {
  const bill = await Bill.findById(billId);
  if (!bill) throw new PermanentError('Bill not found');
  const started = Date.now();
  const inputsVersion = bill.inputsVersion;
  await Bill.updateOne({ _id: billId }, { status: 'analyzing' });

  const audit = toBillForAudit(bill);
  const ref = await loadReferenceData(codesNeeded(audit), ncciVersionFor(audit));
  const result = runAudit(audit, ref, { benchmarkMultiplier: config.benchmarkMultiplier });

  // With insurance statements attached, also compare the bill against what the insurer says is owed.
  const eobs: Eob[] = bill.eobs
    .filter((e) => e.status === 'ready')
    .map((e) => ({ id: e.id, payer: e.payer ?? undefined, claimNumber: e.claimNumber ?? undefined, lines: e.lines.map(toEobLine) }));
  // Lines already disputed in full (a duplicate, say) aren't also reported as missing from
  // insurance or counted toward what's owed.
  const disputed = fullyDisputedLineIds(result.findings);
  const recon = eobs.length ? reconcile(audit.lineItems, eobs, bill.amountDue ?? undefined, disputed) : undefined;
  const findings = [...result.findings, ...(recon?.findings ?? [])];
  // The balance check compares the whole amount due, so it overlaps the line-level findings; it's
  // shown on its own rather than added into the totals.
  const sum = (cat: Finding['category']) =>
    Math.round(findings.filter((f) => f.category === cat && f.checkId !== 'insurance_balance').reduce((s, f) => s + f.amount, 0) * 100) / 100;

  // Saved only if nothing the audit read has changed since it started. Otherwise a newer analysis
  // is already queued, and writing these results would briefly show stale findings, or overwrite
  // newer ones if the jobs finished out of order.
  const saved = await Bill.updateOne(
    { _id: billId, ...atVersion('inputsVersion', inputsVersion) },
    {
      $set: {
        findings,
        checksRun: recon ? [...result.checksRun, 'insurance'] : result.checksRun,
        checksSkipped: result.checksSkipped,
        totals: {
          billed: result.totals.billed,
          billingErrors: sum('billing_error'),
          pricingConcerns: sum('pricing_concern'),
          insuranceIssues: sum('insurance_issue'),
        },
        benchmarkMultiplier: config.benchmarkMultiplier,
        status: 'complete',
        'timings.analysisMs': Date.now() - started,
        ...(recon && {
          reconciliation: {
            matches: recon.matches,
            unmatchedBillLineIds: recon.unmatchedBillLineIds,
            unmatchedEobLineIds: recon.unmatchedEobLineIds,
            patientResponsibility: recon.patientResponsibility,
            maxExpectedDue: recon.maxExpectedDue,
          },
        }),
      },
      ...(!recon && { $unset: { reconciliation: '' } }),
      $inc: { findingsVersion: 1 },
    },
  );
  if (saved.matchedCount === 0) {
    console.log(`[analyze-bill] bill ${billId}: inputs changed during the audit; leaving it to the newer analysis`);
  }
}

export function registerProcessors(llm: LlmProvider) {
  const agenda = getAgenda();
  // Concurrency caps on the Gemini-backed jobs keep requests within the API's rate limits.
  agenda.define<BillJobData>(JOBS.extract, { concurrency: 2 }, withRetries(JOBS.extract, (id) => extractBill(id, llm)));
  agenda.define<BillJobData>(JOBS.extractEob, { concurrency: 2 }, withRetries(JOBS.extractEob, (id, data) => extractEob(id, data.eobId!, llm)));
  agenda.define<BillJobData>(JOBS.analyze, { concurrency: 5 }, withRetries(JOBS.analyze, (id) => analyzeBill(id)));
}
