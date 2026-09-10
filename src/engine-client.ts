/**
 * The main thread's view of the analysis engine.
 *
 * Owns the worker, the four lifecycle states the session view has to be able to
 * show (§5.2), and an `Evaluator` that the existing queue drains without
 * knowing any of it. Nothing above this line imports the engine, and this file
 * imports it only through `new Worker(new URL(...))` — which is what keeps
 * TensorFlow.js out of the main bundle.
 *
 * **Failure degrades, it does not end.** A missing WebGPU, a failed download, a
 * network that will not parse: all of them leave the session running and the
 * summary reporting exact match only, with a plain statement of why. That is
 * the same shape a session with AI switched off has, so it is the path most
 * likely to be right — and the replay evaluator exercises it without breaking
 * a network.
 */

import type { EngineConfig, Verdict } from './analysis.ts';
import { EvaluationError, type Evaluator, type Prompt } from './evaluator.ts';
import type { Game } from './game.ts';
import { isMobile } from './device.ts';
import { serialize } from './sgf-writer.ts';
import { NETWORK, networkUrl } from './engine/network.ts';
import { NETWORK_BYTES } from './engine/net-cache.ts';
import type { WorkerReply, WorkerRequest } from './engine/worker.ts';

/** Visits per search, and not a preference: see `docs/katago-feasibility.md` §5. */
export const VISITS = 50;

/**
 * Failed prompts in a row before scoring is called dead rather than unlucky.
 *
 * One failure is not fatal and never has been — a single search can hit a
 * position the engine refuses and the summary simply reports what it has. A
 * *run* of them is a different event: the engine has stopped, and every later
 * prompt will fail too. Without this the session goes on asking, the errors are
 * dropped one at a time, and the only visible trace is a summary quietly
 * missing its last fifty moves.
 *
 * Three, because two in a row is within reach of coincidence and the cost of
 * being late by one prompt is nothing. The count resets on any verdict, so a
 * scattered failure never accumulates into a false alarm.
 */
export const ERRORS_BEFORE_FAILED = 3;

/**
 * What the session view shows about the engine.
 *
 * `downloading` carries a fraction rather than a percentage because the
 * fraction can legitimately exceed 1 — a host that inflates on the way in
 * reports the compressed length against an inflated body (`net-cache.ts`) — and
 * clamping is the view's decision, not this module's.
 */
export type EngineStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'downloading'; readonly received: number; readonly total: number | null }
  | { readonly state: 'warming' }
  | { readonly state: 'ready' }
  | { readonly state: 'failed'; readonly reason: string };

export interface EngineHandle {
  readonly evaluator: Evaluator;
  readonly status: () => EngineStatus;
  /**
   * Re-read one move's line at a larger budget, resolving to the line or to
   * null.
   *
   * Null is the ordinary outcome, not a failure: the pass gives way to any
   * scoring prompt, and an engine that is not up declines quietly. Nothing here
   * ever rejects, because nothing about a longer line is worth interrupting a
   * reader over.
   */
  readonly deepen: (
    moveNumber: number,
    point: number | null,
    visits: number,
  ) => Promise<readonly number[] | null>;
  /** Stop the worker and release the GPU. Safe to call twice. */
  readonly stop: () => void;
}

/** A reading of what the worker holds, as `worker.ts` reports it. */
export type EngineMemory = Extract<WorkerReply, { type: 'memory' }>;

export interface EngineOptions {
  /** Called whenever the status changes, so the view can redraw. */
  readonly onStatus?: (status: EngineStatus) => void;
  /**
   * Called once, with what the engine turned out to be running on. Separate
   * from `onStatus` because it is not a state: it is a fact about the run that
   * the store keeps, and it arrives when the backend does.
   */
  readonly onDevice?: (device: string) => void;
  /**
   * What the worker holds, after every prompt.
   *
   * For a harness watching a long run: whether live bytes climb is the whole
   * of the leak-or-high-water-mark question, and one reading cannot answer it.
   * The product ignores this — a failure already carries the two readings that
   * matter (`lastWords`).
   */
  readonly onMemory?: (reading: EngineMemory) => void;
}

