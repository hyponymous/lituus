/**
 * §9.1: run our search in a real browser and hand the results back to Node.
 *
 * The bar this is built to test is **not** that the two searches agree move for
 * move. Two PUCT searches with different floating-point orderings will not, and
 * KataGo's reference runs were made with eight threads whose visit order is not
 * reproducible even by KataGo. The bar is that the *point losses* agree closely
 * enough that the PRD's thresholds keep meaning what they were measured to
 * mean, which is what `run-conformance.ts` reports on.
 *
 * This runs in the page rather than a worker on purpose. A worker is what will
 * ship (§12 step 6) and is one more thing to be wrong while the numbers are
 * still being established; nothing here is waiting on the main thread.
 */

import * as tf from '@tensorflow/tfjs-core';
import { createBoard, type Board } from '../../../src/engine/board.ts';
import { evaluatePrompt, gameContext, type GameContext } from '../../../src/engine/evaluate.ts';
import { parseKataGoModelV8 } from '../../../src/engine/load-model-v8.ts';
import type { ParsedKataGoModelV8 } from '../../../src/engine/model-types.ts';
import { ModelV8 } from '../../../src/engine/model-v8.ts';
import { Search } from '../../../src/engine/search.ts';
import { readGame, type Game, type GameMove } from '../../../src/game.ts';
import { parse } from '../../../src/sgf-parser.ts';
import type { Verdict } from '../../../src/analysis.ts';
import type { Prompt } from '../../../src/evaluator.ts';
import { pointFromName, pointName } from '../../../src/goban.ts';

/** Gzip's magic bytes. Sniffed, never assumed — see `src/spike.ts`. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

export interface ConformanceRequest {
  readonly modelUrl: string;
  readonly sgf: string;
  readonly visits: number;
  /** Turn indices to search, and the move actually played at each, as a GTP name. */
  readonly turns: ReadonlyArray<{ readonly turn: number; readonly played: string }>;
}

export interface ConformanceRow {
  readonly turn: number;
  readonly moveNumber: number;
  readonly rootScoreLead: number;
  readonly rootVisits: number;
  readonly best: string;
  readonly bestScoreLead: number;
  readonly played: string;
  readonly pointLoss: number | null;
  readonly playedVisits: number | null;
  readonly playedForced: boolean | null;
  readonly topPolicy: string;
  readonly topPolicyPrior: number;
  readonly topPolicyLoss: number;
  readonly ms: number;
}

export interface ConformanceResult {
  readonly adapter: string;
  readonly backend: string | null;
  readonly model: string;
  readonly loadMs: number;
  readonly rows: ConformanceRow[];
  readonly error?: string;
}

declare global {
  interface Window {
    __lituusConformance?: (request: ConformanceRequest) => Promise<ConformanceResult>;
  }
}

/**
 * Report to the page *and* to the console, because the driver forwards console
 * messages and a two-hundred-position run is twelve silent minutes otherwise —
 * indistinguishable from a hang, which is the failure this harness most needs
 * to be able to tell apart from slowness.
 */
const log = (text: string): void => {
  console.log(text);
  const node: HTMLElement | null = document.getElementById('log');
  if (node) node.textContent = `${node.textContent}\n${text}`.trim();
};

/**
 * The adapter, asked directly.
 *
 * A software adapter answers `requestAdapter()` happily and then measures the
 * CPU — the trap `experiments/browser/README.md` documents, which is why this
 * run is headed and why the adapter is part of every result.
 */
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

/**
 * Fetch the network and inflate it if — and only if — it arrived compressed.
 *
 * The sniff is load-bearing and was measured, not guessed: `vite preview` sends
 * `Content-Encoding: gzip` so the browser inflates on the way in, while GitHub
 * Pages sends no such header and the bytes stay compressed. Hardcoding either
 * assumption passes its own tests and breaks on the other host
 * (`docs/design-ai-scoring.md` §10b.3).
 */
