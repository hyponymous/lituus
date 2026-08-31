/**
 * Replay evaluator tests: the join, the coordinate conversion, and the guards.
 *
 * The guards are the reason this file is longer than the module deserves. A
 * replay evaluator that answers about the wrong game answers *plausibly* — real
 * numbers, real point names, in range — and nothing downstream could notice.
 * Every figure on the summary would be quietly about a different board.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/sgf-parser.ts';
import { readGame, type Game } from '../src/game.ts';
import { startSession, type Session } from '../src/session.ts';
import { pointFromName } from '../src/goban.ts';
import { EvaluationError, type Prompt } from '../src/evaluator.ts';
import {
  RECORDED_CONFIG,
  createReplayEvaluator,
  joinRecorded,
  type RecordedAnalysis,
  type RecordedBackfill,
  type RecordedGuess,
  type RecordedRow,
} from '../src/replay.ts';
import type { Position } from '../src/rules.ts';
import type { Verdict } from '../src/analysis.ts';

/** Black Q16, White D4 — enough to prompt on move 1 as Black. */
const GAME = '(;SZ[19];B[pd];W[dp];B[dd];W[pp])';

function board(): Position {
  return startSession(readGame(parse(GAME)), 1).position;
}

function at(name: string): number {
  const index: number | null = pointFromName(board(), name);
  if (index === null) assert.fail(`"${name}" is not a point on this board`);
  return index;
}

function prompt(overrides: Partial<Prompt> = {}): Prompt {
  const game: Game = readGame(parse(GAME));
  const session: Session = startSession(game, 1);
  return {
    moveNumber: 1,
    position: session.position,
    color: 1,
    played: at('Q16'),
    guess: at('D16'),
    ...overrides,
  };
}

const ANALYSIS: RecordedAnalysis = {
  moveNumber: 1,
  turn: 0,
  played: 'Q16',
  pointLoss: 0.4,
  playedVisits: 18,
  playedPv: ['Q16', 'D4'],
  best: 'Q4',
  bestScoreLead: -0.2,
  bestPv: ['Q4', 'D16'],
  topPolicy: 'R16',
  topPolicyPrior: 0.08,
  topPolicyLoss: 3.5,
  rootScoreLead: 0.2,
  rootVisits: 55,
};

const GUESS: RecordedGuess = { turn: 0, guess: 'D16', guessLoss: 2.75, guessPv: ['D16', 'Q4'] };

async function evaluate(rows: readonly RecordedRow[], p: Prompt = prompt()): Promise<Verdict> {
  return createReplayEvaluator(rows, RECORDED_CONFIG).evaluate(p);
}

// ── The join ─────────────────────────────────────────────────────────────────

test('the join pairs analysis, guesses and backfill by turn', () => {
  const rows: RecordedRow[] = joinRecorded([ANALYSIS], [GUESS], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].guess, 'D16');
  assert.equal(rows[0].guessLoss, 2.75);
});

test('a backfilled repair supersedes the base verdict on the played move', () => {
  const repair: RecordedBackfill = {
    turn: 0,
    played: 'Q16',
    pointLoss: 9.1,
    playedPv: ['Q16', 'R16'],
    backfilled: true,
  };
  const rows: RecordedRow[] = joinRecorded([ANALYSIS], [GUESS], [repair]);

  assert.equal(rows[0].pointLoss, 9.1);
  assert.equal(rows[0].backfilled, true);
  assert.deepEqual(rows[0].playedPv, ['Q16', 'R16']);
});

test('the repair does not bring a root with it', () => {
  // A query restricted to one move treats that move as best and reports a
  // meaningless root. The loss has to be measured against the unrestricted
  // query's root, which is the one that must survive the join.
  const repair: RecordedBackfill = { turn: 0, played: 'Q16', pointLoss: 9.1, backfilled: true };
  const rows: RecordedRow[] = joinRecorded([ANALYSIS], [], [repair]);

  assert.equal(rows[0].rootScoreLead, 0.2);
});

test('a repair with nothing to say leaves the base verdict alone', () => {
  const repair: RecordedBackfill = { turn: 0, played: 'Q16', pointLoss: null };
  const rows: RecordedRow[] = joinRecorded([ANALYSIS], [], [repair]);

  assert.equal(rows[0].pointLoss, 0.4);
  assert.equal(rows[0].backfilled, false);
});

// ── Conversion ───────────────────────────────────────────────────────────────

