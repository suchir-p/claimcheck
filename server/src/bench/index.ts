/**
 * Reproducible benchmarks for ClaimCheck's reference-data lookups, audit engine, and extraction
 * check. Needs the CMS data imported (see README). Usage:
 *
 *   npm run bench                      # everything, about 5 minutes
 *   npm run bench -- --skip-unindexed  # leave out the full-collection-scan comparison
 *   npm run bench -- --trials 100 --sizes 10,50,100,500
 *
 * Writes bench-results/<timestamp>.md and .json with the numbers and the test environment.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { config } from '../config';
import { runAudit } from '../rules/engine';
import { FeeSchedule } from '../models/FeeSchedule';
import { MueLimitModel, NcciEditModel } from '../models/CodingRules';
import { loadCodePool, makeBill } from './bills';
import { batched, explainBatched, perLine, sameResults, unindexed } from './lookups';
import { time, type Summary } from './stats';
import { runVerificationBenchmark } from './verification';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const TRIALS = Number(arg('trials', '50'));
const SCAN_TRIALS = Number(arg('scan-trials', '5'));
const SIZES = arg('sizes', '10,50,100,500').split(',').map(Number);
const BILLS_PER_SIZE = 5;
const SEED = Number(arg('seed', '42'));
const log = (s: string) => process.stdout.write(`${s}\n`);

async function main() {
  await mongoose.connect(arg('uri', config.mongoUri));
  const db = mongoose.connection.db!;
  const build = await db.admin().buildInfo().catch(() => ({ version: 'unknown' }));
  const [rates, ncci, mue] = await Promise.all([FeeSchedule.estimatedDocumentCount(), NcciEditModel.estimatedDocumentCount(), MueLimitModel.estimatedDocumentCount()]);
  const dataVersions = await NcciEditModel.distinct('dataVersion');
  const env = {
    date: new Date().toISOString(),
    node: process.version,
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    cpu: `${os.cpus()[0]?.model ?? 'unknown'} x${os.cpus().length}`,
    memoryGb: Math.round(os.totalmem() / 1e9),
    mongodb: build.version,
    mongoUri: arg('uri', config.mongoUri).replace(/\/\/[^@]*@/, '//***@'),
    collections: { feeScheduleRates: rates, ncciEdits: ncci, mueLimits: mue },
    ncciDataVersions: dataVersions,
    settings: { trials: TRIALS, scanTrials: SCAN_TRIALS, sizes: SIZES, billsPerSize: BILLS_PER_SIZE, seed: SEED },
  };
  log(`MongoDB ${env.mongodb}: ${rates} rates, ${ncci} NCCI edits, ${mue} MUE limits`);

  const pool = await loadCodePool();
  log(`Code pool: ${pool.pfs.length} PFS codes, ${pool.pairs.length} NCCI pairs`);

  const lookups: {
    lines: number;
    distinctCodes: number;
    resultsIdentical: boolean;
    batched: Summary & { queries: number };
    perLine: Summary & { queries: number };
    unindexed?: Summary & { queries: number };
    speedupVsPerLine: number;
    speedupVsUnindexed?: number;
    explainIndexed?: Awaited<ReturnType<typeof explainBatched>>;
    explainUnindexed?: Awaited<ReturnType<typeof explainBatched>>;
    auditEngine: Summary;
    findingsPerBill: number;
  }[] = [];

  for (const size of flag('verify-only') ? [] : SIZES) {
    const bills = Array.from({ length: BILLS_PER_SIZE }, (_, i) => makeBill(pool, size, SEED + size * 100 + i));
    const distinct = Math.round(bills.reduce((s, b) => s + new Set(b.lineItems.map((l) => l.code)).size, 0) / bills.length);
    log(`\n${size} lines (${distinct} distinct codes)`);

    const identical = (await Promise.all(bills.map(sameResults))).every(Boolean);
    log(`  batched and per-line return identical rows: ${identical ? 'yes' : 'NO'}`);

    const b = await time(TRIALS, 5, bills, batched);
    log(`  batched:   median ${b.medianMs} ms, p95 ${b.p95Ms} ms (3 queries)`);
    const p = await time(TRIALS, 2, bills, perLine);
    log(`  per-line:  median ${p.medianMs} ms, p95 ${p.p95Ms} ms (${size * 3} queries)`);

    let u: Summary | undefined;
    if (!flag('skip-unindexed')) {
      u = await time(SCAN_TRIALS, 1, bills, unindexed);
      log(`  unindexed: median ${u.medianMs} ms, p95 ${u.p95Ms} ms (3 queries, full scans)`);
    }
    const explainIndexed = await explainBatched(bills[0], false);
    const explainUnindexed = flag('skip-unindexed') ? undefined : await explainBatched(bills[0], true);
    if (explainIndexed) log(`  documents examined: ${explainIndexed.docsExamined} indexed${explainUnindexed ? ` vs ${explainUnindexed.docsExamined} unindexed` : ''} (${explainIndexed.returned} returned)`);

    // The engine itself: pure computation on reference data already in memory.
    const refs = await Promise.all(bills.map(batched));
    const inputs = bills.map((bill, i) => ({ bill, ref: refs[i] }));
    const engine = await time(Math.max(TRIALS, 200), 20, inputs, ({ bill, ref }) => runAudit(bill, ref, { benchmarkMultiplier: config.benchmarkMultiplier }));
    const findings = Math.round(inputs.reduce((s, { bill, ref }) => s + runAudit(bill, ref, { benchmarkMultiplier: 3 }).findings.length, 0) / inputs.length);
    log(`  audit engine: median ${engine.medianMs} ms, p95 ${engine.p95Ms} ms (${findings} findings per bill)`);

    lookups.push({
      lines: size,
      distinctCodes: distinct,
      resultsIdentical: identical,
      batched: { ...b, queries: 3 },
      perLine: { ...p, queries: size * 3 },
      unindexed: u && { ...u, queries: 3 },
      speedupVsPerLine: Math.round((p.medianMs / b.medianMs) * 10) / 10,
      speedupVsUnindexed: u && Math.round((u.medianMs / b.medianMs) * 10) / 10,
      explainIndexed,
      explainUnindexed,
      auditEngine: engine,
      findingsPerBill: findings,
    });
  }

  log('\nExtraction check');
  const verification = await runVerificationBenchmark(pool, { bills: Number(arg('verify-bills', '40')), seed: SEED });
  for (const c of verification.results) log(`  ${`${c.category} (${c.layout})`.padEnd(50)} ${String(c.cases).padStart(5)} cases, ${String(c.flaggedRate).padStart(5)}% flagged`);
  const v = verification;
  log(`  code and line errors flagged: ${v.codeErrorDetection.rate}% of ${v.codeErrorDetection.cases} (single-line rows ${v.codeErrorDetectionByLayout.single_line.rate}%, wrapped rows ${v.codeErrorDetectionByLayout.wrapped.rate}%)`);
  log(`  clean lines flagged (false positives): ${v.falsePositives.rate}% of ${v.falsePositives.cases} (single-line rows ${v.falsePositivesByLayout.single_line.rate}%, wrapped rows ${v.falsePositivesByLayout.wrapped.rate}%)`);

  const results = { environment: env, lookups, verification };
  const dir = path.resolve(__dirname, '../../bench-results');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = env.date.replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(dir, `${stamp}.md`), report(results));
  log(`\nWrote bench-results/${stamp}.md`);
  await mongoose.disconnect();
}

function report(r: { environment: Record<string, unknown>; lookups: any[]; verification: Awaited<ReturnType<typeof runVerificationBenchmark>> }): string {
  const e = r.environment as any;
  const lines = [
    `# ClaimCheck benchmark, ${e.date}`,
    '',
    `Node ${e.node} on ${e.os}, ${e.cpu}, ${e.memoryGb} GB. MongoDB ${e.mongodb} at ${e.mongoUri}.`,
    `Data: ${e.collections.feeScheduleRates} fee-schedule rates, ${e.collections.ncciEdits} NCCI edits (${e.ncciDataVersions.join(', ')}), ${e.collections.mueLimits} MUE limits.`,
    `Settings: ${e.settings.trials} timed trials per strategy (${e.settings.scanTrials} for full scans) after warm-up, ${e.settings.billsPerSize} synthetic physician bills per size, seed ${e.settings.seed}.`,
    '',
    '## Reference-data lookups',
    '',
    'Batched is the app\'s loadReferenceData (one indexed $in query per collection, run concurrently). Per-line runs three indexed queries per line item in sequence. Unindexed runs the batched queries with a { $natural: 1 } hint, forcing full collection scans. Times are wall-clock from the Node process, including network round trips to MongoDB.',
    '',
    '| Lines | Batched median / p95 (ms) | Per-line median / p95 (ms) | Unindexed median / p95 (ms) | Batched vs per-line | Batched vs unindexed | Docs examined (indexed / unindexed) | Same rows |',
    '|---|---|---|---|---|---|---|---|',
    ...r.lookups.map((l) =>
      `| ${l.lines} | ${l.batched.medianMs} / ${l.batched.p95Ms} | ${l.perLine.medianMs} / ${l.perLine.p95Ms} (${l.perLine.queries} queries) | ${l.unindexed ? `${l.unindexed.medianMs} / ${l.unindexed.p95Ms}` : 'skipped'} | ${l.speedupVsPerLine}x | ${l.speedupVsUnindexed ? `${l.speedupVsUnindexed}x` : '-'} | ${l.explainIndexed ? l.explainIndexed.docsExamined : '?'} / ${l.explainUnindexed ? l.explainUnindexed.docsExamined : '-'} | ${l.resultsIdentical ? 'yes' : 'NO'} |`,
    ),
    '',
    '## Audit engine',
    '',
    'All seven checks on reference data already in memory (no I/O).',
    '',
    '| Lines | Median (ms) | p95 (ms) | Findings per bill |',
    '|---|---|---|---|',
    ...r.lookups.map((l) => `| ${l.lines} | ${l.auditEngine.medianMs} | ${l.auditEngine.p95Ms} | ${l.findingsPerBill} |`),
    '',
    '## Extraction check',
    '',
    'Synthetic bills rendered to PDF and read back with the app\'s pdf.js reader; each case is an extracted line item checked by verifyItem. Clean cases should pass; the rest are extraction errors that should be flagged. Bill descriptions are CMS short descriptors, so the description check is easier here than on real bills, whose wording varies.',
    '',
    '| Case | Row layout | Should flag | Cases | Flagged | Caught by PDF text | Caught by CMS code list | Caught by description |',
    '|---|---|---|---|---|---|---|---|',
    ...r.verification.results.map((c) => `| ${c.category} | ${c.layout === 'wrapped' ? 'wrapped description' : 'single line'} | ${c.shouldFlag ? 'yes' : 'no'} | ${c.cases} | ${c.flaggedRate}% | ${c.caughtByPdfCheck} | ${c.caughtByCmsCheck} | ${c.caughtByDescriptionCheck} |`),
    '',
    `Code and line errors flagged: ${r.verification.codeErrorDetection.flagged} of ${r.verification.codeErrorDetection.cases} (${r.verification.codeErrorDetection.rate}%; single-line rows ${r.verification.codeErrorDetectionByLayout.single_line.rate}%, wrapped rows ${r.verification.codeErrorDetectionByLayout.wrapped.rate}%).`,
    `Clean lines flagged (false positives): ${r.verification.falsePositives.flagged} of ${r.verification.falsePositives.cases} (${r.verification.falsePositives.rate}%; single-line rows ${r.verification.falsePositivesByLayout.single_line.rate}%, wrapped rows ${r.verification.falsePositivesByLayout.wrapped.rate}%).`,
    'Wrong charges are not checked line by line; they are caught at the bill level when the line items no longer add up to the printed total.',
    '',
  ];
  return lines.join('\n');
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
