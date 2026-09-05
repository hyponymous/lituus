/**
 * How far apart two sets of numbers are, in the one way this project compares
 * them.
 *
 * Every cross-device check reports this figure: the canary against its baseline
 * and against a known-good machine, the readback against what was uploaded, and
 * each operation against the same device's CPU. They were three copies of the
 * same eight lines, which is three chances for the tolerances quoted beside
 * them to stop meaning the same thing.
 *
 * Relative to the expected magnitude, plus one. Purely relative would make a
 * difference of 0.001 against an expected 0.0001 look catastrophic; purely
 * absolute would let a score lead move by tens of points inside a tolerance
 * chosen for a policy logit. The `1 +` is what lets one threshold cover heads
 * that range from 0.07 to 9,373.
 */

export interface Difference {
  /** The largest relative difference found. */
  readonly worst: number;
  /** Where it was, or -1 when the sequences are identical or empty. */
  readonly at: number;
}

export function furthestApart(
  expected: ArrayLike<number>,
  got: ArrayLike<number>,
): Difference {
  let worst = 0;
  let at = -1;
  for (let i = 0; i < expected.length; i++) {
    const off: number = Math.abs(got[i] - expected[i]) / (1 + Math.abs(expected[i]));
    if (off > worst) {
      worst = off;
      at = i;
    }
  }
  return { worst, at };
}
