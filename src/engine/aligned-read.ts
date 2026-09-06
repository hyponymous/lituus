/**
 * Reading a GPU buffer back in one canvas pass, because two passes lose the
 * second one on at least one device.
 *
 * `dataSync()` on tfjs-backend-webgpu is not a readback. `readSync` copies the
 * buffer into an `OffscreenCanvas` WebGPU texture and recovers the bytes with
 * `drawImage` plus `getImageData` — four bytes per pixel, one float per pixel,
 * through a 256x256 canvas. A buffer that does not fill whole rows of that
 * canvas is fetched in **more than one** copy-draw-read cycle: full rows first,
 * then a final partial row, into the same texture.
 *
 * On an iPhone the second cycle does not arrive. The tail of the buffer comes
 * back holding a repeat of its head — the canvas still showing what the first
 * cycle drew — which is stable, finite, and wrong. That is the whole of the
 * fault this project spent three days chasing:
 *
 * - the packed heads are 369 floats, so 361 come back correct and the last
 *   eight are a repeat of policy floats 0..7 — the value, score and pass slots
 *   holding policy numbers, exactly as the phone's exports showed;
 * - read one at a time instead, the policy is 361 floats, so points 256..360
 *   come back as a repeat of points 0..104 — the bottom six rows of the board
 *   wearing the top-left's priors, which is why the phone kept liking M1 and
 *   T3;
 * - the pass, value and score heads are 1, 3 and 4 floats, one partial row and
 *   one cycle, and those were right all along;
 * - `head-layout.ts` could not find its markers, and 4096 known floats — sixteen
 *   whole rows, one cycle — came back exactly. Every failure was a read that
 *   needed two cycles. Every success was a read that needed one.
 *
 * So every read here is padded up to a whole number of canvas rows, which is
 * one cycle and no partial row. It costs a concatenation of at most 255 zeros
 * and is faster than the read it replaces, since a cycle is the expensive part.
 *
 * The alternative is the asynchronous `data()`, which maps the buffer properly
 * and is not affected. It is the better answer and it is not available here: a
 * search is synchronous, fifty forward passes deep, and awaiting each of them
 * is a rewrite of the search (`TODO`, and `docs/design-ai-scoring.md` §5.1).
 */

import type * as TF from '@tensorflow/tfjs-core';

/**
 * Floats per row of the readback canvas — `canvasWidth` in tfjs's `readSync`,
 * one float per pixel. A read of a whole number of these needs no partial row.
 */
export const CANVAS_ROW = 256;

/**
 * Rows per canvas, likewise. A read longer than a full canvas is split whatever
 * its length, so alignment cannot save it; nothing here reads that much, and a
 * caller that starts to has to face the asynchronous read instead.
 */
export const CANVAS_ROWS = 256;

/** The part of TensorFlow.js this needs — `readBackend` adapts it. */
export interface ReadTensor {
  readonly size: number;
  dispose(): void;
}

export interface ReadBackend<T extends ReadTensor> {
  fill(shape: number[], value: number): T;
  zeros(shape: number[]): T;
  concat(parts: T[]): T;
  /** The device's own synchronous read, warts and all. */
  read(tensor: T): Float32Array;
}

/**
 * TensorFlow.js as a `ReadBackend`.
 *
 * Written out rather than passing the module: `tf.fill` and `tf.concat` are
 * generic over rank, and handing the whole module to a generic parameter leaves
 * nothing to infer the tensor type from. Four lines here, and no cast anywhere
 * else.
 */
export function readBackend(tf: typeof TF): ReadBackend<TF.Tensor> {
  return {
    fill: (shape: number[], value: number): TF.Tensor => tf.fill(shape, value),
    zeros: (shape: number[]): TF.Tensor => tf.zeros(shape),
    concat: (parts: TF.Tensor[]): TF.Tensor => tf.concat(parts),
    // `dataSync` is typed as the union of every dtype's array; every tensor
    // read here is float32, and the assertion is the one place that is said.
    read: (tensor: TF.Tensor): Float32Array => tensor.dataSync() as Float32Array,
  };
}

/**
 * How many copy-draw-read cycles tfjs's `readSync` needs for this many floats:
 * whole canvases, then whole rows of the remainder, then a final partial row.
 * Transcribed from `backend_webgpu.js`, because it is the quantity under test.
 */
export function canvasPasses(count: number): number {
  const perCanvas: number = CANVAS_ROW * CANVAS_ROWS;
  const canvases: number = Math.floor(count / perCanvas);
  const rest: number = count % perCanvas;
  const rows: number = Math.floor(rest / CANVAS_ROW);
  const partial: number = rest % CANVAS_ROW;
  return canvases + (rows > 0 ? 1 : 0) + (partial > 0 ? 1 : 0);
}

/** The next length that fills whole canvas rows. */
export function alignedCount(count: number): number {
  return Math.ceil(count / CANVAS_ROW) * CANVAS_ROW;
}

/**
 * Read a tensor back in one canvas pass, and hand back exactly its own floats.
 *
 * The padding is concatenated onto the end, so the values asked for are at the
 * indices they were always at; the extra zeros are never returned.
 */
export function readAligned<T extends ReadTensor>(
  backend: ReadBackend<T>,
  tensor: T,
): Float32Array {
  const padding: number = alignedCount(tensor.size) - tensor.size;
  if (padding === 0) return backend.read(tensor);

  const zeros: T = backend.zeros([padding]);
  const padded: T = backend.concat([tensor, zeros]);
  const values: Float32Array = backend.read(padded);
  zeros.dispose();
  padded.dispose();
  // A view, not a copy: `read` hands back an array of its own, and the caller
  // owns it once the tensors are gone.
  return values.subarray(0, tensor.size);
}
