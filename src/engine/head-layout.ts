/**
 * Where the concatenated heads actually land on this device.
 *
 * `ModelV8.evaluate` reads the whole evaluation back in one call by packing the
 * four heads — policy, pass, value, score — into a single tensor, then
 * unpacking each segment from where the lengths say it begins. On an M-series
 * Mac that is where they are. On an iPhone the network computed identically,
 * stage for stage, and the value, score and pass slots came back holding policy
 * numbers.
 *
 * The cause turned out to be the read rather than the layout: a buffer that
 * does not fill whole rows of tfjs's readback canvas is fetched in two cycles,
 * and on that device the second one is lost — see `aligned-read.ts`. The model
 * now reads through the asynchronous `data()`, which takes no canvas path. The
 * markers below are what named the fault, and they stay: they are the one
 * check that looks at the packed buffer itself and says whether the heads are
 * all in it, contiguous, and where the arithmetic expects. A device that fails
 * it is read one head at a time instead of being quietly unpacked wrong. So the
 * markers are read through the same `data()` the model then uses, since the
 * read is what was at fault last time.
 */

import type { ReadBackend, ReadTensor } from './aligned-read.ts';

export interface HeadLayout {
  /** Where each segment begins, in the packed buffer. */
  readonly offsets: readonly number[];
  /** How long the packed buffer is. */
  readonly length: number;
  /** Whether that is where the lengths alone would have put them. */
  readonly tight: boolean;
}

/**
 * Pack markers, read them back through `await data()`, and report where each
 * segment went.
 *
 * Returns null when the segments cannot be located — not found, not contiguous,
 * or not the right length. No set of offsets would fix that, so the caller
 * reads the heads separately instead.
 *
 * This runs once per board size, at the point a model first evaluates, and the
 * answer is kept.
 */
export async function discoverHeadLayout<T extends ReadTensor>(
  backend: ReadBackend<T>,
  sizes: readonly number[],
): Promise<HeadLayout | null> {
  // The marker is the segment's index plus one, so zero — the value a lost read
  // is most likely to leave behind — cannot be mistaken for data.
  const markers: T[] = sizes.map((size: number, which: number) =>
    backend.fill([size], which + 1),
  );
  const packed: T = backend.concat(markers);
  try {
    return locateSegments(await backend.readAsync(packed), sizes);
  } finally {
    for (const marker of markers) marker.dispose();
    packed.dispose();
  }
}


/** Where the markers came back, or null if any segment is not all there. */
function locateSegments(values: Float32Array, sizes: readonly number[]): HeadLayout | null {
  const at = (i: number): number => {
    for (let scan = 0; scan < values.length; scan++) if (values[scan] === i) return scan;
    return -1;
  };
  const last = (i: number): number => {
    for (let scan = values.length - 1; scan >= 0; scan--) if (values[scan] === i) return scan;
    return -1;
  };

  const offsets: number[] = [];
  for (const [which, size] of sizes.entries()) {
    const marker: number = which + 1;
    const start: number = at(marker);
    // Contiguous and complete, or the segment is not really there: a layout
    // that interleaves cannot be unpacked by an offset, however it is found.
    if (start < 0 || start + size > values.length) return null;
    for (let i = start; i < start + size; i++) if (values[i] !== marker) return null;
    if (last(marker) !== start + size - 1) return null;
    offsets.push(start);
  }

  let tight = true;
  let expected = 0;
  for (const [which, size] of sizes.entries()) {
    if (offsets[which] !== expected) tight = false;
    expected += size;
  }
  return { offsets, length: values.length, tight };
}
