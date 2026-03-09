import type { AuditResult, BillForAudit, CheckId, Finding, NcciVersion, ReferenceData, SkippedCheck } from '../domain/types';
import { checkDuplicates } from './checks/duplicates';
import { checkMath } from './checks/math';
import { checkNotReceived } from './checks/notReceived';
import { checkOutsideStay } from './checks/outsideStay';
import { checkPricing } from './checks/pricing';
import { checkUnbundling } from './checks/unbundling';
import { checkUnitLimits } from './checks/unitLimits';
import { round2 } from './util';

export const ALL_CHECKS: CheckId[] = ['duplicates', 'math', 'unbundling', 'unit_limits', 'pricing', 'not_received', 'outside_stay'];

const BUNDLED_STAY_REASON =
  'Hospital stays are usually paid as one bundled amount, not item by item, so this line-by-line check would be misleading.';

/** Which checks are valid for each bill type, and why the others are skipped. */
export function planChecks(bill: BillForAudit): { run: CheckId[]; skipped: SkippedCheck[] } {
  const skipped: SkippedCheck[] = [];
  const run: CheckId[] = ['duplicates', 'math'];
  const hospitalStay = bill.billType === 'inpatient' || bill.billType === 'uncertain';

  for (const id of ['unbundling', 'unit_limits', 'pricing'] as const) {
    if (hospitalStay) skipped.push({ checkId: id, reason: BUNDLED_STAY_REASON });
    else run.push(id);
  }
  run.push('not_received');

  if (!hospitalStay) {
    skipped.push({ checkId: 'outside_stay', reason: 'Only applies to hospital stays with admission and discharge dates.' });
  } else if (!bill.admissionDate || !bill.dischargeDate) {
    skipped.push({ checkId: 'outside_stay', reason: 'The bill does not list both an admission and a discharge date.' });
  } else {
    run.push('outside_stay');
  }
  return { run, skipped };
}

export function ncciVersionFor(bill: BillForAudit): NcciVersion {
  return bill.billType === 'physician' ? 'practitioner' : 'hospital';
}

/**
 * Runs every check valid for the bill's type. Pure: all reference data is passed in,
 * already fetched in batch, so the engine does no I/O.
 */
export function runAudit(bill: BillForAudit, ref: ReferenceData, opts: { benchmarkMultiplier: number }): AuditResult {
  const { run, skipped } = planChecks(bill);
  const version = ncciVersionFor(bill);
  const runs = (id: CheckId) => run.includes(id);
  const byCheck = new Map<CheckId, Finding[]>();

  // A line's charge can be disputed in full only once. Checks that dispute whole lines run in
  // order of certainty, and each later check sees only the lines still undisputed: a service the
  // patient never received isn't also a duplicate, and the repeated copy of a duplicate isn't also
  // unbundled. Partial checks (unit limits, pricing) then run on what's left.
  const disputed = new Set<string>();
  const remaining = (): BillForAudit => ({ ...bill, lineItems: bill.lineItems.filter((l) => !disputed.has(l.id)) });
  const record = (id: CheckId, findings: Finding[]) => {
    byCheck.set(id, findings);
    fullyDisputedLineIds(findings).forEach((lineId) => disputed.add(lineId));
  };

  if (runs('not_received')) record('not_received', checkNotReceived(bill));
  if (runs('outside_stay')) record('outside_stay', checkOutsideStay(remaining()));
  if (runs('duplicates')) record('duplicates', checkDuplicates(remaining()));
  if (runs('unbundling')) record('unbundling', checkUnbundling(remaining(), ref.ncciEdits, version));

  const rest = remaining();
  if (runs('unit_limits')) byCheck.set('unit_limits', checkUnitLimits(rest, ref.mueLimits, version));
  if (runs('pricing')) byCheck.set('pricing', checkPricing(rest, ref.rates, opts.benchmarkMultiplier).findings);
  // The stated-total comparison needs every line; per-line math on a disputed line is moot.
  if (runs('math')) byCheck.set('math', checkMath(bill).filter((f) => !f.lineItemIds.some((id) => disputed.has(id))));

  const findings = run.flatMap((id) => byCheck.get(id) ?? []);
  const sum = (cat: Finding['category']) => round2(findings.filter((f) => f.category === cat).reduce((s, f) => s + f.amount, 0));
  return {
    findings,
    checksRun: run,
    checksSkipped: skipped,
    totals: {
      billed: round2(bill.lineItems.reduce((s, i) => s + i.charge, 0)),
      billingErrors: sum('billing_error'),
      pricingConcerns: sum('pricing_concern'),
    },
  };
}

/**
 * Lines whose entire charge is already disputed as a billing error: the repeated copies of a
 * duplicate, a code billed separately that should be bundled, a service not received, or a
 * charge outside the stay. Later comparisons skip these so the same dollars aren't counted twice.
 */
export function fullyDisputedLineIds(findings: Finding[]): Set<string> {
  const ids = new Set<string>();
  for (const f of findings) {
    if (f.checkId === 'duplicates' || f.checkId === 'unbundling') f.lineItemIds.slice(1).forEach((id) => ids.add(id));
    if ((f.checkId === 'not_received' || f.checkId === 'outside_stay') && f.category === 'billing_error') f.lineItemIds.forEach((id) => ids.add(id));
  }
  return ids;
}

/** Codes the engine will need reference data for, so callers can batch-fetch it in one query per collection. */
export function codesNeeded(bill: BillForAudit): string[] {
  return [...new Set(bill.lineItems.map((i) => i.code))];
}
