/**
 * Reading a buffer back in one canvas cycle.
 *
 * The device that made this necessary is an iPhone, and the fault is not
 * reproducible on the machine these tests run on — so the device is written
 * down instead. `losesTheSecondCycle` does exactly what that phone does: it
 * fetches whole 256-float rows correctly and leaves the leftovers holding a
 * repeat of the buffer's first floats, which is stable, plausible, and wrong.
 *
 * What is being tested is that no read this project makes ever reaches that
 * path, and that the values come back at the indices they were asked for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alignedCount,
  canvasPasses,
  readAligned,
  CANVAS_ROW,
  CANVAS_ROWS,
  type ReadBackend,
  type ReadTensor,
} from '../src/engine/aligned-read.ts';

interface Buffered extends ReadTensor {
  readonly buffer: Float32Array;
  readonly disposed: () => boolean;
}

function held(buffer: Float32Array): Buffered {
  let gone = false;
  return {
    size: buffer.length,
    buffer,
    dispose: (): void => {
      gone = true;
    },
    disposed: (): boolean => gone,
  };
}

/**
 * A device that fetches whole rows and loses whatever cycle comes after them.
 * `read` is the only method that behaves badly; the rest is bookkeeping.
 */
function losesTheSecondCycle(): ReadBackend<Buffered> {
  return {
    fill: (shape: number[], value: number): Buffered =>
      held(new Float32Array(shape[0]).fill(value)),
    zeros: (shape: number[]): Buffered => held(new Float32Array(shape[0])),
    concat: (parts: Buffered[]): Buffered => {
      const buffer = new Float32Array(
        parts.reduce((total: number, part: Buffered) => total + part.size, 0),
      );
      let at = 0;
      for (const part of parts) {
        buffer.set(part.buffer, at);
        at += part.size;
      }
      return held(buffer);
    },
    read: (tensor: Buffered): Float32Array => {
      const got: Float32Array = tensor.buffer.slice();
      const tail: number = tensor.size % CANVAS_ROW;
      // The last cycle never lands, so those floats are still whatever the
      // cycle before it drew: the start of the buffer.
      for (let i = 0; i < tail; i++) got[tensor.size - tail + i] = tensor.buffer[i];
      return got;
    },
  };
}

const ramp = (count: number): Float32Array =>
  Float32Array.from({ length: count }, (_unused: number, i: number) => i + 1);

test('a length that fills whole rows is read as it stands', () => {
  assert.equal(alignedCount(512), 512);
  assert.equal(alignedCount(0), 0);
  assert.equal(alignedCount(1), CANVAS_ROW);
  assert.equal(alignedCount(361), 512);
});

test('the lengths the model reads are the ones that need two cycles', () => {
  // The arithmetic that made the fault invisible for so long: the first
  // readback check ran 4096 floats, which is one cycle, on a device whose
  // every wrong read needed two.
  assert.equal(canvasPasses(4096), 1);
  assert.equal(canvasPasses(CANVAS_ROW), 1);
  assert.equal(canvasPasses(361), 2);
  assert.equal(canvasPasses(369), 2);
  assert.equal(canvasPasses(1), 1);
  // A full canvas and one float over: whole canvas, then the leftover.
  assert.equal(canvasPasses(CANVAS_ROW * CANVAS_ROWS + 1), 2);
  // Every read this project makes, once padded, is a single cycle.
  for (const count of [1, 3, 4, 81, 361, 369, 512]) {
    assert.equal(canvasPasses(alignedCount(count)), 1);
  }
});

test('the policy comes back whole on a device that loses the second cycle', () => {
  const backend: ReadBackend<Buffered> = losesTheSecondCycle();
  const policy: Buffered = held(ramp(361));

  // What the fault looked like: points 256..360 wearing the priors of points
  // 0..104, which is why the phone kept liking moves on the bottom edge.
  const raw: Float32Array = backend.read(policy);
  assert.equal(raw[256], 1);
  assert.equal(raw[360], 105);

  const values: Float32Array = readAligned(backend, policy);
  assert.equal(values.length, 361);
  assert.deepEqual(Array.from(values), Array.from(ramp(361)));
});

test('the packed heads come back whole, padding and all disposed', () => {
  const backend: ReadBackend<Buffered> = losesTheSecondCycle();
  const packed: Buffered = held(ramp(369));

  const values: Float32Array = readAligned(backend, packed);

  assert.equal(values.length, 369);
  // The tail is the point: 361..368 is the pass, value and score heads, and on
  // the phone they came back holding policy floats 0..7.
  assert.deepEqual(Array.from(values.subarray(361)), [362, 363, 364, 365, 366, 367, 368, 369]);
  assert.equal(packed.disposed(), false, 'the caller owns the tensor it passed in');
});

test('a read that needs no padding is not copied through one', () => {
  const backend: ReadBackend<Buffered> = losesTheSecondCycle();
  let concatenated = 0;
  const watching: ReadBackend<Buffered> = {
    ...backend,
    concat: (parts: Buffered[]): Buffered => {
      concatenated++;
      return backend.concat(parts);
    },
  };

  const values: Float32Array = readAligned(watching, held(ramp(CANVAS_ROW * 2)));

  assert.equal(concatenated, 0);
  assert.equal(values.length, CANVAS_ROW * 2);
  assert.equal(values[CANVAS_ROW * 2 - 1], CANVAS_ROW * 2);
});
