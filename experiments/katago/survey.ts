/**
 * Read one band's survey back: what the reference says about the moves a
 * stratified sample selected, weighted back up to the whole band.
 *
 *   node experiments/katago/survey.ts --band 6k-3k
 *
 * Every figure here is a weighted estimate. Stratum A and B are deliberately
 * oversampled, so an unweighted count from these files would say that a
 * seventh of all amateur moves are blunders. Weights undo that.
 *
 * Confidence intervals use Kish's effective sample size,
 * `n_eff = (sum w)^2 / sum w^2`, which is an approximation: it accounts for
 * the variance that unequal weights add, not for the stratification that
 * removes some. Treat them as slightly conservative.
 */
import { readFileSync, existsSync } from 'node:fs';
import { STRATA, STRATUM_LABEL, key, type Stratum } from './strata.ts';

/** Point loss at which a move is called a blunder, as elsewhere. */
const BLUNDER = 8;
/** Point loss at which a move is worth mentioning to a user at all. */
const COSTLY = 3;
/** `topPolicyLoss` cuts to sweep: does the best threshold move with rank? */
const SWEEP: readonly number[] = [0.5, 1, 2, 3, 5];

interface Sampled {
  readonly game: string;
  readonly turn: number;
  readonly stratum: Stratum;
  readonly weight: number;
  readonly topPolicyLoss: number;
  /** The screen's verdict on the played move. */
  readonly pointLoss: number | null;
}

interface Referenced {
  readonly game: string;
  readonly turn: number;
  readonly pointLoss: number | null;
}

/** A sampled position the reference also produced a number for. */
interface Joined {
  readonly weight: number;
  readonly stratum: Stratum;
  readonly topPolicyLoss: number;
  readonly screenLoss: number | null;
  readonly refLoss: number;
}

