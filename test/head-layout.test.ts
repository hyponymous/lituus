/**
 * Finding the heads in a packed buffer.
 *
 * The unpacking assumed each segment held what was put in it. On a phone the
 * value and score slots came back holding policy numbers, and every stage of
 * the network before that point had agreed digit for digit. So the packed
 * buffer is looked at rather than trusted, and these are the layouts that
 * looking has to survive.
 *
 * A stand-in for the backend, because the layouts being tested are ones no
 * available device produces on demand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignedCount, type ReadBackend, type ReadTensor } from '../src/engine/aligned-read.ts';
import { discoverHeadLayout } from '../src/engine/head-layout.ts';

const SIZES = [361, 1, 3, 4] as const;

/** A tensor that is just its own buffer, since that is what is being read. */
interface Segment extends ReadTensor {
  readonly size: number;
  readonly value: number;
  readonly buffer: Float32Array;
}

const segment = (buffer: Float32Array, value: number): Segment => ({
  size: buffer.length,
  value,
  buffer,
  dispose: (): void => {},
});

/**
 * A backend whose `concat` lays segments out however `place` says, so a padded
 * device, a tight one and a broken one can all be asked the same question.
 */
function backend(
  place: (sizes: readonly number[]) => { at: number[]; length: number },
): ReadBackend<Segment> {
  return {
    fill: (shape: number[], value: number): Segment =>
      segment(new Float32Array(shape[0]).fill(value), value),
    zeros: (shape: number[]): Segment => segment(new Float32Array(shape[0]), 0),
    concat: (parts: Segment[]): Segment => {
      const { at, length } = place(parts.map((part: Segment) => part.size));
      const buffer = new Float32Array(length);
      parts.forEach((part: Segment, which: number) =>
        buffer.set(part.buffer, at[which]),
      );
      return segment(buffer, 0);
    },
    read: (tensor: Segment): Float32Array => tensor.buffer,
  };
}

const tightly = (sizes: readonly number[]) => {
  const at: number[] = [];
  let next = 0;
  for (const size of sizes) {
    at.push(next);
    next += size;
  }
  return { at, length: next };
};

/** Each segment starting on a four-float boundary. */
const padded = (sizes: readonly number[]) => {
  const at: number[] = [];
  let next = 0;
  for (const size of sizes) {
    at.push(next);
    next += Math.ceil(size / 4) * 4;
  }
  return { at, length: next };
};

test('a tightly packed device is read at the arithmetic offsets', () => {
  const layout = discoverHeadLayout(backend(tightly), SIZES);

  assert.ok(layout);
  assert.deepEqual(layout.offsets, [0, 361, 362, 365]);
  assert.equal(layout.length, 369);
  assert.equal(layout.tight, true);
});

test('a padded device is read where its heads actually are', () => {
  // The whole point: this is not an error to refuse, it is a layout to use.
  const layout = discoverHeadLayout(backend(padded), SIZES);

  assert.ok(layout);
  assert.deepEqual(layout.offsets, [0, 364, 368, 372]);
  assert.equal(layout.tight, false);
});

test('the read is padded to whole canvas rows before it is looked at', () => {
  // What the discovery is now built on: the buffer handed to the device is a
  // whole number of rows long, so the device never has to fetch it in two
  // cycles. The lengths asked for are the evidence.
  const asked: number[] = [];
  const watching: ReadBackend<Segment> = backend((sizes: readonly number[]) => {
    asked.push(sizes.reduce((a: number, b: number) => a + b, 0));
    return tightly(sizes);
  });

  assert.ok(discoverHeadLayout(watching, SIZES));
  assert.deepEqual(asked, [369, alignedCount(369)]);
  assert.equal(alignedCount(369), 512);
});

test('a layout that loses a segment is refused rather than guessed at', () => {
  // Nothing an offset can do for a buffer that does not contain the data.
  const missing = (sizes: readonly number[]) => {
    const laid = tightly(sizes);
    return { at: laid.at.map((at, which) => (which === 2 ? 0 : at)), length: laid.length };
  };
  assert.equal(discoverHeadLayout(backend(missing), SIZES), null);
});

test('a layout that interleaves a segment is refused', () => {
  // Contiguity is what an offset and a length assume; without it the segment is
  // findable and still unreadable.
  const buffer = new Float32Array(369);
  buffer.fill(1, 0, 361);
  buffer[361] = 2;
  buffer[362] = 3;
  buffer[363] = 4; // a score float inside the value segment
  buffer[364] = 3;
  buffer.fill(4, 365, 369);
  const interleaved: ReadBackend<Segment> = {
    fill: (shape: number[], value: number): Segment =>
      segment(new Float32Array(shape[0]).fill(value), value),
    zeros: (shape: number[]): Segment => segment(new Float32Array(shape[0]), 0),
    concat: (): Segment => segment(buffer, 0),
    read: (tensor: Segment): Float32Array => tensor.buffer,
  };

  assert.equal(discoverHeadLayout(interleaved, SIZES), null);
});

test('the same lengths on a 9x9 board find their own offsets', () => {
  // A model serves every board size, and 81 is not 361: the layout is measured
  // per set of lengths rather than once.
  const layout = discoverHeadLayout(backend(padded), [81, 1, 3, 4]);

  assert.ok(layout);
  assert.deepEqual(layout.offsets, [0, 84, 88, 92]);
});
