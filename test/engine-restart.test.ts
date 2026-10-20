/**
 * Restarting the engine when its worker dies.
 *
 * A phone kills a worker that runs it out of memory and loses a GPU device
 * under pressure, and until this existed either one ended scoring for the
 * session. What is tested here is the judgement in `startEngine`: which deaths
 * are worth a new worker, what the new one is asked, and when to stop trying.
 * None of it needs a real worker, so a fake one stands in and dies on cue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Verdict } from '../src/analysis.ts';
import {
  CLEAN_TO_FORGIVE,
  RESTARTS_ALLOWED,
  startEngine,
  type Deepened,
  type EngineHandle,
  type Spawn,
} from '../src/engine-client.ts';
import type { WorkerReply, WorkerRequest } from '../src/engine/worker.ts';
import type { Prompt } from '../src/evaluator.ts';
import { readGame, type Game } from '../src/game.ts';
import { BLACK, createPosition } from '../src/rules.ts';
import { parse } from '../src/sgf-parser.ts';

const GAME: Game = readGame(parse('(;SZ[9];B[cc];W[dd];B[ee];W[ff])'));

const READY: WorkerReply = { type: 'ready', network: 'test', backend: 'webgpu', device: 'test' };

function prompt(moveNumber: number): Prompt {
  return { moveNumber, position: createPosition(9, 9), color: BLACK, played: 20, guess: 21 };
}

function verdictFor(moveNumber: number): WorkerReply {
  const verdict: Verdict = {
    moveNumber,
    rootScoreLead: 0,
    rootVisits: 55,
    best: { point: 20, scoreLead: 0, pv: [] },
    played: null,
    guessed: null,
    natural: null,
  };
  return { type: 'verdict', verdict };
}

/** One fake worker: what it was asked, and a way to make it speak or die. */
interface FakeWorker {
  readonly posted: WorkerRequest[];
  terminated: boolean;
  readonly reply: (reply: WorkerReply) => void;
  readonly die: () => void;
}

interface Harness {
  readonly engine: EngineHandle;
  readonly workers: FakeWorker[];
  readonly statuses: string[];
  readonly restarts: { readonly move: number | null; readonly reason: string }[];
  readonly latest: () => FakeWorker;
}

function harness(isCached: () => Promise<boolean> = () => Promise.resolve(true)): Harness {
  const workers: FakeWorker[] = [];
  const statuses: string[] = [];
  const restarts: { readonly move: number | null; readonly reason: string }[] = [];
  const spawn: Spawn = (onReply, onDeath) => {
    const posted: WorkerRequest[] = [];
    const fake: FakeWorker = {
      posted,
      terminated: false,
      reply: onReply,
      // An outright kill says nothing, which is the case worth testing.
      die: (): void => onDeath(''),
    };
    workers.push(fake);
    return {
      post: (request: WorkerRequest): void => void posted.push(request),
      terminate: (): void => {
        fake.terminated = true;
      },
    };
  };
  const engine: EngineHandle = startEngine(GAME, {
    spawn,
    isCached,
    networkUrl: 'network.bin.gz',
    onStatus: (status): void => void statuses.push(status.state),
    onRestart: (restart): void => void restarts.push(restart),
  });
  const latest = (): FakeWorker => {
    const last: FakeWorker | undefined = workers[workers.length - 1];
    assert.ok(last, 'a worker should have been spawned');
    return last;
  };
  return { engine, workers, statuses, restarts, latest };
}