function read<T>(path: string): T[] {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

/** Weighted proportion, with a 95% interval from the effective sample size. */
function estimate(rows: readonly Joined[], holds: (r: Joined) => boolean): string {
  let total = 0, hit = 0, squares = 0;
  for (const row of rows) {
    total += row.weight;
    squares += row.weight * row.weight;
    if (holds(row)) hit += row.weight;
  }
  if (total === 0) return '     -        ';
  const p: number = hit / total;
  const nEff: number = (total * total) / squares;
  const margin: number = 1.96 * Math.sqrt(Math.max(p * (1 - p), 0) / nEff);
  return `${(100 * p).toFixed(1).padStart(5)}% ±${(100 * margin).toFixed(1).padStart(4)}`;
}

function countOf(rows: readonly Joined[]): string {
  return String(rows.length).padStart(5);
}

function report(band: string): void {
  const paths = {
    screen: `experiments/out/${band}-screen.jsonl`,
    sample: `experiments/out/${band}-sample.jsonl`,
    ref: `experiments/out/${band}-ref.jsonl`,
  };
  for (const [name, path] of Object.entries(paths)) {
    if (!existsSync(path)) { console.log(`${band}: no ${name} yet (${path})`); return; }
  }

  const sample: Sampled[] = read<Sampled>(paths.sample);
  const reference = new Map<string, Referenced>(
    read<Referenced>(paths.ref).map((r) => [key(r), r]),
  );
  // A search only reports moves it visited, so the reference has no verdict on
  // moves bad enough that it never looked at them — precisely the ones that
  // decide a blunder rate. `backfill.ts` forces those with `allowMoves`.
  const backfillPath = `experiments/out/${band}-backfill.jsonl`;
  let backfilled = 0;
  if (existsSync(backfillPath)) {
    for (const r of read<Referenced>(backfillPath)) {
      if (r.pointLoss === null) continue;
      reference.set(key(r), r);
      backfilled++;
    }
  }

  // The product evaluates the user's guess with `allowMoves`, so it always
  // has a number for it. Measuring the detector against a screen that dropped
  // the moves it never visited would charge it for an artifact the product
  // does not have — and the drop rate runs from 45% of a beginner's moves to
  // 7% of a 7-dan's, so that artifact alone manufactures a rank gradient.
  const screenFixPath = `experiments/out/${band}-screen-backfill.jsonl`;
  const screenFix = new Map<string, number>();
  if (existsSync(screenFixPath)) {
    for (const r of read<Referenced>(screenFixPath)) {
      if (r.pointLoss !== null) screenFix.set(key(r), r.pointLoss);
    }
  }

  const rows: Joined[] = [];
  let missing = 0;
  for (const s of sample) {
    const r: Referenced | undefined = reference.get(key(s));
    if (!r || r.pointLoss === null) { missing++; continue; }
    rows.push({
      weight: s.weight, stratum: s.stratum, topPolicyLoss: s.topPolicyLoss,
      screenLoss: s.pointLoss ?? screenFix.get(key(s)) ?? null,
      refLoss: r.pointLoss,
    });
  }

  const screened: number = read<unknown>(paths.screen).length;
  console.log(`\n${'='.repeat(66)}\n${band}  —  ${screened} screened, ${sample.length} sampled, ` +
    `${rows.length} with a reference verdict` +
    `${backfilled > 0 ? `, ${backfilled} of them forced` : ''}` +
    `${screenFix.size > 0 ? `, ${screenFix.size} screen verdicts forced` : ''}` +
    `${missing > 0 ? ` (${missing} still missing)` : ''}`);

  console.log('\n  sample composition');
  for (const name of STRATA) {
    const inStratum: Joined[] = rows.filter((r) => r.stratum === name);
    const weight: number = inStratum[0]?.weight ?? 0;
    console.log(`    ${name} ${STRATUM_LABEL[name]} n=${countOf(inStratum)}  weight ${weight.toFixed(1).padStart(5)}`);
  }

  console.log('\n  what the band actually does (weighted to the whole band)');
  console.log(`    lost >=${COSTLY}pt                ${estimate(rows, (r) => r.refLoss >= COSTLY)}`);
  console.log(`    blundered (>=${BLUNDER}pt)         ${estimate(rows, (r) => r.refLoss >= BLUNDER)}`);

  console.log('\n  does intuition predict error? (screen signal vs reference verdict)');
  console.log(`    ${'positions'.padEnd(26)} ${'n'.padStart(5)}   ${'lost >=3pt'.padStart(13)}   ${'blundered'.padStart(13)}`);
  const buckets: ReadonlyArray<readonly [string, (r: Joined) => boolean]> = [
    ['all', () => true],
    ['natural move costs >=3pt', (r) => r.topPolicyLoss >= 3],
    ['natural move costs >=1pt', (r) => r.topPolicyLoss >= 1],
    ['natural move costs <1pt', (r) => r.topPolicyLoss < 1],
  ];
  for (const [label, holds] of buckets) {
    const subset: Joined[] = rows.filter(holds);
    console.log(`    ${label.padEnd(26)} ${countOf(subset)}   ${estimate(subset, (r) => r.refLoss >= COSTLY)}   ` +
      `${estimate(subset, (r) => r.refLoss >= BLUNDER)}`);
  }

  console.log('\n  threshold sweep — does the best cut move with rank?');
  console.log(`    ${'cut'.padStart(5)} ${'n'.padStart(6)}   ${'lost >=3pt'.padStart(13)}   ${'share of band'.padStart(13)}`);
  const totalWeight: number = rows.reduce((s, r) => s + r.weight, 0);
  for (const cut of SWEEP) {
    const subset: Joined[] = rows.filter((r) => r.topPolicyLoss >= cut);
    const share: number = subset.reduce((s, r) => s + r.weight, 0) / (totalWeight || 1);
    console.log(`    ${cut.toFixed(1).padStart(5)} ${countOf(subset)}   ${estimate(subset, (r) => r.refLoss >= COSTLY)}   ` +
      `${(100 * share).toFixed(2).padStart(12)}%`);
  }

  console.log('\n  the shipping config as a blunder detector');
  const called: Joined[] = rows.filter((r) => r.screenLoss !== null && r.screenLoss >= BLUNDER);
  const real: Joined[] = rows.filter((r) => r.refLoss >= BLUNDER);
  console.log(`    precision (it says blunder, it is)   ${estimate(called, (r) => r.refLoss >= BLUNDER)}  n=${countOf(called)}`);
  console.log(`    recall    (it is, it says so)        ${estimate(real, (r) => r.screenLoss !== null && r.screenLoss >= BLUNDER)}  n=${countOf(real)}`);
}

const argv: string[] = process.argv.slice(2);
const bands: string[] = argv.filter((a) => !a.startsWith('--'));
for (const band of bands.length > 0 ? bands
  : ['personal', '25k-20k', '15k-10k', '6k-3k', '1d-3d', '4d-6d', '7d+']) {
  report(band);
}
console.log();
