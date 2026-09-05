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
import { describeDevice } from '../device.ts';
import { parse } from '../sgf-parser.ts';
import { Canary, WRONG_DEVICE } from './canary.ts';
import { EXPECTED_HEADS, EXPECTED_SIZE, EXPECTED_TOLERANCE } from './canary-expected.ts';
import { evaluatePrompt, gameContext, type GameContext } from './evaluate.ts';
import { parseKataGoModelV8 } from './load-model-v8.ts';
import type { ParsedKataGoModelV8 } from './model-types.ts';
import { ModelV8 } from './model-v8.ts';
import { forgetNetwork, loadNetworkBytes, type Progress } from './net-cache.ts';
import { checkWeights, type WeightsCheck } from './weights-check.ts';
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
      /** Board indices, or null for a pass, exactly as `Prompt` carries them. */
      readonly played: number | null;
      readonly guess: number | null;
    };

/** Worker to main thread. */
export type WorkerReply =
  | { readonly type: 'progress'; readonly received: number; readonly total: number | null }
  | { readonly type: 'warming' }
  | {
      readonly type: 'ready';
      readonly network: string;
      readonly backend: string;
      /** The GPU and platform, for the record a score carries. */
      readonly device: string;
    }
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
  readonly canary: Canary;
}

/**
 * Prompts between canary checks.
 *
 * A forward pass against a session's own work is nothing — one pass out of the
 * fifty a single search makes, so under a fiftieth of a check's worth of GPU
 * every eight prompts. Eight rather than one because the failure this catches
 * is a device going bad and staying bad, not a single unlucky pass, and eight
 * prompts is well under a minute of play: the point is to stop before a
 * summary is built on nonsense, not to find the exact move it started.
 */
const CANARY_EVERY = 8;

/** Prompts answered since the last canary check. */
let sinceCanary = 0;

let engine: Engine | null = null;
/** Set once init fails, so every later request answers instead of hanging. */
let broken: string | null = null;
/** Serializes work: `evaluate` messages can arrive while `init` is still running. */
let queue: Promise<void> = Promise.resolve();

/**
 * Say so when the GPU goes away, instead of quietly scoring with a dead one.
 *
 * A lost `GPUDevice` throws nothing. Work submitted to it is dropped and every
 * readback comes back zeroed, which `isDegenerate` in `model-v8.ts` catches one
 * prompt at a time — but only once a prompt is asked, and only as a per-move
 * error. The device itself knows the moment it happens and knows why, so this
 * is the one place the reason can be reported at all.
 *
 * A device destroyed on the way out is our own teardown, not a failure.
 */
function watchForDeviceLoss(tf: typeof TF): void {
  /*
   * The WebGPU backend holds its `GPUDevice` as a public field, but the type
   * lives in `@tensorflow/tfjs-backend-webgpu`, which this module imports for
   * its side effect alone — importing its types here would pull the backend
   * into the type graph of every file that touches the worker. Hence the
   * assertion, written to tolerate a backend that has no device at all.
   */
  const backend = tf.backend() as unknown as { readonly device?: GPUDevice };
  const device: GPUDevice | undefined = backend.device;
  if (!device) return;
  void device.lost.then((info: GPUDeviceLostInfo): void => {
    if (info.reason === 'destroyed') return;
    engine = null;
    broken = info.message
      ? `The GPU stopped: ${info.message}`
      : 'The GPU stopped, so scoring is unavailable.';
    post({ type: 'failed', reason: broken });
  });
}

async function initialize(request: Extract<WorkerRequest, { type: 'init' }>): Promise<void> {
  const game: Game = readGame(parse(request.sgf));
  const context: GameContext = gameContext(game);

  let bytes: Uint8Array = await loadNetworkBytes(request.networkUrl, {
    onProgress: (progress: Progress): void =>
      post({ type: 'progress', received: progress.received, total: progress.total }),
  });

  /*
   * The weights, checked against the hash `network.ts` pins.
   *
   * A completed download is not an intact one, and until this was added the
   * only checks were the compressed length and the first sixty-four bytes
   * looking like a KataGo header. A body damaged after that parses, evaluates,
   * and returns numbers that are finite, stable and wrong — which is exactly
   * what a phone did for two whole sessions.
   *
   * A bad copy is evicted and fetched again before giving up, because the
   * damaged bytes were being kept: the Cache API holds the network between
   * visits, so a copy that arrived wrong once is re-read on every later visit
   * and the obvious remedy — reload the page — changes nothing.
   */
  let weights: WeightsCheck = await checkWeights(bytes);
  if (!weights.matches) {
    await forgetNetwork(request.networkUrl);
    bytes = await loadNetworkBytes(request.networkUrl, {
      onProgress: (progress: Progress): void =>
        post({ type: 'progress', received: progress.received, total: progress.total }),
    });
    weights = await checkWeights(bytes);
  }
  if (!weights.matches) {
    throw new Error(
      'The engine network did not arrive intact, twice over, so scoring is ' +
        `unavailable. (${weights.bytes.toLocaleString('en-US')} bytes, ` +
        `sha256 ${weights.sha256.slice(0, 16)}…)`,
    );
  }

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
  watchForDeviceLoss(tf);

  const parsed: ParsedKataGoModelV8 = parseKataGoModelV8(bytes);
  const model = new ModelV8(tf, parsed);
  // Constructed before the engine is published, because taking the baseline is
  // also the first forward pass: if the device cannot do one at all, this is
  // where that is found, and the session never sees a ready engine.
  const canary = new Canary(model, EXPECTED_SIZE);
  sinceCanary = 0;

  /*
   * Correctness before consistency, and before a single prompt is answered.
   *
   * The canary's own check asks whether this device still agrees with itself,
   * which a device that was wrong from the start passes perfectly — a phone did
   * exactly that for two whole sessions. This compares it with a machine shown
   * to agree with native KataGo, and refuses the whole engine rather than
   * quoting numbers from a device that computes something else. The throw is
   * caught by the message loop, which reports it as a failure: the session
   * carries on and the summary reports exact match only, the same degradation a
   * failed download produces.
   *
   * At `EXPECTED_SIZE` regardless of the record's board, because the baked
   * answer is that size's answer. The extra pass is the largest board there is
   * and costs one forward pass, once.
   */
  const off: number = canary.against(EXPECTED_HEADS);
  if (off > EXPECTED_TOLERANCE) {
    throw new Error(`${WRONG_DEVICE} (off by ${off.toExponential(2)})`);
  }

  engine = { search: new Search(model, context.board), context, visits: request.visits, canary };

  post({
    type: 'ready',
    network: parsed.modelName,
    backend: tf.getBackend(),
    // Asked for after the backend is up, so the adapter reported is the one
    // that was actually chosen rather than one this call went and requested.
    device: await describeDevice(),
  });
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
  // Before the search, not after: a drifted device has already produced this
  // prompt's answer wrongly, and answering it anyway is how the last one got
  // exported. The throw is caught by the message loop and reported as an error,
  // which `ERRORS_BEFORE_FAILED` turns into a stopped engine.
  if (sinceCanary >= CANARY_EVERY) {
    sinceCanary = 0;
    engine.canary.verify();
  }
  sinceCanary++;

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
