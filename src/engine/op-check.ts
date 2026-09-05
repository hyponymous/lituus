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
import { furthestApart, type Difference } from './difference.ts';

/**
 * The network's own dimensions, not round numbers.
 *
 * The first battery ran at 32 channels with 3x3 convolutions and found nothing,
 * on a device whose full forward pass is wrong. That was the wrong test: a
 * WebGPU kernel is chosen by shape, and a vector-packed path can be selected —
 * or not — on whether a channel count divides by four. `conv1` is 5x5 with
 * **22** input channels, which does not, and it is the first thing a position
 * goes through.
 */
const TRUNK = 192;
const MID = 128;
const GPOOL = 64;
const HEAD = 32;
const INPUT = 22;
const SIZE = 19;

/**
 * How far two backends on one machine may differ before it is a finding.
 *
 * The floor here is float noise from a different order of accumulation: the
 * worst any case reaches on a healthy device is 4.6e-7, on a 192-wide matMul.
 * A thousandth is three orders above that and far below anything that would
 * move a move.
 */
export const OP_TOLERANCE = 1e-3;

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

const board = (channels: number): number[] => [1, SIZE, SIZE, channels];

const conv = (
  name: string,
  inChannels: number,
  outChannels: number,
  kernel: number,
  dilation = 1,
): Case => ({
  name: `conv2d ${kernel}x${kernel} ${inChannels}->${outChannels}${dilation > 1 ? ` dilated ${dilation}` : ''}`,
  shapes: [board(inChannels), [kernel, kernel, inChannels, outChannels]],
  run: (tf, [x, w]) =>
    tf.conv2d(x as TF.Tensor4D, w as TF.Tensor4D, 1, 'same', 'NHWC', [dilation, dilation]),
});

const CASES: readonly Case[] = [
  // The trunk, in the order a position meets it. conv1 first, because 22 input
  // channels is the one shape here that no packing rule likes.
  conv('conv1', INPUT, TRUNK, 5),
  conv('ordinary', TRUNK, TRUNK, 3),
  conv('gpool w1a', TRUNK, MID, 3),
  conv('gpool w1b', TRUNK, GPOOL, 3),
  conv('gpool w2', MID, TRUNK, 3),
  conv('head 1x1', TRUNK, HEAD, 1),
  {
    name: `mean over [1, 2] at ${TRUNK}`,
    shapes: [board(TRUNK)],
    run: (tf, [x]) => tf.mean(x as TF.Tensor4D, [1, 2]),
  },
  {
    name: `max over [1, 2] at ${GPOOL}`,
    shapes: [board(GPOOL)],
    run: (tf, [x]) => tf.max(x as TF.Tensor4D, [1, 2]),
  },
  {
    name: `mean over [1, 2] at ${HEAD}`,
    shapes: [board(HEAD)],
    run: (tf, [x]) => tf.mean(x as TF.Tensor4D, [1, 2]),
  },
  {
    name: `matMul ${TRUNK}->${MID}`,
    shapes: [[1, TRUNK], [TRUNK, MID]],
    run: (tf, [a, b]) => tf.matMul(a as TF.Tensor2D, b as TF.Tensor2D),
  },
  {
    name: 'matMul 96->96',
    shapes: [[1, 96], [96, 96]],
    run: (tf, [a, b]) => tf.matMul(a as TF.Tensor2D, b as TF.Tensor2D),
  },
  {
    name: `add, broadcast over ${TRUNK}`,
    shapes: [board(TRUNK), [1, 1, 1, TRUNK]],
    run: (tf, [x, b]) => tf.add(x, b),
  },
  {
    name: `mul, broadcast over ${TRUNK}`,
    shapes: [board(TRUNK), [1, 1, 1, TRUNK]],
    run: (tf, [x, b]) => tf.mul(x, b),
  },
  { name: `relu at ${TRUNK}`, shapes: [board(TRUNK)], run: (tf, [x]) => tf.relu(x) },
  { name: `tanh at ${TRUNK}`, shapes: [board(TRUNK)], run: (tf, [x]) => tf.tanh(x) },
  { name: 'softplus', shapes: [[1, 4]], run: (tf, [x]) => tf.softplus(x) },
  /*
   * The head packing, exactly as `evaluate` does it: four 1-D segments of
   * 361, 1, 3 and 4, concatenated so the whole evaluation can be read back in
   * one call. 361 is not a multiple of four, and an implementation that starts
   * each segment on a vector boundary would put the tail three floats late —
   * which is not an arithmetic error and would leave every stage of the network
   * agreeing while the answer comes out wrong.
   *
   * The earlier battery tested `concat 64+64+64` on 2-D tensors: equal
   * segments, all multiples of four, along axis 1. It could not have found
   * this.
   */
  {
    name: 'concat 1-D 361+1+3+4 (the head packing)',
    shapes: [[361], [1], [3], [4]],
    run: (tf, [policy, pass, value, score]) =>
      tf.concat([
        policy as TF.Tensor1D,
        pass as TF.Tensor1D,
        value as TF.Tensor1D,
        score as TF.Tensor1D,
      ]),
  },
  {
    name: `concat ${GPOOL}+${GPOOL}+${GPOOL}`,
    shapes: [[1, GPOOL], [1, GPOOL], [1, GPOOL]],
    run: (tf, [a, b, c]) =>
      tf.concat([a as TF.Tensor2D, b as TF.Tensor2D, c as TF.Tensor2D], 1),
  },
  {
    name: 'slice the policy plane',
    shapes: [board(HEAD)],
    run: (tf, [x]) => tf.slice(x as TF.Tensor4D, [0, 0, 0, 0], [1, SIZE, SIZE, 1]),
  },
  /*
   * One composed case, because every operation above can be right on its own
   * and the network still wrong. This is an ordinary trunk block: normalize,
   * activate, convolve, and add the input back.
   */
  {
    name: 'composed: one residual block',
    shapes: [board(TRUNK), [1, 1, 1, TRUNK], [1, 1, 1, TRUNK], [3, 3, TRUNK, TRUNK]],
    run: (tf, [x, scale, bias, w]) => {
      const normalized = tf.add(tf.mul(x, scale), bias);
      const activated = tf.relu(normalized);
      const convolved = tf.conv2d(
        activated as TF.Tensor4D,
        w as TF.Tensor4D,
        1,
        'same',
        'NHWC',
        [1, 1],
      );
      return tf.add(x, convolved);
    },
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
    const found: Difference = furthestApart(cpu[at], gpu[at]);
    const where: number = Math.max(found.at, 0);
    return { name: one.name, worst: found.worst, gpu: gpu[at][where], cpu: cpu[at][where] };
  });
  return results.sort((a: OpResult, b: OpResult) => b.worst - a.worst);
}
