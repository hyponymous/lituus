/**
 * The weights, checked.
 *
 * The last unverified input to the engine, and the one that explains a device
 * computing the network deterministically and differently while its readback is
 * exact and every operation agrees with its own CPU. A completed download is
 * not an intact one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkWeights } from '../src/engine/weights-check.ts';
import { NETWORK } from '../src/engine/network.ts';

test('bytes that are not the network are refused, and say what they were', async () => {
  const check = await checkWeights(new Uint8Array([1, 2, 3]));

  assert.equal(check.matches, false);
  assert.equal(check.bytes, 3);
  assert.match(check.sha256, /^[0-9a-f]{64}$/);
});

test('the hash is over the content, not the length', async () => {
  // A body damaged in place keeps its length, passes every check the download
  // had before this one, parses, and evaluates. That is the case this exists
  // for, so length alone must not be able to satisfy it.
  const size = 1024;
  const first = await checkWeights(new Uint8Array(size));
  const damaged = new Uint8Array(size);
  damaged[512] = 1;
  const second = await checkWeights(damaged);

  assert.equal(first.bytes, second.bytes);
  assert.notEqual(first.sha256, second.sha256);
});

test('the same bytes hash the same way twice', async () => {
  const bytes = Uint8Array.from({ length: 256 }, (_unused, at: number) => at);
  const once = await checkWeights(bytes);
  const twice = await checkWeights(bytes);

  assert.equal(once.sha256, twice.sha256);
});

test('the pinned hash is a sha256 of the pinned size', () => {
  // Guards the descriptor itself: a network swapped without regenerating these
  // would refuse every device, and the failure would look like every device
  // being broken rather than like a stale constant.
  assert.match(NETWORK.sha256, /^[0-9a-f]{64}$/);
  assert.ok(NETWORK.inflatedBytes > NETWORK.bytes, 'inflated is larger than compressed');
});
