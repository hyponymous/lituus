/**
 * Compare two `analyze.ts` runs: how far off is the cheap configuration's
 * point loss from the reference's?
 *
 * The headline question is not "does the small net play well" but "if lituus
 * showed the user this number, how wrong would it be" — so the report leads
 * with the distribution of the per-move disagreement, and follows with the
 * coarser judgments a user actually acts on (was this a blunder, was the
 * played move best).
 *
 *   node experiments/katago/compare.ts --ref <ref.jsonl> <test.jsonl>...
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/** Point-loss bands, in points. A user reads the band, not the decimal. */
const BANDS: ReadonlyArray<readonly [string, number]> = [
  ['fine', 1],
  ['slack', 3],
  ['costly', 8],
  ['blunder', Infinity],
];

const BLUNDER = 8;

interface Record_ {
  readonly game: string;
  readonly turn: number;
  readonly played: string;
  readonly best: string;
  readonly pointLoss: number | null;
}

function load(path: string): Map<string, Record_> {
  const rows: Record_[] = readFileSync(path, 'utf8')
    .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record_);
  return new Map(rows.map((r) => [`${r.game}:${r.turn}`, r]));
}

function bandOf(loss: number): string {
  return BANDS.find(([, limit]) => loss < limit)?.[0] ?? 'blunder';
}

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2).padStart(7) : '      -';
}

function compare(refPath: string, testPath: string): void {
  const ref: Map<string, Record_> = load(refPath);
  const test: Map<string, Record_> = load(testPath);

  const diffs: number[] = [];
  /**
   * Disagreement grouped by how bad the reference thought the move was.
   * Small networks are reported to be weakest in large capturing races and
   * whole-board fights — the positions where point loss is largest and most
   * worth teaching — so an aggregate that is dominated by quiet moves would
   * hide exactly the failure that matters.
   */
  const byBand = new Map<string, number[]>(BANDS.map(([name]) => [name, []]));
  let paired = 0;
  let refOnly = 0;      // reference had a number, cheap config did not
  let bandAgree = 0;
  let bestAgree = 0;
  let blunderHit = 0;   // reference calls it a blunder, so does the test
  let blunderRef = 0;
  let blunderTest = 0;

  for (const [key, r] of ref) {
    const t: Record_ | undefined = test.get(key);
    if (!t) continue;
    if (r.best === t.best) bestAgree++;
    if (r.pointLoss === null) continue;
    if (t.pointLoss === null) { refOnly++; continue; }

    paired++;
    const error: number = Math.abs(t.pointLoss - r.pointLoss);
    diffs.push(error);
    byBand.get(bandOf(r.pointLoss))?.push(error);
    if (bandOf(r.pointLoss) === bandOf(t.pointLoss)) bandAgree++;
    if (r.pointLoss >= BLUNDER) blunderRef++;
    if (t.pointLoss >= BLUNDER) blunderTest++;
    if (r.pointLoss >= BLUNDER && t.pointLoss >= BLUNDER) blunderHit++;
  }

  diffs.sort((a, b) => a - b);
  for (const rows of byBand.values()) rows.sort((a, b) => a - b);
  const mean: number = diffs.reduce((s, d) => s + d, 0) / (diffs.length || 1);
  const shared: number = Math.min(ref.size, test.size);

  const pct = (n: number, d: number): string =>
    d === 0 ? '    -  ' : `${((100 * n) / d).toFixed(1).padStart(5)}%`;

  console.log(`\n${basename(testPath)}  vs  ${basename(refPath)}`);
  console.log(`  positions paired            ${String(paired).padStart(7)} of ${shared}`);
  console.log(`  no number where ref had one ${pct(refOnly, refOnly + paired)}`);
  console.log(`  |point loss difference|     mean ${fmt(mean)}  median ${fmt(quantile(diffs, 0.5))}`);
  console.log(`                              p90  ${fmt(quantile(diffs, 0.9))}  p99    ${fmt(quantile(diffs, 0.99))}  max ${fmt(diffs.at(-1) ?? NaN)}`);
  console.log(`  same band                   ${pct(bandAgree, paired)}`);
  console.log(`  same best move              ${pct(bestAgree, shared)}`);
  console.log(`  blunders (>=${BLUNDER}pt) found     ${pct(blunderHit, blunderRef)} of ${blunderRef}` +
    `   false alarms ${pct(blunderTest - blunderHit, blunderTest)}`);
  console.log('  error by reference band');
  for (const [name] of BANDS) {
    const rows: number[] = byBand.get(name) ?? [];
    console.log(`    ${name.padEnd(8)} n=${String(rows.length).padStart(5)}` +
      `  median ${fmt(quantile(rows, 0.5))}  p90 ${fmt(quantile(rows, 0.9))}  max ${fmt(rows.at(-1) ?? NaN)}`);
  }
}

const argv: string[] = process.argv.slice(2);
const refIndex: number = argv.indexOf('--ref');
if (refIndex < 0) throw new Error('usage: compare.ts --ref <ref.jsonl> <test.jsonl>...');
const refPath: string = argv[refIndex + 1];
const tests: string[] = argv.filter((_, i) => i !== refIndex && i !== refIndex + 1);
if (tests.length === 0) throw new Error('no test files given');

for (const test of tests) compare(refPath, test);
console.log();
