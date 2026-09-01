/**
 * Our forward pass against the raw network, on positions from a real game.
 *
 *   node experiments/katago/raw-parity-game.ts \
 *     --net experiments/nets/<net>.bin.gz \
 *     --komi 8 --turns 0,1,40,79,120,199 \
 *     test/fixtures/2024-07-09d.sgf
 *
 * `verify-forward.ts` compares against a fixture built from KataGo's *analysis
 * engine* at one visit. This asks the network itself, over GTP's `kata-raw-nn`,
 * with no search and no analysis engine anywhere in the path.
 *
 * The distinction stopped being academic once the remaining parity gap was
 * isolated to White-to-play positions. A neural network cannot see colour — it
 * is shown "player to move" and "opponent" — and every colour-dependent input
 * has been verified: the spatial planes against KataGo's committed golden dumps
 * (`test/golden-v7.test.ts`), and global 5 against `currentSelfKomi`, which is a
 * plain negation of White's adjusted komi. If the inputs cannot differ by
 * colour and the network cannot know colour, then a colour-dependent
 * disagreement has to come from the thing being compared against, not from us.
 * This instrument removes that thing.
 *
 * See `docs/exploration-forward-pass-parity.md` §5.1 and §6.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';
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
import { toGtp } from './coords.ts';

const CFG = `${homedir()}/src/katago/cpp/configs/gtp_example.cfg`;
const OVERRIDE =
  'koRule=SIMPLE,scoringRule=TERRITORY,taxRule=SEKI,multiStoneSuicideLegal=false,' +
  'hasButton=false,whiteHandicapBonus=0,friendlyPassOk=false,nnRandomize=false,' +
  'openclUseFP16=false,logToStderr=false,logDir=';

interface Args {
  readonly net: string;
  readonly komi: number;
  readonly turns: readonly number[];
  readonly file: string;
  /**
   * Replay the game with every move's colour swapped and komi negated.
   *
   * That is an exact symmetry of Go, and because the network is shown "player
   * to move" and "opponent" rather than black and white, it produces a
   * bit-identical input tensor. KataGo must therefore return the same numbers
   * for a game and its mirror. If it does not, something in its pipeline knows
   * about colour that ours does not; if it does, and we still disagree only on
   * White, then our tensor differs somewhere still unchecked.
   */
  readonly mirror: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let net = '';
  let komi = 7.5;
  let turns: number[] = [];
  let mirror = false;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--net') net = argv[++i];
    else if (argv[i] === '--komi') komi = Number(argv[++i]);
    else if (argv[i] === '--turns') turns = argv[++i].split(',').map(Number);
    else if (argv[i] === '--mirror') mirror = true;
    else rest.push(argv[i]);
  }
  if (!net || rest.length === 0) throw new Error('need --net and an SGF file');
  return { net, komi, turns, file: rest[0], mirror };
}

interface Raw {
  readonly policy: number[];
  readonly pass: number;
  readonly whiteWin: number;
  readonly whiteLead: number;
  readonly noResult: number;
}

/** Raw network output after a sequence of GTP moves. */
function rawNN(net: string, komi: number, size: number, moves: readonly string[]): Raw {
  const commands: string =
    [
      `boardsize ${size}`,
      `komi ${komi}`,
      ...moves,
      'kata-raw-nn 0',
      'quit',
    ].join('\n') + '\n';

  const out: string = execFileSync(
    'katago',
    ['gtp', '-config', CFG, '-override-config', OVERRIDE, '-model', net],
    { input: commands, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 },
  );

  const lines: string[] = out.split('\n');
  const num = (key: string): number => {
    const line: string | undefined = lines.find((l) => l.startsWith(`${key} `));
    if (!line) throw new Error(`kata-raw-nn printed no ${key}`);
    return Number(line.split(' ')[1]);
  };

  const at: number = lines.findIndex((l) => l.trim() === 'policy');
  const policy: number[] = [];
  for (let row = 0; row < size; row++) {
    for (const token of lines[at + 1 + row].trim().split(/\s+/)) {
      policy.push(token === 'NAN' ? -1 : Number(token));
    }
  }
  return {
    policy,
    pass: num('policyPass'),
    whiteWin: num('whiteWin'),
    whiteLead: num('whiteLead'),
    noResult: num('noResult'),
  };
}

/** An SGF colour as an engine stone, swapped when mirroring. */
function colourOf(colour: number, mirror: boolean): Stone {
  const black: boolean = colour === 1;
  return black !== mirror ? BLACK : WHITE;
}

/** Swap the stones on a board, for the mirrored replay. */
function swap(state: BoardState, mirror: boolean): BoardState {
  if (!mirror) return state;
  for (let point = 0; point < state.stones.length; point++) {
    const stone: number = state.stones[point];
    if (stone !== 0) state.stones[point] = stone === BLACK ? WHITE : BLACK;
  }
  return state;
}

