/**
 * The join between a game record, a search and a `Verdict`.
 *
 * This is where a sign convention goes wrong quietly. A point loss is the
 * difference between two numbers that are both plausible either way round, and
 * a search that reports the negation of what it means produces a summary that
 * congratulates a player for a blunder. The stub network below is told exactly
 * what it thinks, so the number the verdict ought to carry is arithmetic rather
 * than opinion.
 *
 * The other thing tested here is the second search. Forcing the guess is the
 * difference between catching 14% of a twenty-kyu's blunders and 82%
 * (`docs/prd-ai-scoring.md` §8b), and the rule for when to run it is a visit
 * floor rather than "did the search look at all" — a distinction that was
 * measured, not assumed (`analysis.ts`, `MIN_TRUSTED_VISITS`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_TRUSTED_VISITS, type Verdict } from '../src/analysis.ts';
import { EvaluationError, type Prompt } from '../src/evaluator.ts';
import { BLACK, WHITE, type Stone } from '../src/engine/board.ts';
import {
  evaluatePrompt,
  gameContext,
  historyBefore,
  movesBefore,
  type GameContext,
} from '../src/engine/evaluate.ts';
import { SPATIAL_CHANNELS } from '../src/engine/features-v7.ts';
import type { Evaluation } from '../src/engine/model-v8.ts';
import { Search, type Network } from '../src/engine/search.ts';
import { readGame, type Game } from '../src/game.ts';
import { pointFromName } from '../src/goban.ts';
import { parse } from '../src/sgf-parser.ts';
import { startSession, type Session } from '../src/session.ts';

/** A 9x9 game with a pass in it, so the chill and the history are both exercised. */
const GAME = '(;SZ[9]KM[6.5]RU[Japanese];B[ee];W[cc];B[gg];W[];B[cg];W[gc])';

const SIZE = 9;
const AREA = SIZE * SIZE;

const POST_PROCESS = {
  tdScoreMultiplier: 20,
  scoreMeanMultiplier: 20,
  scoreStdevMultiplier: 20,
  leadMultiplier: 20,
  varianceTimeMultiplier: 40,
  shorttermValueErrorMultiplier: 0.25,
  shorttermScoreErrorMultiplier: 30,
  outputScaleMultiplier: 1,
};

function game(): Game {
  return readGame(parse(GAME));
}

function at(name: string): number {
  const session: Session = startSession(game(), 1);
  const point: number | null = pointFromName(session.position, name);
  if (point === null) assert.fail(`"${name}" is not a point on this board`);
  return point;
}

interface Opinion {
  readonly policy?: ReadonlyMap<number, number>;
  readonly lead?: number;
  /** The policy logit for passing. Low enough to be ignored unless raised. */
  readonly pass?: number;
}

/**
 * A network whose opinion is a function of the position it is shown.
 *
 * `white` comes from the self-komi plane, the one input that carries the colour
 * — the value head answers in the player-to-move's frame, so a stub that does
 * not flip with it is stating a contradiction rather than an opinion.
 */
function stubNetwork(opine: (stones: Map<number, Stone>, white: boolean) => Opinion): Network {
  return {
    postProcess: POST_PROCESS,
    evaluate: (spatial: Float32Array, global: Float32Array): Evaluation => {
      const white: boolean = global[5] > 0;
      const mover: Stone = white ? WHITE : BLACK;
      const other: Stone = white ? BLACK : WHITE;
      const stones = new Map<number, Stone>();
      for (let point = 0; point < AREA; point++) {
        const base: number = point * SPATIAL_CHANNELS;
        if (spatial[base + 1] === 1) stones.set(point, mover);
        else if (spatial[base + 2] === 1) stones.set(point, other);
      }
      const opinion: Opinion = opine(stones, white);
      const policy = new Float32Array(AREA);
      if (opinion.policy) for (const [point, logit] of opinion.policy) policy[point] = logit;
      return {
        policy,
        policyPass: opinion.pass ?? -10,
        value: Float32Array.from([0, 0, -30]),
        scoreValue: Float32Array.from([
          (opinion.lead ?? 0) / POST_PROCESS.scoreMeanMultiplier,
          -2,
          (opinion.lead ?? 0) / POST_PROCESS.leadMultiplier,
          0,
        ]),
      };
    },
  };
}

function evaluate(
  network: Network, moveNumber: number, played: string, guess: string, visits = 40,
): Verdict {
  const context: GameContext = gameContext(game());
  const session: Session = startSession(game(), 1);
  const move = game().moves.find((m) => m.number === moveNumber);
  if (!move) throw new EvaluationError(`Move ${moveNumber} is not in this record.`);
  const prompt: Prompt = {
    moveNumber,
    position: move.before,
    color: move.color,
    played: at(played),
    guess: at(guess),
  };
  void session;
  return evaluatePrompt(new Search(network, context.board), context, prompt, visits);
}

test('a pass is not a stone, so it does not chill the komi', () => {
  // The record is B, W, B, pass, B, W: five stones before turn 5, three Black
  // and two White, and the White pass counted for neither.
  assert.deepEqual(movesBefore(game(), 5), { black: 3, white: 1 });
  assert.deepEqual(movesBefore(game(), 6), { black: 3, white: 2 });
});

