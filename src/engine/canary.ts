/**
 * A fixed evaluation, re-run periodically, to catch a GPU that has started
 * lying.
 *
 * `isDegenerate` in `model-v8.ts` catches a readback that comes back zeroed or
 * non-finite, which is what a *lost* device produces. It cannot catch the other
 * failure, and the other failure is worse: a device still returning finite,
 * plausibly-shaped numbers that are wrong. A dogfood session on a phone scored
 * seventy-eight positions that way and exported them as fact — root leads of
 * +57 and +94 points in a game decided by 9.5, with every point loss, blunder
 * count and missed-move run derived from them. Re-running the same positions
 * afterwards disagreed with the export on 52 of 78 verdict bands. Nothing on
 * screen looked wrong at any point.
 *
 * The check is the only kind available without a second opinion to compare
 * against: **the same input must keep giving the same answer**. The baseline is
 * taken at load, when the device is fresh, rather than baked into the build —
 * so the check is tied to no particular network and no particular device, and
 * says exactly one thing, which is the thing worth knowing: this GPU is no
 * longer computing what it computed when it started.
 */

import { GLOBAL_CHANNELS, SPATIAL_CHANNELS } from './features-v7.ts';
import type { Evaluation } from './model-v8.ts';

/**
 * The part of the model a canary uses — `ModelV8` satisfies it. Named rather
 * than taking the class, so this can be checked against a stand-in that returns
 * whatever a broken device would.
 */
export interface CanaryModel {
  evaluate(spatial: Float32Array, global: Float32Array, size: number): Evaluation;
}

/**
 * How far the same input may drift before the engine is called broken.
 *
 * Generous by the standards of what is being measured. The same graph, the same
 * weights and the same input on the same device is a deterministic computation:
 * the expected drift is exactly zero, and this leaves room for a backend that
 * reorders a reduction between calls without leaving room for a wrong answer.
 * The failure it exists to catch moved leads by tens of points.
 */
export const CANARY_TOLERANCE = 1e-3;

export const CANARY_DRIFTED =
  'The GPU stopped giving consistent results, so scoring cannot be trusted.';

/**
 * Fixed inputs, from a fixed generator.
 *
 * Deliberately not a real position. A canary tests the device, not the feature
 * encoding, and the moment this is a position someone has to keep it a *legal*
 * position as the encoding changes. What matters is that every call sees the
 * same bytes and that they exercise the whole network, which any non-degenerate
 * input does.
 */
function fixedInputs(area: number): { spatial: Float32Array; global: Float32Array } {
  const spatial = new Float32Array(area * SPATIAL_CHANNELS);
  const global = new Float32Array(GLOBAL_CHANNELS);
  // A 32-bit xorshift, written out rather than imported: it needs to be the
  // same sequence forever, and nothing else here needs random numbers.
  let state = 0x9e3779b9;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  for (let i = 0; i < spatial.length; i++) spatial[i] = next();
  for (let i = 0; i < global.length; i++) global[i] = next();
  return { spatial, global };
}

/** The heads a drift check compares, copied out of the evaluation's buffer. */
function heads(evaluation: Evaluation): Float32Array {
  const out = new Float32Array(evaluation.value.length + evaluation.scoreValue.length + 2);
  out.set(evaluation.value, 0);
  out.set(evaluation.scoreValue, evaluation.value.length);
  out[out.length - 2] = evaluation.policyPass;
  // One number for the whole policy, so a corrupt policy with an intact value
  // head is still caught without carrying 361 floats around.
  let total = 0;
  for (const logit of evaluation.policy) total += logit;
  out[out.length - 1] = total;
  return out;
}

export class Canary {
  private readonly model: CanaryModel;
  private readonly size: number;
  private readonly spatial: Float32Array;
  private readonly global: Float32Array;
  private readonly baseline: Float32Array;

  /**
   * Evaluating once here is also the shader warmup: the first forward pass
   * compiles every kernel the search will use, and doing it at load means the
   * first prompt of a session is not the one that pays for it.
   */
  constructor(model: CanaryModel, size: number) {
    this.model = model;
    this.size = size;
    const inputs = fixedInputs(size * size);
    this.spatial = inputs.spatial;
    this.global = inputs.global;
    this.baseline = heads(model.evaluate(this.spatial, this.global, size));
  }

  /** How far the fixed evaluation has moved, relative to its own magnitude. */
  drift(): number {
    const now: Float32Array = heads(
      this.model.evaluate(this.spatial, this.global, this.size),
    );
    let worst = 0;
    for (let i = 0; i < this.baseline.length; i++) {
      const expected: number = this.baseline[i];
      const off: number = Math.abs(now[i] - expected) / (1 + Math.abs(expected));
      if (off > worst) worst = off;
    }
    return worst;
  }

  /** Throws when the device is no longer computing what it did at load. */
  verify(): void {
    const drift: number = this.drift();
    if (drift > CANARY_TOLERANCE) {
      throw new Error(`${CANARY_DRIFTED} (drift ${drift.toExponential(2)})`);
    }
  }
}