/** The five moves before `turn`, chronological, as the history planes want them. */
function historyBefore(game: Game, turn: number, mirror: boolean): RecentMove[] {
  const out: RecentMove[] = [];
  for (let i = Math.max(0, turn - 5); i < turn; i++) {
    const move: GameMove = game.moves[i];
    if (move.index === null) continue;
    out.push({ move: move.index, player: colourOf(move.color, mirror) });
  }
  return out;
}

/** Our policy as probabilities over legal points, matching KataGo's normalization. */
function policyProbabilities(evaluation: Evaluation, state: BoardState, area: number): Float32Array {
  const out = new Float32Array(area + 1).fill(-1);
  let highest = -Infinity;
  for (let point = 0; point < area; point++) {
    if (state.stones[point] !== 0) continue;
    if (evaluation.policy[point] > highest) highest = evaluation.policy[point];
  }
  if (evaluation.policyPass > highest) highest = evaluation.policyPass;

  let total = 0;
  for (let point = 0; point < area; point++) {
    if (state.stones[point] !== 0) continue;
    const value: number = Math.exp(evaluation.policy[point] - highest);
    out[point] = value;
    total += value;
  }
  out[area] = Math.exp(evaluation.policyPass - highest);
  total += out[area];

  for (let i = 0; i <= area; i++) if (out[i] >= 0) out[i] /= total;
  return out;
}

async function main(): Promise<void> {
  const { net, komi: given, turns, file, mirror } = parseArgs(process.argv.slice(2));
  const komi: number = mirror ? -given : given;
  await tf.setBackend('cpu');
  await tf.ready();

  const game: Game = readGame(parse(readFileSync(file, 'utf8')));
  const board: Board = createBoard(game.cols, game.rows);
  const scratch: FeatureScratch = createFeatureScratch(board);
  const ladderScratch: LadderScratch = createLadderScratch(board);
  const ladders: LadderInputs = createLadderInputs(board);

  const model = new ModelV8(tf, parseKataGoModelV8(gunzipSync(readFileSync(net))));
  console.log(`${model.name}, komi ${komi}${mirror ? ' (colours mirrored)' : ''}\n`);

  for (const turn of turns) {
    const move: GameMove = game.moves[turn];
    const state: BoardState = swap(fromPosition(board, move.before), mirror);
    const toPlay: Stone = colourOf(move.color, mirror);

    const gtp: string[] = [];
    for (let i = 0; i < turn; i++) {
      const earlier: GameMove = game.moves[i];
      const colour: string = colourOf(earlier.color, mirror) === BLACK ? 'B' : 'W';
      gtp.push(`play ${colour} ${toGtp(earlier.before, earlier.index)}`);
    }
    const raw: Raw = rawNN(net, komi, game.cols, gtp);

    const prev: BoardState | undefined =
      turn >= 1 ? swap(fromPosition(board, game.moves[turn - 1].before), mirror) : undefined;
    const prevPrev: BoardState | undefined =
      turn >= 2 ? swap(fromPosition(board, game.moves[turn - 2].before), mirror) : undefined;
    ladderInputs(board, state, prev, prevPrev, toPlay, ladderScratch, ladders);

    const inputs: Inputs = buildFeatures(
      {
        board,
        state,
        toPlay,
        history: historyBefore(game, turn, mirror),
        komi,
        ruleset: 'territory',
        ladders,
      },
      scratch,
    );
    const evaluation: Evaluation = model.evaluate(inputs.spatial, inputs.global, game.cols);
    const judgement: Judgement = postprocess(
      evaluation.value,
      evaluation.scoreValue,
      model.postProcess,
    );

    // `kata-raw-nn` reports from White's side; the network's own answer, and
    // ours, are from the side to move.
    const black: boolean = toPlay === BLACK;
    const theirWinrate: number = black ? 1 - raw.whiteWin : raw.whiteWin;
    const theirLead: number = black ? -raw.whiteLead : raw.whiteLead;

    const ours: Float32Array = policyProbabilities(evaluation, state, board.area);
    let policyError = 0;
    for (let i = 0; i < board.area; i++) {
      if (raw.policy[i] < 0 || ours[i] < 0) continue;
      policyError = Math.max(policyError, Math.abs(ours[i] - raw.policy[i]));
    }

    console.log(
      `turn ${String(turn).padStart(3)} ${black ? 'B' : 'W'}  ` +
        `policy Δ ${policyError.toFixed(6)}  ` +
        `winrate ours ${judgement.winrate.toFixed(6)} theirs ${theirWinrate.toFixed(6)} ` +
        `Δ ${Math.abs(judgement.winrate - theirWinrate).toFixed(6)}  ` +
        `lead ours ${judgement.scoreLead.toFixed(4)} theirs ${theirLead.toFixed(4)} ` +
        `Δ ${Math.abs(judgement.scoreLead - theirLead).toFixed(4)}`,
    );
  }
  model.dispose();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
