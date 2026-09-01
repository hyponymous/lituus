/**
 * The smallest position our forward pass gets wrong, and what it takes to fix.
 *
 *   node experiments/katago/minimal-repro.ts --net experiments/nets/<net>.bin.gz
 *
 * One black stone on the board, White to play. That position disagrees with
 * KataGo by nearly a point of score lead; add a second stone and it is exact.
 * Everything the disagreement could plausibly be has been eliminated by
 * measurement — colour, komi, the analysis engine, the ladder planes — and
 * `docs/exploration-forward-pass-parity.md` §5.2 records how.
 *
 * The value of this position is that its input tensor is small enough to
 * exhaust rather than sample: a board mask, one opponent stone, one history
 * plane, and three non-zero globals. So rather than reason about which entry is
 * wrong, this perturbs each one in turn and reports any change that collapses
 * the error. Whatever the network wants that we are not giving it, a sweep this
 * small will name it.
 *
 * Use a small network. The bug is in what the network is shown, not in which
 * network it is, and `g170-b6c96` evaluates fast enough to sweep in a minute.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-cpu';
import { parseKataGoModelV8 } from '../../src/engine/load-model-v8.ts';
import { ModelV8, postprocess, type Evaluation, type Judgement } from '../../src/engine/model-v8.ts';
import {
  BLACK,
  WHITE,
  createBoard,
  emptyState,
  type Board,
  type BoardState,
  type Stone,
} from '../../src/engine/board.ts';
import {
  buildFeatures,
  createFeatureScratch,
  type Inputs,
  type RecentMove,
} from '../../src/engine/features-v7.ts';
import { rawNN, type Raw } from './raw-parity-game.ts';

const SIZE = 19;
const KOMI: number = (() => {
  const at: number = process.argv.indexOf('--komi');
  return at < 0 ? 8 : Number(process.argv[at + 1]);
})();
/** Q16, the stone the one-move case plays. */
const STONE = 3 * SIZE + 15;

/** A GTP point like "Q16" as a board index, row 0 at the top. */
function gtpIndex(point: string): number {
  const letters = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';
  const col: number = letters.indexOf(point[0].toUpperCase());
  return (SIZE - Number(point.slice(1))) * SIZE + col;
}

function parseNet(argv: readonly string[]): string {
  const at: number = argv.indexOf('--net');
  if (at < 0) throw new Error('need --net');
  return argv[at + 1];
}

/** How far one evaluation is from KataGo's, as a single number to minimize. */
interface Error_ {
  readonly policy: number;
  readonly winrate: number;
  readonly lead: number;
}

function compare(
  judgement: Judgement,
  evaluation: Evaluation,
  raw: Raw,
  state: BoardState,
  area: number,
  toPlay: Stone,
): Error_ {
  const black: boolean = toPlay === BLACK;
  const theirWinrate: number = black ? 1 - raw.whiteWin : raw.whiteWin;
  const theirLead: number = black ? -raw.whiteLead : raw.whiteLead;

  let highest = -Infinity;
  for (let point = 0; point < area; point++) {
    if (state.stones[point] === 0 && evaluation.policy[point] > highest) {
      highest = evaluation.policy[point];
    }
  }
  let total = 0;
  const ours = new Float32Array(area);
  for (let point = 0; point < area; point++) {
    if (state.stones[point] !== 0) continue;
    ours[point] = Math.exp(evaluation.policy[point] - highest);
    total += ours[point];
  }
  total += Math.exp(evaluation.policyPass - highest);

  let policy = 0;
  for (let point = 0; point < area; point++) {
    if (raw.policy[point] < 0 || state.stones[point] !== 0) continue;
    policy = Math.max(policy, Math.abs(ours[point] / total - raw.policy[point]));
  }
  return {
    policy,
    winrate: Math.abs(judgement.winrate - theirWinrate),
    lead: Math.abs(judgement.scoreLead - theirLead),
  };
}

