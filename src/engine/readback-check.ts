/**
 * Does a number put on the GPU come back as the number that was put there?
 *
 * The question is not rhetorical on this backend. `dataSync()` in
 * tfjs-backend-webgpu is not a readback: it copies the buffer into an
 * `OffscreenCanvas` WebGPU texture and recovers the bytes with `drawImage` plus
 * `getImageData` — one float per pixel, through a 256x256 canvas. It is the
 * path that returned all zeros when a device was lost (`isDegenerate` in
 * `model-v8.ts`), and it is where a phone's wrong-but-stable numbers came from.
 *
 * **At several lengths, deliberately.** The first version of this check ran
 * 4096 floats, found nothing, and could not have found anything: 4096 is
 * sixteen whole rows of that canvas, and a buffer that fills whole rows is
 * fetched in one copy-draw-read cycle. A buffer that does not is fetched in
 * two, and it is the second cycle that a phone loses (`aligned-read.ts`). So
 * the lengths below straddle the boundary — 256 against 257, 512 against 513,
 * and the two the model actually reads, 361 and 369 — and the number of cycles
 * each one needs is printed beside it, because that is the variable.
 *
 * Both ways, too: `dataSync()` against the asynchronous `data()`, which maps
 * the buffer properly and goes nowhere near a canvas. Where the two disagree,
 * the canvas is the one that is wrong.
 */

import type * as TF from '@tensorflow/tfjs-core';
import { canvasPasses, CANVAS_ROW } from './aligned-read.ts';
import { furthestApart, type Difference } from './difference.ts';

/**
 * The lengths asked about, longest last.
 *
 * Every one of them is at least 1000 elements away from being a proof about
 * nothing: an op whose inputs are all CPU-resident and under
 * `WEBGPU_CPU_HANDOFF_SIZE_THRESHOLD` is forwarded to the CPU, and a tensor
 * that never reached the GPU says nothing about reading from it. These are all
 * slices of one buffer that is on the GPU, which keeps even the four-float case
 * honest.
 */
const LENGTHS: readonly number[] = [4, 256, 257, 361, 369, 512, 513, 1000, 4096, 4097];

const LONGEST: number = Math.max(...LENGTHS);

/** How far a read may sit from what was uploaded before it is a finding. */
export const READBACK_TOLERANCE = 1e-6;

/**
 * Values a damaged pipeline cannot pass off as intact.
 *
 * Both signs, both ends of the exponent range, the integers a lossy path would
 * round to, and a ramp fine enough that a rounding to eight bits per channel
 * shows up on almost every entry. Distinct entries throughout, so a tail that
 * repeats the head is recognizable as one.
 */
function probeValues(count: number): Float32Array {
  const out = new Float32Array(count);
  const landmarks: readonly number[] = [
    0, 1, -1, 0.5, -0.5, 1e-8, -1e-8, 1e8, -1e8, 3.4028235e38, 1.1754944e-38, 0.1, -0.1,
  ];
  for (let i = 0; i < count; i++) {
    out[i] = i < landmarks.length ? landmarks[i] : ((i % 2 === 0 ? 1 : -1) * (i + 1)) / count;
  }
  return out;
}

export interface LengthCheck {
  readonly count: number;
  readonly passes: number;
  /** Largest relative difference between what went up and what came back. */
  readonly syncWorst: number;
  /** The same for `data()`, which does not go through the canvas. */
  readonly asyncWorst: number;
  /** Index of the worst synchronous disagreement, or -1 when there is none. */
  readonly syncWorstAt: number;
  readonly expected: number;
  readonly gotSync: number;
  readonly gotAsync: number;
  /**
   * Whether the floats the last cycle should have fetched came back as a repeat
   * of the buffer's first floats — the signature of a cycle that never landed
   * and left the canvas showing what the one before it drew.
   */
  readonly tailRepeatsHead: boolean;
}

export interface ReadbackCheck {
  readonly lengths: readonly LengthCheck[];
  readonly ok: boolean;
}

/**
 * Put known values on the GPU once and read slices of them back both ways.
 *
 * `tf.add` rather than handing the tensor over directly: an array uploaded and
 * never computed on can be handed straight back from the CPU copy, which would
 * answer a question nobody asked. The slices inherit a GPU-resident input, so
 * each of them is a real read of a buffer of exactly that length.
 */
export async function checkReadback(tf: typeof TF): Promise<ReadbackCheck> {
  const expected: Float32Array = probeValues(LONGEST);
  const source: TF.Tensor1D = tf.tensor1d(expected);
  const onGpu: TF.Tensor1D = tf.add(source, tf.scalar(0));

  const lengths: LengthCheck[] = [];
  for (const count of LENGTHS) {
    /*
     * A slice each, because the first read wins. Both `readSync` and `read`
     * end in `convertAndCacheOnCPU`, so asking one tensor both ways hands the
     * second caller whatever the first one got — which quietly made the
     * earlier version of this check compare `dataSync` with itself and report
     * that the two agreed.
     */
    const forSync: TF.Tensor1D = tf.slice(onGpu, [0], [count]);
    const forAsync: TF.Tensor1D = tf.slice(onGpu, [0], [count]);
    const asynchronous = (await forAsync.data()) as Float32Array;
    const sync = forSync.dataSync() as Float32Array;
    forSync.dispose();
    forAsync.dispose();

    const want: Float32Array = expected.subarray(0, count);
    const bad: Difference = furthestApart(want, sync);
    const worstAsync: Difference = furthestApart(want, asynchronous);
    const at: number = bad.at >= 0 ? bad.at : 0;

    // The final cycle fetches whatever is left over after the whole rows.
    const tail: number = count % CANVAS_ROW;
    let repeats: boolean = tail > 0 && bad.at >= 0;
    for (let i = 0; repeats && i < tail; i++) {
      if (sync[count - tail + i] !== want[i]) repeats = false;
    }

    lengths.push({
      count,
      passes: canvasPasses(count),
      syncWorst: bad.worst,
      asyncWorst: worstAsync.worst,
      syncWorstAt: bad.at,
      expected: want[at],
      gotSync: sync[at],
      gotAsync: asynchronous[at],
      tailRepeatsHead: repeats,
    });
  }

  source.dispose();
  onGpu.dispose();

  return {
    lengths,
    ok: lengths.every(
      (one: LengthCheck) =>
        one.syncWorst < READBACK_TOLERANCE && one.asyncWorst < READBACK_TOLERANCE,
    ),
  };
}
