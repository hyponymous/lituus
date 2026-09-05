/**
 * Which operation does this device get wrong?
 *
 * A phone computes this network deterministically and differently from a
 * laptop, and the readback is not the cause — 4096 known floats come back off
 * its GPU exactly as they went on. So the fault is in an operation, and there
 * are only a dozen of them in `model-v8.ts`. This runs each one twice on the
 * same machine, once on WebGPU and once on the CPU backend, from identical
 * inputs, and reports where the two answers part.
 *
 * The CPU backend is the reference here rather than a baked constant, which
 * makes this instrument portable to a device nobody has measured: it carries
 * its own second opinion. It is not a claim that the CPU backend is correct in
 * some absolute sense — only that a device whose GPU disagrees with its own CPU
 * about `tf.mean` has a bug that no amount of tolerance-picking will fix.
 *
 * The shapes are the model's own. An operation can be right at [1, 4] and wrong
 * at [1, 19, 19, 32], and the second is what a session runs.
 */

import type * as TF from '@tensorflow/tfjs-core';

/** The trunk's channel count at b15c192, and the board the app plays on. */
const CHANNELS = 32;
const SIZE = 19;

export interface OpResult {
  readonly name: string;
  /** Largest relative difference between the two backends' answers. */
  readonly worst: number;
  /** What each said at that entry, for a reader comparing two devices. */
  readonly gpu: number;
  readonly cpu: number;
}

/** One case: a name, the inputs it needs, and what to do with them. */
interface Case {
  readonly name: string;
  readonly run: (tf: typeof TF, inputs: readonly TF.Tensor[]) => TF.Tensor;
  readonly shapes: readonly number[][];
}

/** Deterministic, and the same on both backends, since the inputs must match. */
function values(count: number, seed: number): Float32Array {
  const out = new Float32Array(count);
  let state: number = seed;
  for (let i = 0; i < count; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    // Centred on zero: a reduction over values that are all positive hides a
    // sign error, and `max` over them hides almost everything.
    out[i] = ((state >>> 0) / 0x100000000) * 2 - 1;
  }
  return out;
}

const spatial: number[] = [1, SIZE, SIZE, CHANNELS];

const CASES: readonly Case[] = [
  {
    name: 'mean over [1, 2]',
    shapes: [spatial],
    run: (tf, [x]) => tf.mean(x as TF.Tensor4D, [1, 2]),
  },
  {
    name: 'max over [1, 2]',
    shapes: [spatial],
    run: (tf, [x]) => tf.max(x as TF.Tensor4D, [1, 2]),
  },
  {
    name: 'conv2d 3x3 same',
    shapes: [spatial, [3, 3, CHANNELS, CHANNELS]],
    run: (tf, [x, w]) =>
      tf.conv2d(x as TF.Tensor4D, w as TF.Tensor4D, 1, 'same', 'NHWC', [1, 1]),
  },
  {
    name: 'conv2d 3x3 dilated',
    shapes: [spatial, [3, 3, CHANNELS, CHANNELS]],
    run: (tf, [x, w]) =>
      tf.conv2d(x as TF.Tensor4D, w as TF.Tensor4D, 1, 'same', 'NHWC', [2, 2]),
  },
  {
    name: 'conv2d 1x1',
    shapes: [spatial, [1, 1, CHANNELS, CHANNELS]],
    run: (tf, [x, w]) =>
      tf.conv2d(x as TF.Tensor4D, w as TF.Tensor4D, 1, 'same', 'NHWC', [1, 1]),
  },
  {
    name: 'matMul',
    shapes: [[1, CHANNELS * 3], [CHANNELS * 3, CHANNELS]],
    run: (tf, [a, b]) => tf.matMul(a as TF.Tensor2D, b as TF.Tensor2D),
  },
  {
    name: 'add, broadcast over channels',
    shapes: [spatial, [1, 1, 1, CHANNELS]],
    run: (tf, [x, b]) => tf.add(x, b),
  },
  {
    name: 'mul, broadcast over channels',
    shapes: [spatial, [1, 1, 1, CHANNELS]],
    run: (tf, [x, b]) => tf.mul(x, b),
  },
  { name: 'relu', shapes: [spatial], run: (tf, [x]) => tf.relu(x) },
  { name: 'tanh', shapes: [spatial], run: (tf, [x]) => tf.tanh(x) },
  { name: 'softplus', shapes: [[1, CHANNELS]], run: (tf, [x]) => tf.softplus(x) },
  {
    name: 'concat along channels',
    shapes: [[1, CHANNELS], [1, CHANNELS]],
    run: (tf, [a, b]) => tf.concat([a as TF.Tensor2D, b as TF.Tensor2D], 1),
  },
  {
    name: 'slice',
    shapes: [spatial],
    run: (tf, [x]) => tf.slice(x as TF.Tensor4D, [0, 0, 0, 0], [1, SIZE, SIZE, 4]),
  },
];

/** Run every case on the current backend and read the answers back. */
async function answers(tf: typeof TF): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (const [at, one] of CASES.entries()) {
    const inputs: TF.Tensor[] = one.shapes.map((shape: number[], which: number) =>
      // Seeded per case and per input, so every case sees different numbers and
      // both backends see the same ones.
      tf.tensor(values(shape.reduce((a, b) => a * b, 1), (at + 1) * 7919 + which * 104729), shape),
    );
    const result: TF.Tensor = one.run(tf, inputs);
    out.push((await result.data()) as Float32Array);
    tf.dispose(inputs);
    result.dispose();
  }
  return out;
}

/**
 * Every operation the model uses, on both backends, worst case first.
 *
 * Leaves the WebGPU backend selected, since the caller has a network to load
 * onto it afterwards.
 */
export async function checkOps(tf: typeof TF): Promise<OpResult[]> {
  const gpu: Float32Array[] = await answers(tf);
  if (!(await tf.setBackend('cpu'))) throw new Error('no CPU backend to compare against');
  await tf.ready();
  const cpu: Float32Array[] = await answers(tf);
  await tf.setBackend('webgpu');
  await tf.ready();

  const results: OpResult[] = CASES.map((one: Case, at: number): OpResult => {
    let worst = 0;
    let where = 0;
    for (let i = 0; i < gpu[at].length; i++) {
      const off: number = Math.abs(gpu[at][i] - cpu[at][i]) / (1 + Math.abs(cpu[at][i]));
      if (off > worst) {
        worst = off;
        where = i;
      }
    }
    return { name: one.name, worst, gpu: gpu[at][where], cpu: cpu[at][where] };
  });
  return results.sort((a: OpResult, b: OpResult) => b.worst - a.worst);
}
