/**
 * Reference-data lookup strategies, compared on the same bills and the same database:
 *  - batched: the app's loadReferenceData, one indexed $in query per collection, run concurrently
 *  - perLine: the naive alternative, three indexed queries per line item, one after another
 *  - unindexed: the batched queries forced to scan every document ({ $natural: 1 } hint)
 */
import type { BillForAudit, NcciVersion, ReferenceData } from '../domain/types';
import { codesNeeded } from '../rules/engine';
import { loadReferenceData } from '../services/referenceData';
import { FeeSchedule } from '../models/FeeSchedule';
import { MueLimitModel, NcciEditModel } from '../models/CodingRules';

const VERSION: NcciVersion = 'practitioner';

export async function batched(bill: BillForAudit): Promise<ReferenceData> {
  return loadReferenceData(codesNeeded(bill), VERSION);
}

/** Three queries per line, awaited in turn, the way a per-item loop is usually written. */
export async function perLine(bill: BillForAudit): Promise<{ rates: unknown[]; ncciEdits: unknown[]; mueLimits: unknown[]; queries: number }> {
  const codes = codesNeeded(bill);
  const rates: unknown[] = [];
  const ncciEdits: unknown[] = [];
  const mueLimits: unknown[] = [];
  let queries = 0;
  for (const line of bill.lineItems) {
    rates.push(...(await FeeSchedule.find({ code: line.code }).lean()));
    ncciEdits.push(...(await NcciEditModel.find({ version: VERSION, column1: line.code, column2: { $in: codes } }).lean()));
    const mue = await MueLimitModel.findOne({ version: VERSION, code: line.code }).lean();
    if (mue) mueLimits.push(mue);
    queries += 3;
  }
  return { rates, ncciEdits, mueLimits, queries };
}

const NATURAL = { $natural: 1 } as const;

export async function unindexed(bill: BillForAudit): Promise<void> {
  const codes = codesNeeded(bill);
  await Promise.all([
    FeeSchedule.find({ code: { $in: codes } }).hint(NATURAL).lean(),
    NcciEditModel.find({ version: VERSION, column1: { $in: codes }, column2: { $in: codes } }).hint(NATURAL).lean(),
    MueLimitModel.find({ version: VERSION, code: { $in: codes } }).hint(NATURAL).lean(),
  ]);
}

export interface ExplainTotals {
  docsExamined: number;
  keysExamined: number;
  returned: number;
  planStages: string[];
}

/** Sums MongoDB's own executionStats over the three batched queries. */
export async function explainBatched(bill: BillForAudit, forceScan: boolean): Promise<ExplainTotals | undefined> {
  const codes = codesNeeded(bill);
  const queries = [
    FeeSchedule.find({ code: { $in: codes } }),
    NcciEditModel.find({ version: VERSION, column1: { $in: codes }, column2: { $in: codes } }),
    MueLimitModel.find({ version: VERSION, code: { $in: codes } }),
  ];
  const totals: ExplainTotals = { docsExamined: 0, keysExamined: 0, returned: 0, planStages: [] };
  try {
    for (const q of queries) {
      const plan = (await (forceScan ? q.hint(NATURAL) : q).explain('executionStats')) as unknown as Record<string, any>;
      const stats = plan.executionStats ?? (Array.isArray(plan) ? plan[0]?.executionStats : undefined);
      if (!stats) return undefined;
      totals.docsExamined += stats.totalDocsExamined ?? 0;
      totals.keysExamined += stats.totalKeysExamined ?? 0;
      totals.returned += stats.nReturned ?? 0;
      totals.planStages.push(topStage(plan.queryPlanner?.winningPlan));
    }
    return totals;
  } catch {
    return undefined; // explain isn't available (some MongoDB-compatible servers)
  }
}

/** The plan's interesting stage: IXSCAN, COLLSCAN, ... */
function topStage(plan: any): string {
  let node = plan;
  while (node) {
    if (node.stage === 'IXSCAN' || node.stage === 'COLLSCAN') return node.stage;
    node = node.inputStage ?? node.inputStages?.[0] ?? node.queryPlan;
  }
  return plan?.stage ?? 'unknown';
}

/** Both strategies must return the same rows, or the timing comparison means nothing. */
export async function sameResults(bill: BillForAudit): Promise<boolean> {
  const a = await batched(bill);
  const b = await perLine(bill);
  const ids = (rows: unknown[]) => new Set(rows.map((r) => String((r as { _id: unknown })._id)));
  const eq = (x: Set<string>, y: Set<string>) => x.size === y.size && [...x].every((v) => y.has(v));
  return eq(ids(a.rates), ids(b.rates)) && eq(ids(a.ncciEdits), ids(b.ncciEdits)) && eq(ids(a.mueLimits), ids(b.mueLimits));
}