/** Let the cache check and any settled promises run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const kinds = (worker: FakeWorker): string[] => worker.posted.map((request) => request.type);

test('a worker killed mid-prompt is replaced, and the prompt asked again', async () => {
  const h: Harness = harness();
  h.latest().reply(READY);
  const answer: Promise<Verdict> = h.engine.evaluator.evaluate(prompt(2));
  h.latest().die();
  await settle();

  assert.equal(h.workers.length, 2);
  assert.equal(h.workers[0].terminated, true);
  assert.deepEqual(kinds(h.workers[1]), ['init', 'evaluate']);
  h.workers[1].reply(READY);
  h.workers[1].reply(verdictFor(2));
  assert.equal((await answer).moveNumber, 2);

  // Never through `failed`: main.ts records that as where scoring stopped.
  assert.ok(!h.statuses.includes('failed'), h.statuses.join(', '));
  assert.ok(h.statuses.includes('restarting'));
  assert.equal(h.restarts.length, 1);
  assert.equal(h.restarts[0].move, 2);
  assert.match(h.restarts[0].reason, /stopped unexpectedly/);
});

test('nothing a replaced worker says afterwards is heard', async () => {
  const h: Harness = harness();
  h.latest().reply(READY);
  void h.engine.evaluator.evaluate(prompt(2));
  h.workers[0].die();
  await settle();

  h.workers[0].reply({ type: 'failed', reason: 'late', retryable: false });
  h.workers[0].die();
  await settle();
  assert.equal(h.workers.length, 2);
  assert.ok(!h.statuses.includes('failed'));
});

test('a death before the engine was ever ready is final', async () => {
  const h: Harness = harness();
  const answer: Promise<Verdict> = h.engine.evaluator.evaluate(prompt(2));
  h.latest().die();
  await assert.rejects(answer, /stopped unexpectedly/);
  await settle();
  assert.equal(h.workers.length, 1);
  assert.equal(h.statuses.at(-1), 'failed');
  assert.equal(h.restarts.length, 0);
});

test('a device that dies under a prompt restarts at once, rather than after three', async () => {
  const h: Harness = harness();
  h.latest().reply(READY);
  const answer: Promise<Verdict> = h.engine.evaluator.evaluate(prompt(2));
  h.latest().reply({ type: 'error', moveNumber: 2, reason: 'dead readback', retryable: true });
  await settle();

  assert.equal(h.workers.length, 2);
  h.latest().reply(READY);
  h.latest().reply(verdictFor(2));
  assert.equal((await answer).moveNumber, 2);
});

test('an error about the prompt rejects that prompt and restarts nothing', async () => {
  const h: Harness = harness();
  h.latest().reply(READY);
  const answer: Promise<Verdict> = h.engine.evaluator.evaluate(prompt(2));
  h.latest().reply({ type: 'error', moveNumber: 2, reason: 'not in record', retryable: false });
  await assert.rejects(answer, /not in record/);
  assert.equal(h.workers.length, 1);
  assert.equal(h.engine.status().state, 'ready');
});

test('a replaced worker that dies before it is up is retried against the budget', async () => {
  const h: Harness = harness();
  h.latest().reply(READY);
  const first: Promise<Verdict> = h.engine.evaluator.evaluate(prompt(2));
  h.latest().die();
  await settle();
  // The replacement dies during its own init, with move 2 still in flight:
  // a second death under it, so it is skipped rather than asked a third time.
  h.latest().die();
  await assert.rejects(first, /stopped twice/);
  assert.equal(h.engine.status().state, 'restarting');

  const next: Promise<Verdict> = h.engine.evaluator.evaluate(prompt(3));
  await settle();
  assert.equal(h.workers.length, 3);
  h.latest().reply(READY);
  h.latest().reply(verdictFor(3));
  assert.equal((await next).moveNumber, 3);
  assert.equal(h.restarts.length, 2);
});

test('a replaced worker reporting its lost device is not heard either', async () => {
  const h: Harness = harness();
  h.latest().reply(READY);
  void h.engine.evaluator.evaluate(prompt(2));
  h.workers[0].die();
  await settle();
  h.workers[0].reply({ type: 'failed', reason: 'The GPU stopped', retryable: true });
  await settle();
  assert.equal(h.workers.length, 2);
  assert.equal(h.restarts.length, 1);
});

test('a failure the worker marks final is not retried', async () => {
  // A drifted canary: the same device would drift again.
  const h: Harness = harness();
  h.latest().reply(READY);
  const answer: Promise<Verdict> = h.engine.evaluator.evaluate(prompt(2));
  h.latest().reply({ type: 'failed', reason: 'drifted', retryable: false });
  await assert.rejects(answer, /drifted/);
  await settle();
  assert.equal(h.workers.length, 1);
  assert.equal(h.workers[0].terminated, true);
  assert.equal(h.engine.status().state, 'failed');
});

test('a lost device restarts', async () => {
  const h: Harness = harness();
  h.latest().reply(READY);
  void h.engine.evaluator.evaluate(prompt(2));
  h.latest().reply({ type: 'failed', reason: 'The GPU stopped', retryable: true });
  await settle();
  assert.equal(h.workers.length, 2);
  assert.equal(h.engine.status().state, 'restarting');
});

test('no restart once the network has left the cache, since it would download again', async () => {
  const h: Harness = harness(() => Promise.resolve(false));
  h.latest().reply(READY);
  const answer: Promise<Verdict> = h.engine.evaluator.evaluate(prompt(2));
  h.latest().die();
  await assert.rejects(answer, /download it again/);
  assert.equal(h.workers.length, 1);
  assert.equal(h.engine.status().state, 'failed');
});

test('a move in flight at two deaths is skipped, and scoring carries on without it', async () => {
  const h: Harness = harness();
  h.latest().reply(READY);
  const poisoned: Promise<Verdict> = h.engine.evaluator.evaluate(prompt(2));
  h.latest().die();
  await settle();
  h.latest().reply(READY);
  h.latest().die();
  await assert.rejects(poisoned, /stopped twice while scoring move 2/);

  // Nothing is waiting, so no worker is built until something is.
  await settle();
  assert.equal(h.workers.length, 2);
  const next: Promise<Verdict> = h.engine.evaluator.evaluate(prompt(3));
  await settle();
  assert.equal(h.workers.length, 3);
  assert.deepEqual(kinds(h.latest()), ['init', 'evaluate']);
  h.latest().reply(READY);
  h.latest().reply(verdictFor(3));
  assert.equal((await next).moveNumber, 3);
});

/** Ask about one move, kill the worker under it, and let the next one answer. */
async function dieUnder(h: Harness, moveNumber: number): Promise<void> {
  const answer: Promise<Verdict> = h.engine.evaluator.evaluate(prompt(moveNumber));
  h.latest().die();
  await settle();
  h.latest().reply(READY);
  h.latest().reply(verdictFor(moveNumber));
  await answer;
}

