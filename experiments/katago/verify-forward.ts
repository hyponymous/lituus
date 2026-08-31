/**
 * Does our forward pass agree with the network it claims to be running?
 *
 *   node experiments/katago/verify-forward.ts \
 *     --net experiments/nets/<net>.bin.gz \
 *     --truth test/fixtures/net-b15c192.json \
 *     test/fixtures/2024-07-09d.sgf
 *
 * Step 4 of `docs/design-ai-scoring.md` §12. The ground truth comes from
 * `groundtruth.ts`, which asks native KataGo for one visit — one forward pass —
 * so a disagreement here is the graph or the input planes and nothing else. Put
 * a search in between and the same disagreement could be any of three things.
 *
 * Lives here rather than in `test/` because it needs the network, which is 37 MB
 * and git-ignored. CI checks the parts that do not: the planes, and the
 * postprocessing arithmetic.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-cpu';
import { parse } from '../../src/sgf-parser.ts';
import { readGame, type Game, type GameMove } from '../../src/game.ts';
import { parseKataGoModelV8 } from '../../src/engine/load-model-v8.ts';
import { ModelV8, postprocess, type Evaluation, type Judgement } from '../../src/engine/model-v8.ts';
import {
  BLACK,
  WHITE,
  createBoard,
  fromPosition,
  passMove,
  type Board,
  type BoardState,
  type Stone,
} from '../../src/engine/board.ts';
import {
  createLadderInputs,
  createLadderScratch,
  ladderInputs,
  type LadderInputs,
  type LadderScratch,
} from '../../src/engine/ladder.ts';
import {
  buildFeatures,
  createFeatureScratch,
  type FeatureScratch,
  type Inputs,
  type RecentMove,
} from '../../src/engine/features-v7.ts';

interface Truth {
  readonly komi: number;
  readonly boardXSize: number;
  readonly positions: ReadonlyArray<{
    readonly turn: number;
    readonly toPlay: string;
    readonly policy: readonly number[];
    readonly winrate: number;
    readonly scoreLead: number;
  }>;
}

function parseArgs(argv: readonly string[]): { net: string; truth: string; file: string } {
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags.set(argv[i].slice(2), argv[++i]);
    else rest.push(argv[i]);
  }
  const net: string | undefined = flags.get('net');
  const truth: string | undefined = flags.get('truth');
  if (!net || !truth || rest.length !== 1) {
    throw new Error('usage: verify-forward.ts --net <net> --truth <json> <game.sgf>');
  }
  return { net, truth, file: rest[0] };
}

/** The five moves before `turn`, chronological, as the history planes want them. */
function historyBefore(game: Game, board: Board, turn: number): RecentMove[] {
  const out: RecentMove[] = [];
  for (let i = Math.max(0, turn - 5); i < turn; i++) {
    const move: GameMove = game.moves[i];
    out.push({
      move: move.index ?? passMove(board),
      player: move.color === 1 ? BLACK : WHITE,
    });
  }
  return out;
}

/** Softmax over the legal points, so ours is comparable with KataGo's policy. */
function policyProbabilities(
  evaluation: Evaluation,
  state: BoardState,
  area: number,
): Float32Array {
  const out = new Float32Array(area + 1);
  let highest = -Infinity;
  for (let point = 0; point < area; point++) {
    if (state.stones[point] !== 0) continue;
    highest = Math.max(highest, evaluation.policy[point]);
  }
  highest = Math.max(highest, evaluation.policyPass);

  let total = 0;
  for (let point = 0; point < area; point++) {
    if (state.stones[point] !== 0) {
      out[point] = -1;
      continue;
    }
    const value: number = Math.exp(evaluation.policy[point] - highest);
    out[point] = value;
    total += value;
  }
  const pass: number = Math.exp(evaluation.policyPass - highest);
  out[area] = pass;
  total += pass;

  for (let i = 0; i <= area; i++) if (out[i] >= 0) out[i] /= total;
  return out;
}

