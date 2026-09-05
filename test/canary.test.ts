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
import {
  Canary,
  CANARY_TOLERANCE,
  canaryHeads,
  canaryInputs,
  type CanaryModel,
} from '../src/engine/canary.ts';
import {
  EXPECTED_HEADS,
  EXPECTED_SIZE,
  EXPECTED_TOLERANCE,
} from '../src/engine/canary-expected.ts';
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

// ── Against a device known to be right ───────────────────────────────────────

/**
 * An evaluation whose heads are exactly some head vector — the reference
 * answer by default. The policy is flat and sums to the recorded total, which
 * is all `canaryHeads` reads of it.
 */
function fromHeads(heads: readonly number[]): Evaluation {
  const area: number = EXPECTED_SIZE * EXPECTED_SIZE;
  const policy = new Float32Array(area);
  policy.fill(heads[8] / area);
  return {
    policy,
    policyPass: heads[7],
    value: Float32Array.from(heads.slice(0, 3)),
    scoreValue: Float32Array.from(heads.slice(3, 7)),
  };
}

const expectedEvaluation = (): Evaluation => fromHeads(EXPECTED_HEADS);

test('a device that lands on the baked answer is accepted', () => {
  const model: CanaryModel = { evaluate: () => expectedEvaluation() };
  const canary = new Canary(model, EXPECTED_SIZE);

  assert.ok(canary.against(EXPECTED_HEADS) <= EXPECTED_TOLERANCE);
});

test('a device that agrees with itself and not with the reference is caught', () => {
  // The case the drift check cannot see, and the one that actually happened:
  // two phone sessions, three days apart, bit-identical to each other and tens
  // of points from the laptop on the same build.
  const model: CanaryModel = {
    evaluate: () => {
      const wrong = expectedEvaluation();
      wrong.value[0] += 1;
      return wrong;
    },
  };
  const canary = new Canary(model, EXPECTED_SIZE);

  assert.equal(canary.drift(), 0, 'consistent with itself');
  assert.ok(canary.against(EXPECTED_HEADS) > EXPECTED_TOLERANCE, 'and still refused');
});

test('the baked answer covers every head, not just the first', () => {
  // The heads are read out of one buffer at computed offsets, so a device — or
  // a change to the packing — that damages only the tail must still be caught.
  for (let head = 0; head < EXPECTED_HEADS.length; head++) {
    const model: CanaryModel = {
      evaluate: (): Evaluation => {
        const wrong = expectedEvaluation();
        const shifted: Float32Array = canaryHeads(wrong);
        shifted[head] += 10 * (1 + Math.abs(shifted[head]));
        return fromHeads(Array.from(shifted));
      },
    };
    const canary = new Canary(model, EXPECTED_SIZE);
    assert.ok(
      canary.against(EXPECTED_HEADS) > EXPECTED_TOLERANCE,
      `head ${head} was not compared`,
    );
  }
});

test('the fixed input is built for the board the answer was baked at', () => {
  const inputs = canaryInputs(EXPECTED_SIZE * EXPECTED_SIZE);
  assert.equal(inputs.spatial.length, EXPECTED_SIZE * EXPECTED_SIZE * 22);
  assert.equal(inputs.global.length, 19);
});
