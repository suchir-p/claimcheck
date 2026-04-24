/** Small helpers for timing and summarizing benchmark runs. */
import { performance } from 'node:perf_hooks';

export interface Summary {
  trials: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
}

/** Nearest-rank percentile of already-sorted values. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function summarize(samples: number[]): Summary {
  const s = [...samples].sort((a, b) => a - b);
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return { trials: s.length, medianMs: r(percentile(s, 50)), p95Ms: r(percentile(s, 95)), minMs: r(s[0]), maxMs: r(s[s.length - 1]) };
}

/** Runs fn `warmup` times untimed, then `trials` times timed. `pick` varies the input per run. */
export async function time<T>(trials: number, warmup: number, inputs: T[], fn: (input: T) => Promise<unknown> | unknown): Promise<Summary> {
  for (let i = 0; i < warmup; i++) await fn(inputs[i % inputs.length]);
  const samples: number[] = [];
  for (let i = 0; i < trials; i++) {
    const input = inputs[i % inputs.length];
    const start = performance.now();
    await fn(input);
    samples.push(performance.now() - start);
  }
  return summarize(samples);
}

/** Deterministic pseudo-random numbers (mulberry32), so every run builds the same bills. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (max: number) => Math.floor(next() * max),
    pick: <T>(items: T[]) => items[Math.floor(next() * items.length)],
  };
}
