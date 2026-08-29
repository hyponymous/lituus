/**
 * The frozen sampling rule, shared by the tool that draws the sample and the
 * tool that reads the results back.
 *
 * It lives in its own file so the two cannot drift: a stratum boundary that
 * moved between drawing and analysis would silently corrupt every weighted
 * estimate, and nothing downstream would look wrong.
 *
 * These thresholds were fixed before any reference output was inspected.
 * Choosing them afterwards would be choosing the answer.
 */

/** Point loss at which the played move is treated as a candidate blunder. */
export const BAD_PLAYED = 3;
/** `topPolicyLoss` at which the position is treated as a trap for intuition. */
export const HIGH_TRAP = 1;

export type Stratum = 'A' | 'B' | 'C';

export const STRATA: readonly Stratum[] = ['A', 'B', 'C'];

export const STRATUM_LABEL: Readonly<Record<Stratum, string>> = {
  A: 'played move bad    ',
  B: 'natural move a trap',
  C: 'rest               ',
};

/** One position as the screening run saw it. */
export interface Screened {
  readonly game: string;
  readonly turn: number;
  readonly pointLoss: number | null;
  readonly topPolicyLoss: number;
}

/**
 * A: the screen thinks the played move was bad — candidate blunders, and the
 *    only place the detector's precision can be measured.
 * B: the screen thinks the natural move is a trap but the player avoided it —
 *    the bucket that was too small to say much about.
 * C: everything else. Kept at a nonzero rate because
 *    P(reference says blunder | screen said fine) lives entirely here.
 */
export function stratumOf(row: Screened): Stratum {
  if (row.pointLoss !== null && row.pointLoss >= BAD_PLAYED) return 'A';
  if (row.topPolicyLoss >= HIGH_TRAP) return 'B';
  return 'C';
}

export function key(row: { game: string; turn: number }): string {
  return `${row.game}:${row.turn}`;
}

/** JSONL in, one parsed row per line. */
export function readJsonl<T>(path: string, read: (text: string) => string): T[] {
  return read(path).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
}
