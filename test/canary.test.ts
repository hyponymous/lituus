/**
 * The canary: does a device that has started lying get caught?
 *
 * These are the cases that mattered in the dogfood session this exists because
 * of — the numbers stayed finite and plausibly-shaped, and every existing guard
 * let them through. A stand-in model stands in for the GPU, since the failure
 * being tested is one no working GPU will reproduce on demand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Canary, CANARY_TOLERANCE, type CanaryModel } from '../src/engine/canary.ts';
import type { Evaluation } from '../src/engine/model-v8.ts';

const SIZE = 9;

/**
 * A model whose answer is a deterministic function of its input, plus whatever
 * `shift` is at the time — which is how a device that has drifted behaves, and
 * nothing like a device that has died.
 */
function stub(): { model: CanaryModel; shift: (by: number) => void; calls: () => number } {
  let offset = 0;
  let calls = 0;
  const model: CanaryModel = {
    evaluate: (spatial: Float32Array, global: Float32Array, size: number): Evaluation => {
      calls++;
      let sum = 0;
      for (const value of spatial) sum += value;
      for (const value of global) sum += value;
      const policy = new Float32Array(size * size);
      policy.fill(sum / policy.length + offset);
      return {
        policy,
        policyPass: sum + offset,
        value: Float32Array.from([sum, -sum, 0.5 + offset]),
        scoreValue: Float32Array.from([sum / 2, 1, sum / 3 + offset, 1]),
      };
    },
  };
  return { model, shift: (by: number): void => { offset = by; }, calls: (): number => calls };
}

test('a device still giving the same answer passes', () => {
  const { model } = stub();
  const canary = new Canary(model, SIZE);
  canary.verify();
  assert.equal(canary.drift(), 0);
});

test('the baseline is taken by evaluating once, at construction', () => {
  // Which is also the shader warmup, so the first prompt of a session does not
  // pay for it.
  const { model, calls } = stub();
  new Canary(model, SIZE);
  assert.equal(calls(), 1);
});

test('an answer that has moved past the tolerance is refused', () => {
  const { model, shift } = stub();
  const canary = new Canary(model, SIZE);

  shift(10);
  assert.throws(() => canary.verify(), /stopped giving consistent results/);
});

test('the refusal quotes how far it drifted', () => {
  // The number is the evidence. A reason with no figure in it is unfalsifiable
  // by whoever reads the export a month later.
  const { model, shift } = stub();
  const canary = new Canary(model, SIZE);

  shift(10);
  assert.throws(() => canary.verify(), /drift \d/);
});

test('floating-point noise below the tolerance is not a failure', () => {
  const { model, shift } = stub();
  const canary = new Canary(model, SIZE);

  shift(CANARY_TOLERANCE / 100);
  canary.verify();
});

test('the same fixed input is used every time', () => {
  // The whole check rests on it: a canary that varied its own input would be
  // comparing two different questions and calling the difference corruption.
  const seen: string[] = [];
  const model: CanaryModel = {
    evaluate: (spatial: Float32Array, global: Float32Array, size: number): Evaluation => {
      seen.push(`${spatial.join()}|${global.join()}|${size}`);
      return {
        policy: new Float32Array(size * size),
        policyPass: 1,
        value: Float32Array.from([1, 2, 3]),
        scoreValue: Float32Array.from([1, 2, 3, 4]),
      };
    },
  };
  const canary = new Canary(model, SIZE);
  canary.drift();
  canary.drift();

  assert.equal(seen.length, 3);
  assert.equal(new Set(seen).size, 1);
});

test('a corrupt policy is caught even when the value head is intact', () => {
  // The heads are read out of one buffer, and a partial corruption is the kind
  // that survives every other check.
  let broken = false;
  const model: CanaryModel = {
    evaluate: (_spatial: Float32Array, _global: Float32Array, size: number): Evaluation => {
      const policy = new Float32Array(size * size);
      policy.fill(broken ? 4 : 1);
      return {
        policy,
        policyPass: 0.25,
        value: Float32Array.from([1, 2, 3]),
        scoreValue: Float32Array.from([1, 2, 3, 4]),
      };
    },
  };
  const canary = new Canary(model, SIZE);

  broken = true;
  assert.throws(() => canary.verify(), /stopped giving consistent results/);
});
