/**
 * Synthetic physician bills built from real codes in the imported CMS data, so lookups hit
 * the same indexes and return the same kinds of rows a real bill would.
 */
import type { BillForAudit, LineItem } from '../domain/types';
import { FeeSchedule } from '../models/FeeSchedule';
import { NcciEditModel } from '../models/CodingRules';
import { rng } from './stats';

export interface CodePool {
  /** PFS codes with a payable rate, and their CMS short descriptions. */
  pfs: { code: string; description: string; rate: number }[];
  /** Real practitioner NCCI pairs, so some bills contain codes that are bundled together. */
  pairs: [string, string][];
}

export async function loadCodePool(): Promise<CodePool> {
  const rows = await FeeSchedule.find({ schedule: 'PFS', modifier: null, nonFacilityRate: { $gt: 0 } })
    .select('code description nonFacilityRate')
    .sort({ code: 1 })
    .lean();
  const pfs = rows.map((r) => ({ code: r.code, description: r.description ?? '', rate: r.nonFacilityRate ?? 0 }));
  const known = new Set(pfs.map((p) => p.code));
  if (pfs.length < 100) throw new Error('The fee schedule looks empty. Import the CMS data first (see README).');
  // Real bundled pairs among priced codes: look up edits for a fixed sample of PFS codes (indexed).
  const r = rng(7);
  const sample = [...new Set(Array.from({ length: 1500 }, () => r.pick(pfs).code))];
  const edits = await NcciEditModel.find({ version: 'practitioner', column1: { $in: sample } }).select('column1 column2').limit(20_000).lean();
  let pairs = edits.filter((e) => known.has(e.column2)).map((e) => [e.column1, e.column2] as [string, string]);
  if (pairs.length < 50) {
    const more = await NcciEditModel.find({ version: 'practitioner' }).select('column1 column2').limit(50_000).lean();
    pairs = [...pairs, ...more.filter((e) => known.has(e.column1) && known.has(e.column2)).map((e) => [e.column1, e.column2] as [string, string])];
  }
  if (pairs.length === 0) console.warn('No NCCI practitioner edits match the fee schedule, so the bills will have no bundled pairs. Import the coding rules for realistic results.');
  return { pfs, pairs };
}

const DAYS = ['2026-09-14', '2026-09-15', '2026-09-16'];

/** A bill of `size` lines: about a third from bundled NCCI pairs, the rest random PFS codes. */
export function makeBill(pool: CodePool, size: number, seed: number): BillForAudit {
  const r = rng(seed);
  const byCode = new Map(pool.pfs.map((p) => [p.code, p]));
  const lines: LineItem[] = [];
  const add = (code: string, date: string) => {
    const p = byCode.get(code)!;
    const units = r.next() < 0.1 ? 2 + r.int(3) : 1;
    const charge = Math.round(p.rate * (1.5 + r.next() * 4) * units * 100) / 100;
    lines.push({
      id: `li-${lines.length + 1}`, code, description: p.description, modifiers: [], units, charge,
      dateOfService: date, placeOfService: '11',
    });
  };
  while (lines.length < size) {
    const date = r.pick(DAYS);
    if (pool.pairs.length && r.next() < 0.33 && lines.length + 2 <= size) {
      const [a, b] = r.pick(pool.pairs);
      add(a, date);
      add(b, date);
    } else add(r.pick(pool.pfs).code, date);
  }
  return { billType: 'physician', lineItems: lines };
}
