/**
 * The direction of every number this product prints.
 *
 * A point loss is positive-is-worse below the view layer and negative-is-worse
 * on screen, so every display crosses exactly one negation. That flip has been
 * doubled twice — most recently in `f0402d5`, which left the review board, its
 * cost line and the strip's tooltip printing a guess that cost three points as
 * "+3.0" for two days while the chart beside them, which reads the loss
 * directly, leaned the right way.
 *
 * `asChange` and `edge` are now the only ways a loss reaches a screen and they
 * take losses only, so there is no call-site arithmetic left to get backwards.
 * These tests are what says which way they lean; the fixture-driven half is in
 * `fixture-ai.test.ts`, where the numbers come from KataGo rather than from here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asChange, edge } from '../src/summary.ts';

test('a loss prints as what it cost you', () => {
  assert.equal(asChange(2.72), '-2.7');
  assert.equal(asChange(0), '+0.0', 'negating zero must not produce "-0.0"');
  // Search noise: a negative loss is a move that looks better than the root,
  // and it prints as the gain it looks like rather than as zero.
  assert.equal(asChange(-0.23), '+0.2');
});

test('an edge is your loss against theirs, positive when yours cost less', () => {
  // The fixture's move 16: your guess lost 2.72, the played move lost -0.23.
  assert.equal(edge(2.72, -0.23), '-3.0');
  assert.equal(edge(-0.23, 2.72), '+3.0');
  // Against the engine's best, which by definition gave up nothing.
  assert.equal(edge(2.72, 0), '-2.7');
  assert.equal(edge(2.72, 0), asChange(2.72), 'the same figure, the same way up');
});

test('an edge decides its sign at the precision it prints', () => {
  assert.equal(edge(1, 1), '+0.0');
  assert.equal(edge(0.44, 0.4, 2), '-0.04');
  assert.equal(edge(0.401, 0.4, 2), '+0.00', 'too small to show is too small to sign');
});

test('a comparison that cannot be made is not a zero', () => {
  assert.equal(edge(null, 2.72), null);
  assert.equal(edge(-0.23, null), null);
});
