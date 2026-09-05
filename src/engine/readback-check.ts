/**
 * Does a number put on the GPU come back as the number that was put there?
 *
 * The question is not rhetorical on this backend. `dataSync()` in
 * tfjs-backend-webgpu is not a readback: it copies the buffer into two
 * OffscreenCanvas WebGPU contexts and recovers the bytes with `drawImage` plus
 * `getImageData` — a float array smuggled through an image. It is the path that
 * returned all zeros when a device was lost (`isDegenerate` in `model-v8.ts`),
 * and it is the leading suspect for a phone that computes the same network
 * deterministically and differently from a laptop: an image pipeline that
 * colour-manages or premultiplies would damage the bytes in a way that is
 * perfectly stable and completely wrong.
 *
 * So this asks it directly, with values chosen to make damage visible, and
 * both ways — `dataSync()` against the asynchronous `data()`, which does not
 * go through a canvas at all. If the two disagree on a device, the canvas path
 * is the answer and `readSync` cannot be trusted on it.
 */

import type * as TF from '@tensorflow/tfjs-core';

/**
 * Wide enough to stay on the GPU. The backend forwards an op to the CPU when
 * every input is CPU-resident and under `WEBGPU_CPU_HANDOFF_SIZE_THRESHOLD`
 * (1000 elements), and a tensor that never reached the GPU proves nothing about
 * reading from it — the trap the readback benchmark documents.
 */
const SIZE = 4096;

/**
 * Values a damaged pipeline cannot pass off as intact.
 *
 * Both signs, both ends of the exponent range, the integers a lossy path would
 * round to, and a ramp fine enough that a rounding to eight bits per channel
 * shows up on almost every entry.
 */
export function probeValues(count: number = SIZE): Float32Array {
  const out = new Float32Array(count);
  const landmarks: readonly number[] = [
    0, 1, -1, 0.5, -0.5, 1e-8, -1e-8, 1e8, -1e8, 3.4028235e38, 1.1754944e-38, 0.1, -0.1,
  ];
  for (let i = 0; i < count; i++) {
    out[i] = i < landmarks.length ? landmarks[i] : ((i % 2 === 0 ? 1 : -1) * (i + 1)) / count;
  }
  return out;
}

export interface ReadbackCheck {
  /** Largest absolute difference between what went up and what `dataSync` gave. */
  readonly syncWorst: number;
  /** The same for the asynchronous `data()`, which avoids the canvas. */
  readonly asyncWorst: number;
  /** Largest absolute difference between the two ways of reading. */
  readonly betweenWorst: number;
  /** Index of the worst sync disagreement, or -1 when there is none. */
  readonly syncWorstAt: number;
  /** What that entry should have been, and what came back. */
  readonly expected: number;
  readonly gotSync: number;
  readonly gotAsync: number;
  readonly count: number;
}

function worstDiff(a: Float32Array, b: ArrayLike<number>): {
  worst: number;
  at: number;
} {
  let worst = 0;
  let at = -1;
  for (let i = 0; i < a.length; i++) {
    // Relative to the magnitude, so the 1e38 landmark does not drown the ramp.
    const diff: number = Math.abs(a[i] - b[i]) / (1 + Math.abs(a[i]));
    if (diff > worst) {
      worst = diff;
      at = i;
    }
  }
  return { worst, at };
}

/**
 * Put known values on the GPU and read them back both ways.
 *
 * `tf.add` rather than handing the tensor over directly: an array uploaded and
 * never computed on can be handed straight back from the CPU copy, which would
 * answer a question nobody asked.
 */
export async function checkReadback(tf: typeof TF): Promise<ReadbackCheck> {
  const expected: Float32Array = probeValues();
  const source: TF.Tensor2D = tf.tensor2d(expected, [1, expected.length]);
  const onGpu: TF.Tensor2D = tf.add(source, tf.scalar(0));

  const sync = onGpu.dataSync() as Float32Array;
  const asynchronous = (await onGpu.data()) as Float32Array;

  const bad = worstDiff(expected, sync);
  const worstAsync = worstDiff(expected, asynchronous);
  const between = worstDiff(sync, asynchronous);

  source.dispose();
  onGpu.dispose();

  const at: number = bad.at >= 0 ? bad.at : 0;
  return {
    syncWorst: bad.worst,
    asyncWorst: worstAsync.worst,
    betweenWorst: between.worst,
    syncWorstAt: bad.at,
    expected: expected[at],
    gotSync: sync[at],
    gotAsync: asynchronous[at],
    count: expected.length,
  };
}
