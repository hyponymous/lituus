/**
 * The score-utility tables, against their own definitions.
 *
 * These are transcriptions of KataGo arithmetic and nothing on screen shows
 * them, so the only thing that can catch a mistyped constant is a test that
 * knows what the constant is supposed to mean. Two of the three functions here
 * are checked against a definition computed a different way — a numeric
 * integration rather than a table lookup — so a transposed index does not pass
 * by agreeing with itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  expectedScoreValue,
  scoreStdev,
  scoreValueOfScore,
  valueWeightCdf,
} from '../src/engine/score-value.ts';

test('score value is an odd, bounded, increasing function of the score', () => {
  assert.equal(scoreValueOfScore(0, 0, 1, 19), 0);
  for (const score of [0.5, 3, 10, 60, 400]) {
    const up: number = scoreValueOfScore(score, 0, 1, 19);
    const down: number = scoreValueOfScore(-score, 0, 1, 19);
    assert.ok(Math.abs(up + down) < 1e-12, `not odd at ${score}`);
    assert.ok(up > 0 && up < 1, `out of range at ${score}`);
  }
  assert.ok(scoreValueOfScore(10, 0, 1, 19) > scoreValueOfScore(9, 0, 1, 19));

  // A hundred points is worth much more of the utility range on 9x9 than on
  // 19x19, which is the whole reason the board size is a parameter.
  assert.ok(scoreValueOfScore(100, 0, 1, 9) > scoreValueOfScore(100, 0, 1, 19));
});

test('score stdev clamps a negative variance rather than returning NaN', () => {
  assert.equal(scoreStdev(3, 25), 4);
  assert.equal(scoreStdev(5, 25), 0);
  assert.equal(scoreStdev(5, 24), 0);
});

/** The definition `expectedScoreValue` interpolates: a Gaussian average. */
function integrateExpectedScoreValue(
  mean: number, stdev: number, center: number, scale: number, sqrtBoardArea: number,
): number {
  if (stdev === 0) return scoreValueOfScore(mean, center, scale, sqrtBoardArea);
  let weightSum = 0;
  let valueSum = 0;
  const steps = 2000;
  for (let i = -steps; i <= steps; i++) {
    const z: number = (i / steps) * 6;
    const weight: number = Math.exp(-0.5 * z * z);
    weightSum += weight;
    valueSum += weight * scoreValueOfScore(mean + z * stdev, center, scale, sqrtBoardArea);
  }
  return valueSum / weightSum;
}

test('expected score value matches a direct Gaussian integration', () => {
  const cases: ReadonlyArray<readonly [number, number, number, number]> = [
    [0, 10, 0, 2],
    [7.5, 12, 0, 2],
    [-3.25, 8, 0, 0.75],
    [40, 20, 30, 0.75],
    [-60, 5, -12, 0.75],
  ];
  for (const [mean, stdev, center, scale] of cases) {
    const table: number = expectedScoreValue(mean, stdev, center, scale, 19);
    const direct: number = integrateExpectedScoreValue(mean, stdev, center, scale, 19);
    // The table is sampled on a tenth-of-a-point grid and bilinearly
    // interpolated, so it is not expected to be exact — only close.
    assert.ok(
      Math.abs(table - direct) < 2e-3,
      `mean ${mean} stdev ${stdev}: table ${table} vs direct ${direct}`,
    );
  }
});

test('expected score value is monotonic in the mean and flattened by the stdev', () => {
  assert.ok(expectedScoreValue(5, 10, 0, 2, 19) > expectedScoreValue(4, 10, 0, 2, 19));
  // More uncertainty about a winning score pulls its value back towards even.
  const sharp: number = expectedScoreValue(30, 2, 0, 2, 19);
  const vague: number = expectedScoreValue(30, 40, 0, 2, 19);
  assert.ok(vague < sharp);
});

/** The t density at three degrees of freedom, integrated to give its CDF. */
function integrateTCdf(z: number): number {
  const density = (t: number): number =>
    (6 * Math.sqrt(3)) / (Math.PI * (3 + t * t) * (3 + t * t));
  const steps = 200000;
  const low = -200;
  const step: number = (z - low) / steps;
  let total = 0;
  for (let i = 0; i < steps; i++) {
    total += density(low + (i + 0.5) * step) * step;
  }
  return total;
}

test('the value-weight CDF is the t distribution at three degrees of freedom', () => {
  assert.ok(Math.abs(valueWeightCdf(0) - 0.5) < 1e-12);
  for (const z of [-3, -1, -0.25, 0.5, 2, 6]) {
    const table: number = valueWeightCdf(z);
    const direct: number = integrateTCdf(z);
    // The table has 2000 points over [-50, 50] and is linearly interpolated,
    // which is upstream's resolution and therefore ours.
    assert.ok(Math.abs(table - direct) < 5e-4, `at z=${z}: ${table} vs ${direct}`);
  }
});

test('the value-weight CDF saturates at the table bounds', () => {
  assert.equal(valueWeightCdf(-1000), 0);
  assert.equal(valueWeightCdf(1000), 1);
  assert.ok(valueWeightCdf(-49) > 0);
  assert.ok(valueWeightCdf(49) < 1);
});
