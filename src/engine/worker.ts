/**
 * The analysis worker: the only place TensorFlow.js is ever imported.
 *
 * Two reasons it is a worker rather than a module on the main thread, and
 * neither is throughput. First, a search is **synchronous** — fifty forward
 * passes with a tree walk between them, and on the main thread that is two
 * seconds during which the page cannot repaint or accept a click. PRD §3
 * promises analysis never blocks the reveal, and §5.1 says that promise is
 * structural rather than a scheduling policy; running the search where the
 * reveal is drawn would make it a scheduling policy again.
 *
 * Second, `import`ing TensorFlow.js is a megabyte. The worker is constructed
 * only when AI scoring is switched on, and it dynamic-imports the backend, so a
 * session with AI off fetches none of it (measured: `docs/design-ai-scoring.md`
 * §10b.3 — main bundle 31.9kB with zero TF references).
 *
 * The protocol is deliberately small. The worker is told the record once and
 * asked about move numbers after that, so no `Position` is ever serialized and
 * the two sides cannot disagree about what game they are discussing.
 */

import type * as TF from '@tensorflow/tfjs-core';
import type { Verdict } from '../analysis.ts';
import type { Prompt } from '../evaluator.ts';
import { readGame, type Game, type GameMove } from '../game.ts';
import { parse } from '../sgf-parser.ts';
import { evaluatePrompt, gameContext, type GameContext } from './evaluate.ts';
import { parseKataGoModelV8 } from './load-model-v8.ts';
import type { ParsedKataGoModelV8 } from './model-types.ts';
import { ModelV8 } from './model-v8.ts';
import { loadNetworkBytes, type Progress } from './net-cache.ts';
import { Search } from './search.ts';

/** Main thread to worker. */
export type WorkerRequest =
  | {
      readonly type: 'init';
      readonly sgf: string;
      readonly networkUrl: string;
      readonly visits: number;
    }
  | {
      readonly type: 'evaluate';
      readonly moveNumber: number;
      readonly played: number;
      readonly guess: number;
    };

/** Worker to main thread. */
export type WorkerReply =
  | { readonly type: 'progress'; readonly received: number; readonly total: number | null }
  | { readonly type: 'warming' }
  | { readonly type: 'ready'; readonly network: string; readonly backend: string }
  | { readonly type: 'failed'; readonly reason: string }
  | { readonly type: 'verdict'; readonly verdict: Verdict }
  | { readonly type: 'error'; readonly moveNumber: number; readonly reason: string };

/*
 * Under the DOM lib `self` types as a `Window`, whose `postMessage` wants a
 * target origin it has no business having here. Pulling in the WebWorker lib
 * instead collides with DOM across the rest of the project, so the worker's
 * global is narrowed in the one file that needs it — the same accommodation
 * `spike-worker.ts` makes.
 */
const scope = self as unknown as {
  postMessage(message: WorkerReply): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

const post = (reply: WorkerReply): void => scope.postMessage(reply);

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface Engine {
  readonly search: Search;
  readonly context: GameContext;
  readonly visits: number;
}

let engine: Engine | null = null;
/** Set once init fails, so every later request answers instead of hanging. */
let broken: string | null = null;
/** Serializes work: `evaluate` messages can arrive while `init` is still running. */
let queue: Promise<void> = Promise.resolve();

async function initialize(request: Extract<WorkerRequest, { type: 'init' }>): Promise<void> {
  const game: Game = readGame(parse(request.sgf));
  const context: GameContext = gameContext(game);

  const bytes: Uint8Array = await loadNetworkBytes(request.networkUrl, {
    onProgress: (progress: Progress): void =>
      post({ type: 'progress', received: progress.received, total: progress.total }),
  });

  post({ type: 'warming' });

  /*
   * WebGPU or nothing.
   *
   * The WASM backend is single-threaded here and always will be: GitHub Pages
   * cannot set headers at all, so no COOP/COEP, so no `SharedArrayBuffer`
   * (§10b). A single-threaded WASM search of a 15-block network is far too slow
   * to be worth offering, and offering it would mean quoting point losses that
   * arrive after the summary. No WebGPU degrades to exact match, which is the
   * same outcome as a failed download and is already handled.
   */
  const tf: typeof TF = await import('@tensorflow/tfjs-core');
  await import('@tensorflow/tfjs-backend-webgpu');
  if (!(await tf.setBackend('webgpu'))) {
    throw new Error('This browser has no WebGPU, so scoring is unavailable.');
  }
  await tf.ready();

  const parsed: ParsedKataGoModelV8 = parseKataGoModelV8(bytes);
  const model = new ModelV8(tf, parsed);
  engine = { search: new Search(model, context.board), context, visits: request.visits };

  post({ type: 'ready', network: parsed.modelName, backend: tf.getBackend() });
}

function evaluate(request: Extract<WorkerRequest, { type: 'evaluate' }>): void {
  if (!engine) {
    post({
      type: 'error',
      moveNumber: request.moveNumber,
      reason: broken ?? 'The engine is not ready.',
    });
    return;
  }
  const move: GameMove | undefined = engine.context.game.moves.find(
    (candidate: GameMove) => candidate.number === request.moveNumber,
  );
  if (!move) {
    post({
      type: 'error',
      moveNumber: request.moveNumber,
      reason: `Move ${request.moveNumber} is not in this record.`,
    });
    return;
  }
  const prompt: Prompt = {
    moveNumber: request.moveNumber,
    position: move.before,
    color: move.color,
    played: request.played,
    guess: request.guess,
  };
  const verdict: Verdict = evaluatePrompt(
    engine.search, engine.context, prompt, engine.visits,
  );
  post({ type: 'verdict', verdict });
}

scope.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const request: WorkerRequest = event.data;
  // One chain, so a prompt that arrives mid-download waits for the network
  // rather than racing it, and two searches never share the GPU. Errors are
  // reported and swallowed: the chain must survive one bad request.
  queue = queue.then(async (): Promise<void> => {
    try {
      if (request.type === 'init') await initialize(request);
      else evaluate(request);
    } catch (error: unknown) {
      const reason: string = message(error);
      if (request.type === 'init') {
        broken = reason;
        post({ type: 'failed', reason });
      } else {
        post({ type: 'error', moveNumber: request.moveNumber, reason });
      }
    }
  });
};
