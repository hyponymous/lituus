/**
 * What a forward pass costs, and how much of it is getting the numbers back.
 *
 * `bench.ts` measures the *vendored* engine, to size the problem before there
 * was one of ours. This measures ours, and it exists for one question:
 * `dataSync` on the WebGPU backend is not a readback but a canvas round trip
 * (two fresh `OffscreenCanvas` WebGPU contexts, `drawImage`, `getImageData` —
 * see `isDegenerate` in `src/engine/model-v8.ts`), and `ModelV8.evaluate` does
 * it once per output head. Whether that is worth restructuring is a number, not
 * an opinion, and nothing measured it.
 *
 * Three figures, in increasing order of how much they are inferred:
 *
 * - **evalMs** — one `model.evaluate()`, the shipped path exactly as it is.
 *   This is the before/after number: change how many reads a pass makes and
 *   this moves, or the change was not worth making.
 * - **readMs** — one `dataSync()` of a GPU-resident tensor, at two sizes 90x
 *   apart: the policy's, and the smallest head's. Two sizes rather than one
 *   because what the driver wants is the *intercept*. Only the per-call part
 *   of a read can be won back by making fewer calls; the bytes have to cross
 *   either way.
 * - **promptMs** — one `evaluatePrompt` at the shipping visit count, which is
 *   the only figure here a user would recognize: it is what a prompt takes.
 *
 * Runs headed, for the reason `../README.md` gives — a headless Chromium
 * answers `requestAdapter()` with a software adapter and produces timings that
 * measure the CPU. The adapter is reported with every result.
 *
 * Ladder planes are left out of the feature build: they are CPU work that a
 * readback change cannot touch, and including them would put noise in the one
 * number this exists to move.
 */

import * as tf from '@tensorflow/tfjs-core';
import { createBoard, fromPosition, BLACK, WHITE, type Board, type Stone } from '../../../src/engine/board.ts';
import {
  evaluatePrompt,
  gameContext,
  historyBefore,
  movesBefore,
  type GameContext,
} from '../../../src/engine/evaluate.ts';
import { buildFeatures, createFeatureScratch, type FeatureScratch, type Inputs } from '../../../src/engine/features-v7.ts';
import { Canary } from '../../../src/engine/canary.ts';
import { parseKataGoModelV8 } from '../../../src/engine/load-model-v8.ts';
import type { ParsedKataGoModelV8 } from '../../../src/engine/model-types.ts';
import { ModelV8, type Evaluation } from '../../../src/engine/model-v8.ts';
import { Search } from '../../../src/engine/search.ts';
import { readGame, type Game, type GameMove } from '../../../src/game.ts';
import { parse } from '../../../src/sgf-parser.ts';
import type { Prompt } from '../../../src/evaluator.ts';

/** Gzip's magic bytes. Sniffed, never assumed — see `src/spike.ts`. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

export interface ReadbackRequest {
  readonly modelUrl: string;
  readonly sgf: string;
  /** Turn index whose position everything is measured on. */
  readonly turn: number;
  /** Forward passes per timed run, after the warmup. */
  readonly evals: number;
  /** Readbacks per timed run, at each size. */
  readonly reads: number;
  /** Visits for the one end-to-end prompt. Zero skips it. */
  readonly visits: number;
}

/** Milliseconds per operation, and the spread, which is most of the story. */
export interface Timing {
  readonly count: number;
  readonly meanMs: number;
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
}

export interface ReadbackResult {
  readonly adapter: string;
  readonly backend: string | null;
  readonly model: string;
  readonly loadMs: number;
  readonly warmupMs: number;
  /** One `model.evaluate()`, as the code stands. */
  readonly evaluate: Timing;
  /** One `dataSync()`, by tensor size. `floats` is what separates the two. */
  readonly reads: ReadonlyArray<{
    readonly label: string;
    readonly floats: number;
    readonly timing: Timing;
  }>;
  /**
   * How far the canary's fixed evaluation moved across the run, and what one
   * check costs. Zero is the expected drift on a healthy device.
   */
  readonly canaryDrift: number;
  readonly canaryMs: number;
  /**
   * The canary's own answer, full precision. This is where the baked
   * expectation in `src/engine/canary-expected.ts` comes from: a machine that
   * agrees with native KataGo, printed so it can be pasted.
   */
  readonly canaryHeads: readonly number[];
  /** One `evaluatePrompt` at `visits`, or null when it was skipped. */
  readonly promptMs: number | null;
  readonly promptVisits: number;
  readonly error?: string;
}

