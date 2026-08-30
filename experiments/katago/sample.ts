/**
 * Choose which positions get the expensive reference run.
 *
 *   node experiments/katago/sample.ts \
 *     --screen experiments/out/6k-3k-screen.jsonl \
 *     --target 800 --out experiments/out/6k-3k-sample.jsonl
 *
 * The reference costs ~3.0s a position and the screen ~0.12s, so screening
 * everything and referencing a stratified sample buys far more of the
 * positions that matter for the same time. See docs/design-rank-survey.md §4.
 *
 * Strata are assigned from the screen alone — never from the reference, which
 * has not run yet — and every emitted position carries the weight that undoes
 * the sampling. Analysis that ignores those weights is simply wrong.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  STRATA, STRATUM_LABEL, stratumOf, type Sampled, type Screened, type Stratum,
} from './strata.ts';

function parseArgs(argv: readonly string[]): {
  screen: string; target: number; out: string; seed: number;
} {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) flags.set(argv[i].slice(2), argv[i + 1]);
  const screen: string | undefined = flags.get('screen');
  const out: string | undefined = flags.get('out');
  if (!screen || !out) {
    throw new Error('usage: sample.ts --screen <screen.jsonl> --out <file> [--target n] [--seed n]');
  }
  return {
    screen, out,
    target: Number(flags.get('target') ?? 800),
    seed: Number(flags.get('seed') ?? 1),
  };
}

/** Deterministic, so the sample can be reproduced from its seed. */
function makeRandom(seed: number): () => number {
  let s: number = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const { screen, target, out, seed } = parseArgs(process.argv.slice(2));

const rows: Screened[] = readFileSync(screen, 'utf8')
  .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Screened);

const strata = new Map<Stratum, Screened[]>(STRATA.map((s) => [s, []]));
for (const row of rows) strata.get(stratumOf(row))?.push(row);

/**
 * How many positions each stratum gets. A and B are capped rather than taken
 * whole: at 11k screened positions a band would otherwise hand the reference
 * ~1500 positions, and precision beyond a few hundred in a stratum buys
 * almost nothing. C takes the remainder, and never less than its floor.
 */
const ALLOCATION: Readonly<Record<Stratum, number>> = {
  A: Math.round(target * 0.3),
  B: Math.round(target * 0.3),
  C: Math.round(target * 0.4),
};

/** Deterministic, so the sample can be reproduced from its seed. */
const random: () => number = makeRandom(seed);

function shuffle(rows: readonly Screened[]): Screened[] {
  return [...rows]
    .map((row) => ({ row, key: random() }))
    .sort((a, b) => a.key - b.key)
    .map((entry) => entry.row);
}

const sampled: Sampled[] = [];
const report: string[] = [];
let spare = 0;
for (const name of STRATA) {
  const available: readonly Screened[] = strata.get(name) ?? [];
  // A stratum smaller than its allocation hands the surplus to the next one,
  // which is how C absorbs the slack in a band with few blunders.
  const take: number = Math.min(available.length, ALLOCATION[name] + spare);
  spare += ALLOCATION[name] - take;
  // Every position stands for the ones not drawn alongside it.
  const weight: number = take === 0 ? 0 : available.length / take;
  for (const row of shuffle(available).slice(0, take)) {
    sampled.push({ ...row, stratum: name, weight });
  }
  report.push(
    `  ${name} ${STRATUM_LABEL[name]} ${String(available.length).padStart(6)}` +
    ` -> ${String(take).padStart(4)} (weight ${weight.toFixed(1)})`,
  );
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, sampled.map((r) => JSON.stringify(r)).join('\n') + '\n');

console.error(
  `${rows.length} screened -> ${sampled.length} sampled\n` +
  report.join('\n') +
  `\n  reference cost ~${(sampled.length * 3 / 60).toFixed(0)} min at 3.0s a position`,
);
