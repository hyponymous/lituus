/**
 * Where the concatenated heads actually land on this device.
 *
 * `ModelV8.evaluate` reads the whole evaluation back in one call by packing the
 * four heads — policy, pass, value, score — into a single tensor. Unpacking
 * then assumes each segment begins where the lengths say it should. On an
 * M-series Mac it does. On an iPhone the network computed identically, stage
 * for stage, and the value, score and pass slots came back holding policy
 * numbers: the arithmetic was right and the offsets were wrong.
 *
 * The lengths are 361, 1, 3, 4 for a 19x19 board, and 361 is not a multiple of
 * four. A backend that starts each segment on a vector boundary lays the tail
 * out three floats from where the arithmetic says, and nothing about that is an
 * error — it is a layout, and it was simply never asked for.
 *
 * So it is asked for. Each segment is filled with a marker that names it, the
 * same concatenation is run, and the result says where everything went. What
 * comes back is used as the offsets, whatever they are; a device that packs
 * tightly and one that pads both get read correctly, and neither needs to be
 * known about in advance.
 */

import type * as TF from '@tensorflow/tfjs-core';

/**
 * The part of TensorFlow.js this needs — `typeof TF` satisfies it. Named rather
 * than taking the whole module, so the layouts below can be checked against a
 * stand-in that lays segments out the way a device does and no device here
 * will.
 */
export interface LayoutTensor {
  dataSync(): ArrayLike<number>;
  dispose(): void;
}

export interface LayoutBackend<T extends LayoutTensor> {
  fill(shape: number[], value: number): T;
  concat(parts: T[]): T;
}

/**
 * TensorFlow.js as a `LayoutBackend`.
 *
 * Written out rather than passing the module: `tf.fill` and `tf.concat` are
 * generic over rank, and handing the whole module to a generic parameter leaves
 * nothing to infer the tensor type from. Two lines here, and no cast anywhere.
 */
export function layoutBackend(tf: typeof TF): LayoutBackend<TF.Tensor> {
  return {
    fill: (shape: number[], value: number): TF.Tensor => tf.fill(shape, value),
    concat: (parts: TF.Tensor[]): TF.Tensor => tf.concat(parts),
  };
}

export interface HeadLayout {
  /** Where each segment begins, in the packed buffer. */
  readonly offsets: readonly number[];
  /** How long the packed buffer is, which padding can make longer than the sum. */
  readonly length: number;
  /** Whether that is where the lengths alone would have put them. */
  readonly tight: boolean;
}

/**
 * Pack markers, read them back, and report where each segment went.
 *
 * Returns null when the segments cannot be located — not found, not contiguous,
 * or not the right length. That is not the padding case and no set of offsets
 * would fix it, so the caller reads the heads separately instead.
 *
 * Synchronous, because a search is: this runs once per board size, at the point
 * a model first evaluates, and the answer is kept.
 */
export function discoverHeadLayout<T extends LayoutTensor>(
  tf: LayoutBackend<T>,
  sizes: readonly number[],
): HeadLayout | null {
  // The marker is the segment's index plus one, so zero — the value padding is
  // most likely to be — cannot be mistaken for data.
  const markers: T[] = sizes.map((size: number, which: number) => tf.fill([size], which + 1));
  const packed: T = tf.concat(markers);
  const values: ArrayLike<number> = packed.dataSync();

  const at = (i: number): number => {
    for (let scan = 0; scan < values.length; scan++) if (values[scan] === i) return scan;
    return -1;
  };
  const last = (i: number): number => {
    for (let scan = values.length - 1; scan >= 0; scan--) if (values[scan] === i) return scan;
    return -1;
  };

  const offsets: number[] = [];
  let usable = true;
  for (const [which, size] of sizes.entries()) {
    const marker: number = which + 1;
    const start: number = at(marker);
    // Contiguous and complete, or the segment is not really there: a layout
    // that interleaves cannot be unpacked by an offset, however it is found.
    if (start < 0 || start + size > values.length) usable = false;
    else {
      for (let i = start; i < start + size; i++) if (values[i] !== marker) usable = false;
      if (last(marker) !== start + size - 1) usable = false;
    }
    offsets.push(start);
  }

  for (const marker of markers) marker.dispose();
  packed.dispose();
  if (!usable) return null;

  let tight = true;
  let expected = 0;
  for (const [which, size] of sizes.entries()) {
    if (offsets[which] !== expected) tight = false;
    expected += size;
  }
  return { offsets, length: values.length, tight };
}