test('a recorded row becomes a verdict in board indices', async () => {
  const verdict: Verdict = await evaluate(joinRecorded([ANALYSIS], [GUESS]));

  assert.equal(verdict.moveNumber, 1);
  assert.equal(verdict.played?.point, at('Q16'));
  assert.equal(verdict.played?.loss, 0.4);
  assert.equal(verdict.best.point, at('Q4'));
  assert.equal(verdict.guessed?.point, at('D16'));
  assert.equal(verdict.guessed?.loss, 2.75);
  assert.equal(verdict.natural?.point, at('R16'));
  assert.equal(verdict.natural?.loss, 3.5);
});

test('variations come across as indices', async () => {
  const verdict: Verdict = await evaluate(joinRecorded([ANALYSIS], [GUESS]));
  assert.deepEqual(verdict.best.pv, [at('Q4'), at('D16')]);
  assert.deepEqual(verdict.guessed?.pv, [at('D16'), at('Q4')]);
});

test('a variation stops at a pass rather than continuing through it', async () => {
  // Dropping the pass silently would misrepresent whose move every later ply is.
  const rows: RecordedRow[] = joinRecorded([{ ...ANALYSIS, bestPv: ['Q4', 'pass', 'D16'] }]);
  const verdict: Verdict = await evaluate(rows);
  assert.deepEqual(verdict.best.pv, [at('Q4')]);
});

test('a forced verdict carries the full visit budget, an unforced one its share', async () => {
  const unforced: Verdict = await evaluate(joinRecorded([ANALYSIS]));
  assert.equal(unforced.played?.visits, 18);
  assert.equal(unforced.played?.forced, false);

  const repair: RecordedBackfill = { turn: 0, played: 'Q16', pointLoss: 9.1, backfilled: true };
  const forced: Verdict = await evaluate(joinRecorded([ANALYSIS], [], [repair]));
  assert.equal(forced.played?.visits, RECORDED_CONFIG.visits);
  assert.equal(forced.played?.forced, true);
});

test('a played move the search never looked at yields no played verdict', async () => {
  const verdict: Verdict = await evaluate(joinRecorded([{ ...ANALYSIS, pointLoss: null }]));

  assert.equal(verdict.played, null);
  // The position still has a best move and a difficulty signal, which is what
  // §6.4 and the difficulty breakdown are built from.
  assert.equal(verdict.best.point, at('Q4'));
  assert.equal(verdict.natural?.point, at('R16'));
});

test('a hit reports the played move as the guess rather than nothing', async () => {
  const hit: Prompt = prompt({ guess: at('Q16') });
  const verdict: Verdict = await evaluate(joinRecorded([ANALYSIS], [GUESS]), hit);

  assert.equal(verdict.guessed?.point, at('Q16'));
  assert.equal(verdict.guessed?.loss, 0.4);
});

test('a guess with no recorded evaluation yields no guess verdict', async () => {
  const verdict: Verdict = await evaluate(joinRecorded([ANALYSIS]));
  assert.equal(verdict.guessed, null);
  assert.equal(verdict.played?.point, at('Q16'));
});

// ── Guards ───────────────────────────────────────────────────────────────────

test('a prompt with no recorded row is refused', async () => {
  await assert.rejects(
    () => evaluate(joinRecorded([ANALYSIS]), prompt({ moveNumber: 99 })),
    EvaluationError,
  );
});

test('records for a different game are refused rather than answered', async () => {
  // The failure this prevents: every number in the summary silently describing
  // a board the user never saw.
  await assert.rejects(
    () => evaluate(joinRecorded([{ ...ANALYSIS, played: 'D4' }])),
    (error: unknown) => {
      assert.ok(error instanceof EvaluationError);
      assert.match(error.message, /not for this game/);
      return true;
    },
  );
});

test('a best move that is not a point on this board is refused', async () => {
  await assert.rejects(
    () => evaluate(joinRecorded([{ ...ANALYSIS, best: 'Z99' }])),
    EvaluationError,
  );
});

test('a guess recorded for a different point is not reported as the guess', async () => {
  // The row is for this position, but its guess is not the one the user made —
  // a stale guesses file. Reporting it would attribute someone else's move.
  const stale: RecordedGuess = { ...GUESS, guess: 'Q4' };
  const verdict: Verdict = await evaluate(joinRecorded([ANALYSIS], [stale]));

  assert.equal(verdict.guessed, null);
  assert.equal(verdict.played?.point, at('Q16'));
});