/**
 * Why a record cannot be scored, or null if it can.
 *
 * Square boards only, and it is the V7 feature encoding that says so rather
 * than a policy: it indexes by one board dimension (PRD §12, design §7). Said
 * here, once, so the setup view can explain the absence instead of offering a
 * toggle that fails later.
 */
export function unscorableReason(game: Game): string | null {
  if (game.cols !== game.rows) {
    return `AI scoring needs a square board, and this record is ${game.cols}x${game.rows}.`;
  }
  return null;
}

/** The engine that produced a set of verdicts, for the record a score carries. */
export function engineConfig(): EngineConfig {
  // Null until the worker has a backend to ask; `onReady` carries the answer.
  return { network: NETWORK.label, visits: VISITS, backend: 'webgpu', device: null };
}

/**
 * Why scoring may not finish here, or null where nothing is known against it.
 *
 * Not a refusal, unlike `unscorableReason` — the toggle stays on and the
 * download stays offered. A phone can score a session and often does; it can
 * also run its GPU out partway through, and the engine's own checks then stop
 * it rather than let it answer. Said before the download starts, because the
 * download is the part that cannot be taken back.
 *
 * It used to warn that a phone may compute the network incorrectly, which was
 * true of one and is no longer true of any: the fault was a readback this build
 * now pads past (`aligned-read.ts`), and a device that still disagrees with the
 * reference is refused at load rather than believed. What is left is memory and
 * time, which are the phone's own.
 */
export function unreliableReason(): string | null {
  if (!isMobile()) return null;
  return (
    'A phone can run its GPU out partway through a long game. Scoring stops ' +
    'when that happens, and the review covers only the moves it reached.'
  );
}

/** Roughly how much there is to download, for copy written before it starts. */
export const DOWNLOAD_BYTES: number = NETWORK_BYTES;