test('history keeps the pass, because the network is told about it', () => {
  const context: GameContext = gameContext(game());
  const history = historyBefore(game(), context.board, 5);
  assert.equal(history.length, 5);
  // Turn 3 is White's pass, encoded as the pass index rather than dropped: a
  // dropped pass would tell the network the players alternated when they did
  // not, and `buildFeatures` stops encoding history at the first move that
  // breaks the alternation.
  assert.equal(history[3].player, WHITE);
  assert.equal(history[3].move, context.board.area);
  assert.equal(history[4].player, BLACK);
});

test('a move that gives points away carries a positive loss', () => {
  const bad: number = at('A1');
  const network: Network = stubNetwork((stones: Map<number, Stone>, white: boolean) => ({
    // A Black stone on a1 is worth ten points to White, whoever put it there.
    lead: stones.get(bad) === BLACK ? (white ? 10 : -10) : 0,
    policy: new Map([[bad, 3], [at('C6'), 3], [at('F6'), 3]]),
  }));

  const verdict: Verdict = evaluate(network, 5, 'A1', 'A1');
  assert.ok(verdict.played);
  assert.ok(
    verdict.played.loss > 5,
    `throwing away ten points read as a loss of ${verdict.played.loss}`,
  );
  assert.notEqual(verdict.best.point, bad);
  // And the loss really is the difference the reference harness computes.
  assert.ok(Math.abs(verdict.rootScoreLead - verdict.best.scoreLead) < verdict.played.loss);
});

test('a hit costs one search, not two', () => {
  let calls = 0;
  const network: Network = stubNetwork(() => {
    calls += 1;
    return { policy: new Map([[at('C6'), 4]]) };
  });
  const verdict: Verdict = evaluate(network, 5, 'C6', 'C6', 30);
  // Thirty for the root search and nothing more: the played move is the top
  // policy move, so it is searched well past the floor, and the guess is the
  // same move again.
  assert.equal(calls, 30);
  assert.equal(verdict.played, verdict.guessed);
  assert.equal(verdict.played?.forced, false);
  assert.ok((verdict.played?.visits ?? 0) >= MIN_TRUSTED_VISITS);
});

test('a move the root search ignores is forced, and says so', () => {
  const ignored: number = at('A2');
  const network: Network = stubNetwork(() => ({
    // Three moves the policy likes; the played move is not among them, so at
    // thirty visits the root never gets near it.
    policy: new Map([[at('C6'), 6], [at('F6'), 6], [at('D3'), 6], [ignored, -6]]),
  }));
  const verdict: Verdict = evaluate(network, 5, 'A2', 'A2', 30);
  assert.ok(verdict.played);
  assert.equal(verdict.played.forced, true);
  assert.equal(verdict.played.point, ignored);
  // A forced search spends the whole budget on the one move, so what comes back
  // is worth quoting — which is the entire reason for running it.
  assert.ok(verdict.played.visits >= MIN_TRUSTED_VISITS);
  assert.equal(verdict.played.pv[0], ignored);
});

test('a miss is two verdicts about two different moves', () => {
  const network: Network = stubNetwork(() => ({
    policy: new Map([[at('C6'), 5], [at('F6'), 5]]),
  }));
  const verdict: Verdict = evaluate(network, 5, 'C6', 'A2', 30);
  assert.ok(verdict.played && verdict.guessed);
  assert.notEqual(verdict.played, verdict.guessed);
  assert.equal(verdict.played.point, at('C6'));
  assert.equal(verdict.guessed.point, at('A2'));
  assert.equal(verdict.guessed.forced, true);
});

test('the natural move is the policy\'s favourite, whatever the search decides', () => {
  const favourite: number = at('B8');
  const better: number = at('H6');
  const network: Network = stubNetwork((stones: Map<number, Stone>, white: boolean) => ({
    lead: stones.get(better) === BLACK ? (white ? -12 : 12) : 0,
    policy: new Map([[favourite, 6], [better, 5]]),
  }));
  const verdict: Verdict = evaluate(network, 5, 'B8', 'B8', 50);
  assert.ok(verdict.natural);
  assert.equal(verdict.natural.point, favourite);
  assert.equal(verdict.best.point, better);
  // The position misleads: the move that looks best is not, and by how much is
  // the difficulty signal (`docs/katago-feasibility.md` §8).
  assert.ok(verdict.natural.loss > 5, `natural loss was ${verdict.natural.loss}`);
});

test('a search that finds nothing to say raises rather than inventing a verdict', () => {
  const network: Network = stubNetwork(() => ({}));
  assert.throws(
    () => evaluate(network, 999, 'C6', 'C6'),
    /not in this record/,
  );
});

test('a variation stops at a pass instead of naming it as a point', () => {
  /*
   * A pass is numbered just past the last intersection, so it is not a point
   * and has no name. Left in a variation it was exported as "A0", which reads
   * back as nothing at all — every late-game line in a saved result came back
   * shorter than it went out, and the drift report was the only thing that
   * noticed.
   */
  const network: Network = stubNetwork(() => ({ pass: 6 }));
  const verdict: Verdict = evaluate(network, 5, 'C3', 'G7');

  assert.equal(verdict.best.point, AREA, 'the stub makes passing the best move');
  assert.deepEqual(verdict.best.pv, [], 'a line that opens with a pass carries nothing');

  for (const [what, pv] of [
    ['played', verdict.played?.pv ?? []],
    ['guessed', verdict.guessed?.pv ?? []],
  ] as const) {
    assert.ok(
      pv.every((point: number) => point < AREA),
      `${what}'s variation names only points on the board`,
    );
  }
});