async function main(): Promise<void> {
  const net: string = parseNet(process.argv.slice(2));
  await tf.setBackend('cpu');
  await tf.ready();

  const model = new ModelV8(tf, parseKataGoModelV8(gunzipSync(readFileSync(net))));
  const board: Board = createBoard(SIZE, SIZE);
  const scratch = createFeatureScratch(board);

  // One black stone, White to play — the smallest case that disagrees.
  const state: BoardState = emptyState(board);
  state.stones[STONE] = BLACK;
  const toPlay: Stone = WHITE;
  const history: RecentMove[] = [{ move: STONE, player: BLACK }];

  const raw: Raw = rawNN(net, KOMI, SIZE, ['play B Q16']);

  const built: Inputs = buildFeatures(
    { board, state, toPlay, history, komi: KOMI, movesPlayed: { black: 1, white: 0 }, ruleset: 'territory' },
    scratch,
  );
  // Copied out: `buildFeatures` returns views onto scratch, and the sweep needs
  // a pristine original to restore between trials.
  const spatial = new Float32Array(built.spatial);
  const global = new Float32Array(built.global);

  const evaluate = (s: Float32Array, g: Float32Array): Error_ => {
    const evaluation: Evaluation = model.evaluate(s, g, SIZE);
    const judgement: Judgement = postprocess(
      evaluation.value,
      evaluation.scoreValue,
      model.postProcess,
    );
    return compare(judgement, evaluation, raw, state, board.area, toPlay);
  };

  const base: Error_ = evaluate(spatial, global);
  console.log(`${model.name}`);
  console.log(
    `baseline  policy ${base.policy.toFixed(6)}  winrate ${base.winrate.toFixed(6)}  ` +
      `lead ${base.lead.toFixed(4)}\n`,
  );
  console.log('what KataGo says: whiteWin %s whiteLead %s', raw.whiteWin, raw.whiteLead);
  console.log('nonzero globals:', [...global].map((v, i) => (v ? `${i}=${v}` : '')).filter(Boolean).join(' '));
  console.log('');

  // A perturbation sweep was tried here first and produced only noise: the best
  // single change improved the lead while making the policy thirteen times
  // worse, which is what fitting a deep network's slack looks like. The
  // baseline policy error was already the smallest of every trial, so the input
  // is not one entry away from correct.
  //
  // What follows instead is the control that sweep skipped: the same comparison
  // down a move sequence, through one code path, so "exact at even, wrong at
  // odd" is established here rather than inherited from an earlier session.
  const sequence: Array<[string, string]> = [
    ['B', 'Q16'], ['W', 'D4'], ['B', 'Q4'], ['W', 'D16'], ['B', 'C3'], ['W', 'R5'],
  ];

  console.log('stones  to play   policy Δ    winrate Δ   lead Δ      ours / theirs');
  for (let n = 0; n <= sequence.length; n++) {
    const played = sequence.slice(0, n);
    const scan: BoardState = emptyState(board);
    const scanHistory: RecentMove[] = [];
    for (const [colour, point] of played) {
      const index: number = gtpIndex(point);
      const stone: Stone = colour === 'B' ? BLACK : WHITE;
      scan.stones[index] = stone;
      scanHistory.push({ move: index, player: stone });
    }
    const scanToPlay: Stone = n % 2 === 0 ? BLACK : WHITE;

    const scanRaw: Raw = rawNN(net, KOMI, SIZE, played.map(([c, p]) => `play ${c} ${p}`));
    const scanInputs: Inputs = buildFeatures(
      {
        board,
        state: scan,
        toPlay: scanToPlay,
        history: scanHistory.slice(-5),
        komi: KOMI,
        movesPlayed: {
          black: played.filter(([c]) => c === 'B').length,
          white: played.filter(([c]) => c === 'W').length,
        },
        ruleset: 'territory',
      },
      scratch,
    );
    const evaluation: Evaluation = model.evaluate(scanInputs.spatial, scanInputs.global, SIZE);
    const judgement: Judgement = postprocess(evaluation.value, evaluation.scoreValue, model.postProcess);
    const error: Error_ = compare(judgement, evaluation, scanRaw, scan, board.area, scanToPlay);
    const theirLead: number = scanToPlay === BLACK ? -scanRaw.whiteLead : scanRaw.whiteLead;

    console.log(
      `${String(n).padStart(6)}  ${scanToPlay === BLACK ? 'B' : 'W'}        ` +
        `${error.policy.toFixed(6)}    ${error.winrate.toFixed(6)}    ` +
        `${error.lead.toFixed(4).padStart(7)}     ` +
        `${judgement.scoreLead.toFixed(3)} / ${theirLead.toFixed(3)}`,
    );
  }

  model.dispose();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