declare global {
  interface Window {
    __lituusReadback?: (request: ReadbackRequest) => Promise<ReadbackResult>;
  }
}

const log = (text: string): void => {
  console.log(text);
  const node: HTMLElement | null = document.getElementById('log');
  if (node) node.textContent = `${node.textContent}\n${text}`.trim();
};

/** As `conformance/main.ts`: a software adapter measures the CPU and is void. */
async function describeAdapter(): Promise<string> {
  if (!('gpu' in navigator)) return 'navigator.gpu absent';
  const adapter: GPUAdapter | null = await navigator.gpu.requestAdapter();
  if (!adapter) return 'requestAdapter() returned null';
  const either = adapter as GPUAdapter & {
    readonly info?: GPUAdapterInfo;
    readonly requestAdapterInfo?: () => Promise<GPUAdapterInfo>;
  };
  const info: GPUAdapterInfo | undefined = either.info ?? (await either.requestAdapterInfo?.());
  if (!info) return 'adapter present, no info API';
  const parts: string[] = [info.vendor, info.architecture, info.device, info.description].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  );
  return parts.length > 0 ? parts.join(' / ') : 'adapter present, no details exposed';
}

/** Fetch the network, inflating it only if it arrived compressed (§10b.3). */
async function loadNetwork(url: string): Promise<Uint8Array> {
  const response: Response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  const raw = new Uint8Array(await response.arrayBuffer());
  if (raw[0] !== GZIP_MAGIC[0] || raw[1] !== GZIP_MAGIC[1]) return raw;
  const stream: ReadableStream<Uint8Array> = new Blob([raw as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function summarize(samples: readonly number[]): Timing {
  const sorted: number[] = [...samples].sort((a, b) => a - b);
  const total: number = samples.reduce((sum, ms) => sum + ms, 0);
  return {
    count: samples.length,
    meanMs: total / samples.length,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
  };
}

/**
 * Big enough that the op producing the tensor is not quietly done on the CPU.
 *
 * The backend forwards an op to the CPU when every input is CPU-resident and
 * smaller than `WEBGPU_CPU_HANDOFF_SIZE_THRESHOLD`, which is 1000 elements
 * (`shouldExecuteOnCPU` in tfjs-backend-webgpu). A read of the result is then
 * a cached array lookup and takes 0.00ms — a measurement of nothing, reported
 * in the same units as a measurement of something. This source is over the
 * threshold, so the slice below runs on the GPU and has to come back from it,
 * which is the case the real graph is in: the policy is a slice of a tensor a
 * convolution just produced.
 */
const READ_SOURCE_SIZE = 4096;

/**
 * Time one `dataSync()` of a GPU-resident tensor of `size` floats, `count`
 * times.
 *
 * A fresh tensor per iteration, and that is the other trick: `readSync` caches
 * what it read on the CPU (`convertAndCacheOnCPU`), so a second read of the
 * same tensor is free and would also measure nothing.
 */
function timeReads(size: number, count: number): Timing {
  const source: tf.Tensor2D = tf.ones([1, READ_SOURCE_SIZE]);
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    const fresh: tf.Tensor2D = tf.slice(source, [0, i % 2], [1, size]);
    const started: number = performance.now();
    fresh.dataSync();
    samples.push(performance.now() - started);
    fresh.dispose();
  }
  source.dispose();
  const timing: Timing = summarize(samples);
  /*
   * A zero here is not a fast GPU, it is a read that never happened — the op
   * was forwarded to the CPU, or the values were cached. Refuse rather than
   * report it: a benchmark that prints 0.00ms and means "not measured" is
   * worse than no benchmark.
   */
  if (timing.medianMs <= 0) {
    throw new Error(
      `read of ${size} floats measured ${timing.medianMs}ms — the tensor was not on the GPU`,
    );
  }
  return timing;
}

async function run(request: ReadbackRequest): Promise<ReadbackResult> {
  const adapter: string = await describeAdapter();
  log(`adapter: ${adapter}`);

  const startedLoad: number = performance.now();
  await import('@tensorflow/tfjs-backend-webgpu');
  await tf.setBackend('webgpu');
  await tf.ready();
  const parsed: ParsedKataGoModelV8 = parseKataGoModelV8(await loadNetwork(request.modelUrl));
  const model = new ModelV8(tf, parsed);
  const loadMs: number = performance.now() - startedLoad;
  log(`${parsed.modelName} ready in ${loadMs.toFixed(0)}ms`);

  const game: Game = readGame(parse(request.sgf));
  const context: GameContext = gameContext(game);
  const board: Board = createBoard(game.cols, game.rows);
  const move: GameMove | undefined = game.moves[request.turn];
  if (!move) throw new Error(`turn ${request.turn} is not in this record`);

  const scratch: FeatureScratch = createFeatureScratch(board);
  const toPlay: Stone = move.color === 1 ? BLACK : WHITE;
  const inputs: Inputs = buildFeatures(
    {
      board,
      state: fromPosition(board, move.before),
      toPlay,
      history: historyBefore(game, board, request.turn),
      komi: context.komi,
      movesPlayed: movesBefore(game, request.turn),
      ruleset: context.ruleset,
    },
    scratch,
  );

  /*
   * The first pass compiles shaders and uploads the weights, and is tens of
   * times the cost of the second. Timed and reported rather than merely thrown
   * away: it is the pause a user sees when scoring starts.
   */
  const startedWarmup: number = performance.now();
  model.evaluate(inputs.spatial, inputs.global, board.cols);
  const warmupMs: number = performance.now() - startedWarmup;
  log(`first pass ${warmupMs.toFixed(0)}ms`);

  // Built here rather than at the end, so its baseline is taken from a device
  // that has only just started — which is where the worker takes it too.
  const canary = new Canary(model, board.cols);

  const evalSamples: number[] = [];
  for (let i = 0; i < request.evals; i++) {
    const started: number = performance.now();
    const evaluation: Evaluation = model.evaluate(inputs.spatial, inputs.global, board.cols);
    evalSamples.push(performance.now() - started);
    // Read one value so the optimizer cannot be accused of eliding the call.
    if (!Number.isFinite(evaluation.policyPass)) throw new Error('non-finite policy');
  }
  const evaluate: Timing = summarize(evalSamples);
  log(`forward pass ${evaluate.meanMs.toFixed(2)}ms mean over ${evaluate.count}`);

  // The shapes `evaluate` actually reads: the policy, and the smallest head.
  // Same call, two sizes, 361x apart in bytes — the comparison is the point.
  const area: number = board.cols * board.rows;
  const reads = [
    {
      label: `${area} floats, ${area * 4}B (policy)`,
      floats: area,
      timing: timeReads(area, request.reads),
    },
    { label: '4 floats, 16B (score)', floats: 4, timing: timeReads(4, request.reads) },
  ];
  for (const read of reads) log(`read ${read.label}: ${read.timing.meanMs.toFixed(2)}ms mean`);

  let promptMs: number | null = null;
  if (request.visits > 0 && move.index !== null) {
    const search = new Search(model, context.board);
    const prompt: Prompt = {
      moveNumber: move.number,
      position: move.before,
      color: move.color,
      played: move.index,
      guess: move.index,
    };
    const started: number = performance.now();
    evaluatePrompt(search, context, prompt, request.visits);
    promptMs = performance.now() - started;
    log(`prompt at ${request.visits} visits: ${(promptMs / 1000).toFixed(2)}s`);
  }

  /*
   * Last, deliberately: by here the device has done a few hundred forward
   * passes and a full search, which is the closest this harness gets to the
   * conditions a canary exists to detect. On a healthy device the drift is
   * exactly zero — the same input through the same graph is a deterministic
   * computation — so anything else printed here is a finding.
   */
  const startedCanary: number = performance.now();
  const canaryDrift: number = canary.drift();
  const canaryHeads: readonly number[] = Array.from(canary.heads);
  const canaryMs: number = performance.now() - startedCanary;
  log(`canary drift ${canaryDrift.toExponential(2)} in ${canaryMs.toFixed(1)}ms`);

  model.dispose();
  return {
    canaryDrift,
    canaryMs,
    canaryHeads,
    adapter,
    backend: tf.getBackend() ?? null,
    model: parsed.modelName,
    loadMs,
    warmupMs,
    evaluate,
    reads,
    promptMs,
    promptVisits: request.visits,
  };
}

window.__lituusReadback = async (request: ReadbackRequest): Promise<ReadbackResult> => {
  try {
    return await run(request);
  } catch (error: unknown) {
    const detail: string = error instanceof Error ? error.stack ?? error.message : String(error);
    log(`FAILED: ${detail}`);
    return {
      adapter: '',
      backend: null,
      model: '',
      loadMs: 0,
      warmupMs: 0,
      canaryDrift: 0,
      canaryMs: 0,
      canaryHeads: [],
      evaluate: { count: 0, meanMs: 0, medianMs: 0, minMs: 0, maxMs: 0 },
      reads: [],
      promptMs: null,
      promptVisits: 0,
      error: detail,
    };
  }
};

log('ready');