async function main(): Promise<void> {
  const { net, truth: truthPath, file } = parseArgs(process.argv.slice(2));
  await tf.setBackend('cpu');
  await tf.ready();

  const truth = JSON.parse(readFileSync(truthPath, 'utf8')) as Truth;
  const game: Game = readGame(parse(readFileSync(file, 'utf8')));
  const board: Board = createBoard(game.cols, game.rows);
  const scratch: FeatureScratch = createFeatureScratch(board);

  console.log(`parsing ${net.split('/').pop()}`);
  const parsed = parseKataGoModelV8(gunzipSync(readFileSync(net)));
  const model = new ModelV8(tf, parsed);
  console.log(`${model.name}, version ${model.version}\n`);

  const ladderScratch: LadderScratch = createLadderScratch(board);
  const ladders: LadderInputs = createLadderInputs(board);

  let worstPolicy = 0;
  let worstWinrate = 0;
  let worstLead = 0;

  for (const expected of truth.positions) {
    const move: GameMove = game.moves[expected.turn];
    const state: BoardState = fromPosition(board, move.before);
    const toPlay: Stone = move.color === 1 ? BLACK : WHITE;

    // Planes 14-17. The two earlier boards are the positions this game was in
    // one and two moves ago; before the third move there are none, and
    // `ladderInputs` falls back the way KataGo does.
    const prev: BoardState | undefined =
      expected.turn >= 1 ? fromPosition(board, game.moves[expected.turn - 1].before) : undefined;
    const prevPrev: BoardState | undefined =
      expected.turn >= 2 ? fromPosition(board, game.moves[expected.turn - 2].before) : undefined;
    ladderInputs(board, state, prev, prevPrev, toPlay, ladderScratch, ladders);

    const inputs: Inputs = buildFeatures(
      {
        board,
        state,
        toPlay,
        history: historyBefore(game, board, expected.turn),
        komi: truth.komi,
        ruleset: 'territory',
        ladders,
      },
      scratch,
    );

    const started: number = performance.now();
    const evaluation: Evaluation = model.evaluate(inputs.spatial, inputs.global, game.cols);
    const ms: number = performance.now() - started;
    const judgement: Judgement = postprocess(
      evaluation.value,
      evaluation.scoreValue,
      model.postProcess,
    );
    const ours: Float32Array = policyProbabilities(evaluation, state, board.area);

    // The largest single-point disagreement, which is the figure that matters:
    // an average would hide one badly-placed move among 361 quiet ones.
    let policyError = 0;
    let at = -1;
    for (let i = 0; i <= board.area; i++) {
      if (expected.policy[i] < 0 || ours[i] < 0) continue;
      const delta: number = Math.abs(ours[i] - expected.policy[i]);
      if (delta > policyError) {
        policyError = delta;
        at = i;
      }
    }

    const winrateError: number = Math.abs(judgement.winrate - expected.winrate);
    const leadError: number = Math.abs(judgement.scoreLead - expected.scoreLead);
    worstPolicy = Math.max(worstPolicy, policyError);
    worstWinrate = Math.max(worstWinrate, winrateError);
    worstLead = Math.max(worstLead, leadError);

    const topOurs: number = ours.indexOf(Math.max(...ours));
    const topTheirs: number = expected.policy.indexOf(Math.max(...expected.policy));

    console.log(
      `turn ${String(expected.turn).padStart(3)} ${expected.toPlay}  ` +
        `policy Δmax ${policyError.toFixed(6)} at ${at}  ` +
        `top ${topOurs === topTheirs ? 'agree' : `DIFFER ${topOurs} vs ${topTheirs}`}  ` +
        `winrate Δ ${winrateError.toFixed(6)}  lead Δ ${leadError.toFixed(4)}  ${ms.toFixed(0)}ms`,
    );
  }

  console.log(
    `\nworst: policy ${worstPolicy.toFixed(6)}, winrate ${worstWinrate.toFixed(6)}, ` +
      `lead ${worstLead.toFixed(4)}`,
  );
  model.dispose();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
