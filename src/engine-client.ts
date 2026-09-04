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
  /** Stop the worker and release the GPU. Safe to call twice. */
  readonly stop: () => void;
}

export interface EngineOptions {
  /** Called whenever the status changes, so the view can redraw. */
  readonly onStatus?: (status: EngineStatus) => void;
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
  return { network: NETWORK.label, visits: VISITS, backend: 'webgpu' };
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

  /** Failed prompts since the last verdict; see `ERRORS_BEFORE_FAILED`. */
  let consecutiveErrors = 0;

  const failEverything = (reason: string): void => {
    for (const { reject } of waiting.values()) reject(new EvaluationError(reason));
    waiting.clear();
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
        setStatus({ state: 'ready' });
        return;
      case 'failed':
        setStatus({ state: 'failed', reason: reply.reason });
        // Anything already asked for will never be answered, so say so now
        // rather than leaving the queue holding promises that cannot settle.
        failEverything(reply.reason);
        return;
      case 'verdict': {
        consecutiveErrors = 0;
        waiting.get(reply.verdict.moveNumber)?.resolve(reply.verdict);
        waiting.delete(reply.verdict.moveNumber);
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

  // A worker that dies outright — an out-of-memory kill on a phone is the
  // realistic case — reports nothing else, so this is the only place that
  // failure becomes visible.
  worker.onerror = (event: ErrorEvent): void => {
    const reason: string = event.message || 'The analysis worker stopped unexpectedly.';
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
          guess: prompt.guess,
        };
        worker.postMessage(evaluateRequest);
      });
    },
  };

  return {
    evaluator,
    status: (): EngineStatus => status,
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      failEverything('Scoring was stopped.');
      worker.terminate();
    },
  };
}