async function loadNetwork(url: string): Promise<Uint8Array> {
  const response: Response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  const raw = new Uint8Array(await response.arrayBuffer());
  if (raw[0] !== GZIP_MAGIC[0] || raw[1] !== GZIP_MAGIC[1]) {
    log(`network arrived already inflated (${raw.length} bytes)`);
    return raw;
  }
  const stream: ReadableStream<Uint8Array> = new Blob([raw as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  const inflated = new Uint8Array(await new Response(stream).arrayBuffer());
  log(`network inflated ${raw.length} → ${inflated.length} bytes`);
  return inflated;
}

async function run(request: ConformanceRequest): Promise<ConformanceResult> {
  const adapter: string = await describeAdapter();
  log(`adapter: ${adapter}`);

  const startedLoad: number = performance.now();
  await import('@tensorflow/tfjs-backend-webgpu');
  await tf.setBackend('webgpu');
  await tf.ready();
  const data: Uint8Array = await loadNetwork(request.modelUrl);
  const parsed: ParsedKataGoModelV8 = parseKataGoModelV8(data);
  const model = new ModelV8(tf, parsed);
  const loadMs: number = performance.now() - startedLoad;
  log(`${parsed.modelName} ready in ${loadMs.toFixed(0)}ms`);

  const game: Game = readGame(parse(request.sgf));
  const board: Board = createBoard(game.cols, game.rows);
  const context: GameContext = gameContext(game);
  const search = new Search(model, context.board);

  const rows: ConformanceRow[] = [];
  for (const { turn, played } of request.turns) {
    const move: GameMove | undefined = game.moves[turn];
    if (!move || move.index === null) continue;
    const playedPoint: number | null = pointFromName(move.before, played);
    if (playedPoint === null) continue;

    // The guess is set to the played move, so the second search is the one the
    // product runs on a hit and no third search is paid for. What is being
    // compared here is the root search and the forced search, and a distinct
    // guess would only add a third number the reference files do not carry.
    const prompt: Prompt = {
      moveNumber: move.number,
      position: move.before,
      color: move.color,
      played: playedPoint,
      guess: playedPoint,
    };

    const started: number = performance.now();
    const verdict: Verdict = evaluatePrompt(search, context, prompt, request.visits);
    const ms: number = performance.now() - started;

    rows.push({
      turn,
      moveNumber: verdict.moveNumber,
      rootScoreLead: verdict.rootScoreLead,
      rootVisits: verdict.rootVisits,
      best: pointName(move.before, verdict.best.point),
      bestScoreLead: verdict.best.scoreLead,
      played,
      pointLoss: verdict.played?.loss ?? null,
      playedVisits: verdict.played?.visits ?? null,
      playedForced: verdict.played?.forced ?? null,
      topPolicy: verdict.natural ? pointName(move.before, verdict.natural.point) : '',
      topPolicyPrior: verdict.natural?.prior ?? 0,
      topPolicyLoss: verdict.natural?.loss ?? 0,
      ms,
    });
    const done: ConformanceRow = rows[rows.length - 1];
    log(
      `turn ${turn} (${rows.length}/${request.turns.length}): ` +
        `loss ${done.pointLoss?.toFixed(3) ?? 'none'}` +
        `${done.playedForced ? ' forced' : ''} in ${ms.toFixed(0)}ms`,
    );
  }

  model.dispose();
  return { adapter, backend: tf.getBackend() ?? null, model: parsed.modelName, loadMs, rows };
}

window.__lituusConformance = async (
  request: ConformanceRequest,
): Promise<ConformanceResult> => {
  try {
    return await run(request);
  } catch (error: unknown) {
    const detail: string = error instanceof Error ? error.stack ?? error.message : String(error);
    log(`FAILED: ${detail}`);
    return { adapter: '', backend: null, model: '', loadMs: 0, rows: [], error: detail };
  }
};

log('ready');
