/**
 * The one decision in the model wrapper that is not a transcription: whether an
 * evaluation is worth believing at all.
 *
 * The graph itself is checked against KataGo's own numbers by
 * `experiments/katago/verify-forward.ts` and the golden dumps, both of which
 * need a network file and a backend. This needs neither, because it is the
 * check that runs when the backend has stopped working.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDegenerate, type Evaluation } from '../src/engine/model-v8.ts';

const evaluation = (over: Partial<Evaluation> = {}): Evaluation => ({
  policy: new Float32Array(361),
  policyPass: -3.5,
  value: new Float32Array([1.2, -0.8, -9.1]),
  scoreValue: new Float32Array([0.4, 0.9, 0.3, -1.1]),
  ...over,
});

test('an ordinary evaluation is believed', () => {
  assert.equal(isDegenerate(evaluation()), false);
});

test('a zeroed readback is refused', () => {
  // What a lost WebGPU device hands back: no error, every head zero. Left
  // unchecked it scores as "A19 is best and nothing costs a point".
  const dead: Evaluation = evaluation({
    policy: new Float32Array(361),
    policyPass: 0,
    value: new Float32Array(3),
    scoreValue: new Float32Array(4),
  });
  assert.equal(isDegenerate(dead), true);
});

test('a single zero among live outputs is not a failure', () => {
  // A head that lands on exactly zero is ordinary; all eight at once is not.
  assert.equal(isDegenerate(evaluation({ policyPass: 0 })), false);
  assert.equal(isDegenerate(evaluation({ value: new Float32Array([0, -0.8, -9.1]) })), false);
  assert.equal(
    isDegenerate(evaluation({ scoreValue: new Float32Array([0, 0, 0.3, 0]) })),
    false,
  );
});

test('a non-finite output is refused', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.equal(isDegenerate(evaluation({ value: new Float32Array([bad, -0.8, -9.1]) })), true);
    assert.equal(isDegenerate(evaluation({ policyPass: bad })), true);
  }
});
