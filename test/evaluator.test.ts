/**
 * Queue tests: ordering, deduplication, failure, and stopping.
 *
 * All four are invisible on screen. A queue that re-runs a position wastes GPU
 * a user paid for; one that stops on the first failure silently truncates the
 * summary; one that reports after the session is gone writes into a dead
 * screen. None of those look like bugs while you are watching.
 *
 * Everything here runs against a hand-written evaluator, which is the point of
 * the interface: no engine, no worker, no GPU.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, EvaluationError, type Evaluator, type Prompt, type Queue } from '../src/evaluator.ts';
import { createPosition, BLACK, type Position } from '../src/rules.ts';
import type { EngineConfig, Verdict } from '../src/analysis.ts';

const CONFIG: EngineConfig = { network: 'test', visits: 50, backend: 'test' };
const BOARD: Position = createPosition(19, 19);

function prompt(moveNumber: number): Prompt {
  return { moveNumber, position: BOARD, color: BLACK, played: 60, guess: 61 };
}

function verdictFor(moveNumber: number): Verdict {
  return {
    moveNumber,
    rootScoreLead: 0,
    rootVisits: 55,
    best: { point: 60, scoreLead: 0, pv: [] },
    played: null,
    guessed: null,
    natural: null,
  };
}

/** An evaluator that records what it was asked, and answers on demand. */
function recording(behavior: (prompt: Prompt) => Promise<Verdict> = (p) =>
  Promise.resolve(verdictFor(p.moveNumber)),
): { evaluator: Evaluator; asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    evaluator: {
      config: CONFIG,
      evaluate: (p: Prompt): Promise<Verdict> => {
        asked.push(p.moveNumber);
        return behavior(p);
      },
    },
  };
}

/** Let the queue's microtasks and timers run to completion. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

// ── Ordering and completion ──────────────────────────────────────────────────

test('every submitted prompt is evaluated, in submission order', async () => {
  const { evaluator, asked } = recording();
  const got: number[] = [];
  const queue: Queue = createQueue(evaluator, { onVerdict: (v) => got.push(v.moveNumber) });

  for (const n of [1, 3, 5]) queue.submit(prompt(n));
  await settle();

  assert.deepEqual(asked, [1, 3, 5]);
  assert.deepEqual(got, [1, 3, 5]);
});

test('one evaluation runs at a time', async () => {
  let inFlight = 0;
  let peak = 0;
  const { evaluator } = recording(async (p: Prompt) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await settle();
    inFlight--;
    return verdictFor(p.moveNumber);
  });
  const queue: Queue = createQueue(evaluator, { onVerdict: () => {} });

  for (const n of [1, 2, 3]) queue.submit(prompt(n));
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(peak, 1);
});

test('pending falls to zero once the queue has drained', async () => {
  const { evaluator } = recording();
  const queue: Queue = createQueue(evaluator, { onVerdict: () => {} });

  queue.submit(prompt(1));
  queue.submit(prompt(2));
  assert.ok(queue.pending() > 0);

  await settle();
  assert.equal(queue.pending(), 0);
});

// ── Deduplication ────────────────────────────────────────────────────────────

test('a move already submitted is not evaluated twice', async () => {
  // This is what makes a same-colour replay nearly free: the positions are the
  // same, so the expensive root searches are already done.
  const { evaluator, asked } = recording();
  const queue: Queue = createQueue(evaluator, { onVerdict: () => {} });

  queue.submit(prompt(4));
  queue.submit(prompt(4));
  await settle();
  queue.submit(prompt(4));
  await settle();

  assert.deepEqual(asked, [4]);
});

// ── Failure ──────────────────────────────────────────────────────────────────

test('a failed evaluation is reported and the queue carries on', async () => {
  const { evaluator, asked } = recording((p: Prompt) =>
    p.moveNumber === 2
      ? Promise.reject(new EvaluationError('no verdict'))
      : Promise.resolve(verdictFor(p.moveNumber)),
  );
  const failures: number[] = [];
  const got: number[] = [];
  const queue: Queue = createQueue(evaluator, {
    onVerdict: (v) => got.push(v.moveNumber),
    onError: (p) => failures.push(p.moveNumber),
  });

  for (const n of [1, 2, 3]) queue.submit(prompt(n));
  await settle();

  assert.deepEqual(asked, [1, 2, 3]);
  assert.deepEqual(got, [1, 3]);
  assert.deepEqual(failures, [2]);
});

test('a failure with no error handler is swallowed rather than thrown', async () => {
  // The session must survive an engine that cannot answer. An unhandled
  // rejection here would take the page down mid-game.
  const { evaluator } = recording(() => Promise.reject(new EvaluationError('nope')));
  const queue: Queue = createQueue(evaluator, { onVerdict: () => {} });

  queue.submit(prompt(1));
  await settle();
  assert.equal(queue.pending(), 0);
});

// ── Stopping ─────────────────────────────────────────────────────────────────

test('stopping discards what is waiting and reports nothing further', async () => {
  const { evaluator, asked } = recording(async (p: Prompt) => {
    await settle();
    return verdictFor(p.moveNumber);
  });
  const got: number[] = [];
  const queue: Queue = createQueue(evaluator, { onVerdict: (v) => got.push(v.moveNumber) });

  for (const n of [1, 2, 3]) queue.submit(prompt(n));
  queue.stop();
  await new Promise((resolve) => setTimeout(resolve, 60));

  // The first was already in flight; nothing after it starts, and its own
  // verdict is dropped rather than delivered to a screen that has gone.
  assert.deepEqual(asked, [1]);
  assert.deepEqual(got, []);
});

test('a prompt submitted after stopping is ignored', async () => {
  const { evaluator, asked } = recording();
  const queue: Queue = createQueue(evaluator, { onVerdict: () => {} });

  queue.stop();
  queue.submit(prompt(1));
  await settle();

  assert.deepEqual(asked, []);
});

test('the queue names the move in flight, and nothing between searches', async () => {
  // The only way a failure arriving on the engine rather than on a prompt — a
  // lost device — can be recorded against a position in the game.
  let answer: (verdict: Verdict) => void = () => {};
  const { evaluator } = recording(
    () =>
      new Promise<Verdict>((resolve) => {
        answer = resolve;
      }),
  );
  const queue: Queue = createQueue(evaluator, { onVerdict: () => {} });

  assert.equal(queue.current(), null);
  queue.submit(prompt(12));
  // While the search is still outstanding, which is when a device is lost.
  assert.equal(queue.current(), 12);

  answer(verdictFor(12));
  await settle();
  assert.equal(queue.current(), null);
});