test('the restart budget runs out', async () => {
  const h: Harness = harness();
  h.latest().reply(READY);
  for (let restart = 0; restart < RESTARTS_ALLOWED; restart++) await dieUnder(h, 100 + restart);

  const last: Promise<Verdict> = h.engine.evaluator.evaluate(prompt(200));
  h.latest().die();
  await assert.rejects(last, new RegExp(`restarted ${RESTARTS_ALLOWED} times`));
  assert.equal(h.engine.status().state, 'failed');
  assert.equal(h.workers.length, RESTARTS_ALLOWED + 1);
});

test('a long stretch of clean verdicts earns the budget back', async () => {
  const h: Harness = harness();
  h.latest().reply(READY);
  for (let restart = 0; restart < RESTARTS_ALLOWED; restart++) await dieUnder(h, 100 + restart);

  for (let move = 0; move < CLEAN_TO_FORGIVE; move++) {
    const answer: Promise<Verdict> = h.engine.evaluator.evaluate(prompt(300 + move));
    h.latest().reply(verdictFor(300 + move));
    await answer;
  }
  await dieUnder(h, 400);
  assert.equal(h.engine.status().state, 'ready');
});

test('a death with nothing in flight waits for a prompt before rebuilding', async () => {
  const h: Harness = harness();
  h.latest().reply(READY);
  h.latest().reply({ type: 'failed', reason: 'The GPU stopped', retryable: true });
  await settle();
  assert.equal(h.workers.length, 1);
  assert.equal(h.engine.status().state, 'restarting');
  assert.equal(h.restarts[0].move, null);

  void h.engine.evaluator.evaluate(prompt(2));
  await settle();
  assert.equal(h.workers.length, 2);
});

test('a deepening pass in flight at a death comes back unread', async () => {
  const h: Harness = harness();
  h.latest().reply(READY);
  const line: Promise<Deepened | null> = h.engine.deepen(2, 20, 400);
  h.latest().die();
  assert.equal(await line, null);
  // And a pass is never what builds a new worker.
  assert.equal(await h.engine.deepen(3, 20, 400), null);
  await settle();
  assert.equal(h.workers.length, 1);
});

test('stopping during the cache check builds nothing', async () => {
  let answer: (cached: boolean) => void = () => {};
  const h: Harness = harness(() => new Promise<boolean>((resolve) => (answer = resolve)));
  h.latest().reply(READY);
  const asked: Promise<Verdict> = h.engine.evaluator.evaluate(prompt(2));
  h.latest().die();
  h.engine.stop();
  answer(true);
  await assert.rejects(asked, /stopped/);
  await settle();
  assert.equal(h.workers.length, 1);
});