export function startEngine(game: Game, options: EngineOptions = {}): EngineHandle {
  let status: EngineStatus = { state: 'idle' };
  let stopped = false;

  const setStatus = (next: EngineStatus): void => {
    status = next;
    options.onStatus?.(next);
  };

  /*
   * `new URL('./engine/worker.ts', import.meta.url)` and not a bare specifier.
   * Vite rewrites this form to the hashed, base-pathed asset URL; a string
   * specifier survives `npm run dev` and 404s under `/lituus/`, which is
   * exactly the class of failure the deployment spike existed to find (§10b).
   */
  const worker = new Worker(new URL('./engine/worker.ts', import.meta.url), {
    type: 'module',
  });

  /** Prompts awaiting a verdict, keyed by move number. */
  const waiting = new Map<
    number,
    { resolve: (verdict: Verdict) => void; reject: (error: unknown) => void }
  >();

  /** Deepening passes awaiting a line, keyed by move number. */
  const deepening = new Map<number, (pv: readonly number[] | null) => void>();

  /** Failed prompts since the last verdict; see `ERRORS_BEFORE_FAILED`. */
  let consecutiveErrors = 0;

  /**
   * What the worker said about its memory, first and last, kept for its
   * obituary. Null until the engine is up.
   *
   * Both, because one reading cannot answer the question a kill raises. A
   * worker holding what it started with was killed by something other than its
   * own appetite; one holding six times that grew into the ceiling, and the
   * pool's allocated total says whether the growth was live tensors or freed
   * buffers kept around.
   */
  let firstReading: EngineMemory | null = null;
  let lastReading: EngineMemory | null = null;

  const failEverything = (reason: string): void => {
    for (const { reject } of waiting.values()) reject(new EvaluationError(reason));
    waiting.clear();
    // A dead engine will not be deepening anything either, and a promise that
    // never settles would keep the scheduler waiting for a worker that is gone.
    for (const settle of deepening.values()) settle(null);
    deepening.clear();
  };

  worker.onmessage = (event: MessageEvent<WorkerReply>): void => {
    const reply: WorkerReply = event.data;
    switch (reply.type) {
      case 'progress':
        setStatus({ state: 'downloading', received: reply.received, total: reply.total });
        return;
      case 'warming':
        setStatus({ state: 'warming' });
        return;
      case 'ready':
        options.onDevice?.(reply.device);
        setStatus({ state: 'ready' });
        return;
      case 'failed':
        setStatus({ state: 'failed', reason: reply.reason });
        // Anything already asked for will never be answered, so say so now
        // rather than leaving the queue holding promises that cannot settle.
        failEverything(reply.reason);
        return;
      case 'memory':
        firstReading ??= reply;
        lastReading = reply;
        options.onMemory?.(reply);
        return;
      case 'verdict': {
        consecutiveErrors = 0;
        waiting.get(reply.verdict.moveNumber)?.resolve(reply.verdict);
        waiting.delete(reply.verdict.moveNumber);
        return;
      }
      case 'deepened': {
        deepening.get(reply.moveNumber)?.(reply.pv);
        deepening.delete(reply.moveNumber);
        return;
      }
      case 'error': {
        waiting.get(reply.moveNumber)?.reject(new EvaluationError(reply.reason));
        waiting.delete(reply.moveNumber);
        // A run of them means the engine is gone, not that these positions
        // were awkward. The last reason is the reason: they are all the same
        // failure arriving once per prompt.
        if (++consecutiveErrors >= ERRORS_BEFORE_FAILED) {
          setStatus({ state: 'failed', reason: reply.reason });
          failEverything(reply.reason);
        }
        return;
      }
    }
  };

  /**
   * What the engine was holding when it stopped, if it ever said.
   *
   * Appended to the failure because the failure is the only thing that reaches
   * a reader — the status line, and the incident the export records. A kill
   * with no reading behind it is silent about why, and the phone is exactly
   * where that question keeps being asked (`TODO`: leak or high-water mark).
   */
  const lastWords = (): string => {
    if (!lastReading || !firstReading) return '';
    const mb = (bytes: number): string => `${Math.round(bytes / 1e6)}MB`;
    return (
      ` It was holding ${mb(lastReading.gpuBytes)} in ${lastReading.tensors} ` +
      `tensors ${lastReading.prompts} moves in, against ` +
      `${mb(firstReading.gpuBytes)} in ${firstReading.tensors} at the start; ` +
      `${mb(lastReading.gpuAllocated)} ever allocated.`
    );
  };

  // A worker that dies outright — an out-of-memory kill on a phone is the
  // realistic case — reports nothing else, so this is the only place that
  // failure becomes visible.
  worker.onerror = (event: ErrorEvent): void => {
    const reason: string =
      (event.message || 'The analysis worker stopped unexpectedly.') + lastWords();
    setStatus({ state: 'failed', reason });
    failEverything(reason);
  };

  const request: WorkerRequest = {
    type: 'init',
    // Serialized from the source tree, so the worker reads the same record
    // through the same parser rather than being handed a second model of it.
    sgf: serialize([game.source]),
    networkUrl: networkUrl(),
    visits: VISITS,
  };
  setStatus({ state: 'downloading', received: 0, total: null });
  worker.postMessage(request);

  const evaluator: Evaluator = {
    config: engineConfig(),
    evaluate: (prompt: Prompt): Promise<Verdict> => {
      if (stopped) return Promise.reject(new EvaluationError('Scoring was stopped.'));
      if (status.state === 'failed') {
        return Promise.reject(new EvaluationError(status.reason));
      }
      return new Promise<Verdict>((resolve, reject) => {
        waiting.set(prompt.moveNumber, { resolve, reject });
        const evaluateRequest: WorkerRequest = {
          type: 'evaluate',
          moveNumber: prompt.moveNumber,
          played: prompt.played,
          ...(prompt.guess === undefined ? {} : { guess: prompt.guess }),
        };
        worker.postMessage(evaluateRequest);
      });
    },
  };

  return {
    evaluator,
    status: (): EngineStatus => status,
    deepen: (
      moveNumber: number,
      point: number | null,
      visits: number,
    ): Promise<readonly number[] | null> => {
      if (stopped || status.state !== 'ready') return Promise.resolve(null);
      // One pass per move at a time. A second request for a move already in
      // flight would orphan the first promise, and the reply carries only a
      // move number to settle it with.
      if (deepening.has(moveNumber)) return Promise.resolve(null);
      return new Promise<readonly number[] | null>((resolve) => {
        deepening.set(moveNumber, resolve);
        const deepenRequest: WorkerRequest = { type: 'deepen', moveNumber, point, visits };
        worker.postMessage(deepenRequest);
      });
    },
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      failEverything('Scoring was stopped.');
      worker.terminate();
    },
  };
}
