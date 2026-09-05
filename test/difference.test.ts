/**
 * The one measure every cross-device check reports.
 *
 * Its shape decides what a tolerance means, and four tolerances are quoted
 * against it — the canary's drift, the baked-answer comparison, the readback,
 * and the op battery. Getting the scaling wrong makes all four wrong together.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { furthestApart } from '../src/engine/difference.ts';

test('identical sequences are zero apart, and name no place', () => {
  const found = furthestApart([1, -2, 3], [1, -2, 3]);

  assert.equal(found.worst, 0);
  assert.equal(found.at, -1);
});

test('the worst entry is the one reported, not the last', () => {
  const found = furthestApart([1, 1, 1], [1, 1.5, 1.1]);

  assert.equal(found.at, 1);
  assert.equal(found.worst, 0.25);
});

test('a small absolute difference against a small expectation is not catastrophic', () => {
  // Purely relative scaling would call this a 10x error. The heads it is
  // applied to include a value of 0.073 and a policy sum of -9,373, and one
  // threshold has to cover both.
  const found = furthestApart([0.0001], [0.0011]);

  assert.ok(found.worst < 0.01, `${found.worst} should sit under the 1e-2 tolerance`);
});

test('a large difference against a large expectation still registers', () => {
  // The other half: absolute scaling would let a score lead move by tens of
  // points inside a tolerance chosen for a logit.
  const found = furthestApart([100], [150]);

  assert.ok(found.worst > 0.01);
});

test('the comparison is over the expected sequence, extra values aside', () => {
  // A padded readback is longer than what was asked for; the check is on the
  // numbers that were supposed to be there.
  const found = furthestApart([1, 2], [1, 2, 999]);

  assert.equal(found.worst, 0);
});
