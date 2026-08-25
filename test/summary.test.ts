/**
 * Summary tests: the numbers the user is shown at the end, and the two export
 * forms. A hit rate that is quietly wrong looks exactly like one that is
 * right, so the arithmetic gets checked rather than eyeballed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/sgf-parser.ts';
import { pointIndex, readGame, type Game } from '../src/game.ts';
import {
  advance,
  canGuess,
  endSession,
  guess,
  startSession,
  type Session,
} from '../src/session.ts';
import {
  STREAK_MIN,
  TENUKI_RADIUS,
  duration,
  longestStreak,
  percent,
  phaseOf,
  summarize,
  tenukiAgreement,
  toJSON,
  toText,
  type Streak,
  type Summary,
  type SummaryRow,
} from '../src/summary.ts';
import { BLACK, WHITE, type Position } from '../src/rules.ts';

function load(sgf: string): Game {
  return readGame(parse(sgf));
}

function point(pos: Position, name: string): number {
  const index: number | null = pointIndex(pos, name);
  if (index === null) assert.fail(`"${name}" is not a point on this board`);
  return index;
}

/** A 19x19 record with `count` moves, alternating from Black, all distinct. */
function longGame(count: number): Game {
  const letters = 'abcdefghijklmnopqrs';
  let sgf = '(;SZ[19]';
  for (let i = 0; i < count; i++) {
    const color: string = i % 2 === 0 ? 'B' : 'W';
    sgf += `;${color}[${letters[i % 19]}${letters[Math.floor(i / 19)]}]`;
  }
  return load(`${sgf})`);
}

/** Some legal point that is not `actual`, so a deliberate miss stays legal. */
function aMiss(session: Session, actual: number): number {
  for (let index = 0; index < session.position.stones.length; index++) {
    if (index !== actual && canGuess(session, index)) return index;
  }
  assert.fail('no legal point left to miss with');
}

/** Play a session as `color`, hitting on the moves whose numbers are in `hits`. */
function playSession(game: Game, color: 1 | -1, hits: Set<number>): Session {
  let session: Session = startSession(game, color);
  while (session.phase === 'prompt' && session.move) {
    const actual: number | null = session.move.index;
    if (actual === null) break;
    const choice: number = hits.has(session.move.number) ? actual : aMiss(session, actual);
    session = advance(guess(session, choice));
  }
  return session;
}

const SIMPLE = '(;SZ[19]PB[Ada]BR[3d]PW[Bo]WR[4d];B[dd];W[pp];B[cc];W[qq])';

// ── Phases ───────────────────────────────────────────────────────────────────

test('phases split on move number, tuned for 19x19', () => {
  const game: Game = longGame(4);
  assert.equal(phaseOf(game, 1), 'opening');
  assert.equal(phaseOf(game, 50), 'opening');
  assert.equal(phaseOf(game, 51), 'middle');
  assert.equal(phaseOf(game, 150), 'middle');
  assert.equal(phaseOf(game, 151), 'endgame');
});

test('phase boundaries scale down with the board', () => {
  // A 9x9 game is over long before move 50; without scaling it would report as
  // one long opening, which would make the breakdown useless on small boards.
  const small: Game = load('(;SZ[9];B[ee];W[cc])');
  assert.equal(phaseOf(small, 20), 'middle');
  assert.equal(phaseOf(small, 50), 'endgame');
});

// ── Totals ───────────────────────────────────────────────────────────────────

test('the summary counts hits, guesses, and the rate between them', () => {
  const game: Game = load(SIMPLE);
  const session: Session = playSession(game, BLACK, new Set([1]));
  const summary: Summary = summarize(session);

  assert.equal(summary.score.hits, 1);
  assert.equal(summary.score.guessed, 2);
  assert.equal(summary.score.rate, 0.5);
});

test('a run to the end of the record is not marked abandoned', () => {
  const summary: Summary = summarize(playSession(load(SIMPLE), BLACK, new Set([1, 3])));
  assert.equal(summary.abandoned, false);
  assert.equal(summary.score.hits, 2);
});

test('stopping early is marked abandoned and keeps the partial score', () => {
  const game: Game = load(SIMPLE);
  const start: Session = startSession(game, BLACK);
  const summary: Summary = summarize(endSession(guess(start, point(start.position, 'dd'))));

  assert.equal(summary.abandoned, true);
  assert.equal(summary.score.guessed, 1);
  assert.equal(summary.score.total, 2);
});

// ── Rows ─────────────────────────────────────────────────────────────────────

test('each row names the guessed and actual points in board coordinates', () => {
  const game: Game = load(SIMPLE);
  const start: Session = startSession(game, BLACK);
  const summary: Summary = summarize(endSession(guess(start, point(start.position, 'pd'))));

  const row: SummaryRow = summary.rows[0];
  assert.equal(row.moveNumber, 1);
  assert.equal(row.actual, 'D16');
  assert.equal(row.guess, 'Q16');
  assert.equal(row.hit, false);
});

test('rows appear in the order they were played', () => {
  const summary: Summary = summarize(playSession(load(SIMPLE), BLACK, new Set([1, 3])));
  assert.deepEqual(summary.rows.map((row) => row.moveNumber), [1, 3]);
});

test('only the chosen color appears in the rows', () => {
  const summary: Summary = summarize(playSession(load(SIMPLE), WHITE, new Set([2])));
  assert.deepEqual(summary.rows.map((row) => row.moveNumber), [2, 4]);
});

// ── Phase breakdown ──────────────────────────────────────────────────────────

test('the breakdown sums to the overall totals', () => {
  const game: Game = longGame(200);
  const summary: Summary = summarize(playSession(game, BLACK, new Set([1, 61, 63, 181])));

  const guessed: number = summary.phases.reduce((total, p) => total + p.guessed, 0);
  const hits: number = summary.phases.reduce((total, p) => total + p.hits, 0);
  assert.equal(guessed, summary.score.guessed);
  assert.equal(hits, summary.score.hits);
});

test('the breakdown attributes hits to the right phase', () => {
  const game: Game = longGame(200);
  const summary: Summary = summarize(playSession(game, BLACK, new Set([1, 61, 63, 181])));
  const by = (phase: string) => summary.phases.find((p) => p.phase === phase);

  assert.equal(by('opening')?.hits, 1);
  assert.equal(by('middle')?.hits, 2);
  assert.equal(by('endgame')?.hits, 1);
});

test('a phase the game never reached reports zero rather than dividing by zero', () => {
  const summary: Summary = summarize(playSession(load(SIMPLE), BLACK, new Set([1])));
  const endgame = summary.phases.find((p) => p.phase === 'endgame');

  assert.equal(endgame?.guessed, 0);
  assert.equal(endgame?.rate, 0);
  assert.equal(Number.isFinite(endgame?.rate), true);
});

test('all three phases are always present, in order', () => {
  const summary: Summary = summarize(playSession(load(SIMPLE), BLACK, new Set()));
  assert.deepEqual(summary.phases.map((p) => p.phase), ['opening', 'middle', 'endgame']);
});

// ── Streaks ──────────────────────────────────────────────────────────────────

/** Black's prompts in `longGame` are the odd move numbers, in order. */
function blackMoves(from: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => from + i * 2);
}

test('a run shorter than STREAK_MIN is not reported as a streak', () => {
  const game: Game = longGame(40);
  const hits: number[] = blackMoves(1, STREAK_MIN - 1);
  const summary: Summary = summarize(playSession(game, BLACK, new Set(hits)));

  assert.equal(summary.score.hits, hits.length);
  assert.deepEqual(summary.streaks, []);
});

test('consecutive correct predictions make a streak, named by move number', () => {
  const game: Game = longGame(40);
  const hits: number[] = blackMoves(1, STREAK_MIN);
  const summary: Summary = summarize(playSession(game, BLACK, new Set(hits)));

  assert.equal(summary.streaks.length, 1);
  assert.deepEqual(summary.streaks[0], {
    start: 0,
    length: STREAK_MIN,
    firstMove: hits[0],
    lastMove: hits.at(-1),
  });
});

test('consecutive means consecutive prompts, not consecutive move numbers', () => {
  // Black's prompts are two apart in the record; the opponent's reply between
  // them must not read as a break in the run.
  const game: Game = longGame(40);
  const summary: Summary = summarize(playSession(game, BLACK, new Set(blackMoves(1, 4))));

  assert.equal(summary.streaks.length, 1);
  assert.equal(summary.streaks[0].length, 4);
});

test('a miss between two runs splits them', () => {
  const game: Game = longGame(40);
  const hits: number[] = [...blackMoves(1, 3), ...blackMoves(9, 3)];
  const summary: Summary = summarize(playSession(game, BLACK, new Set(hits)));

  assert.deepEqual(
    summary.streaks.map((streak) => [streak.firstMove, streak.lastMove]),
    [
      [1, 5],
      [9, 13],
    ],
  );
});

test('a run reaching the last prediction is still closed', () => {
  const game: Game = longGame(12);
  const summary: Summary = summarize(playSession(game, BLACK, new Set(blackMoves(7, 3))));

  assert.equal(summary.streaks.length, 1);
  assert.deepEqual(summary.streaks[0], { start: 3, length: 3, firstMove: 7, lastMove: 11 });
});

test('the longest streak wins, and a tie goes to the earlier run', () => {
  const game: Game = longGame(40);
  const hits: number[] = [...blackMoves(1, 3), ...blackMoves(9, 3)];
  const summary: Summary = summarize(playSession(game, BLACK, new Set(hits)));
  const best: Streak | null = longestStreak(summary);

  assert.equal(best?.firstMove, 1);

  const longer: Summary = summarize(
    playSession(game, BLACK, new Set([...blackMoves(1, 3), ...blackMoves(9, 5)])),
  );
  assert.equal(longestStreak(longer)?.firstMove, 9);
  assert.equal(longestStreak(longer)?.length, 5);
});

test('a session with no streak has no longest one', () => {
  const summary: Summary = summarize(playSession(longGame(40), BLACK, new Set([1, 5])));
  assert.equal(longestStreak(summary), null);
});

test('the exports carry the streaks', () => {
  const game: Game = longGame(40);
  const summary: Summary = summarize(playSession(game, BLACK, new Set(blackMoves(3, 4))));

  assert.match(toText(summary), /Longest streak: 4 in a row \(moves 3–9\)/);
  assert.deepEqual(JSON.parse(toJSON(summary)).streaks, [
    { length: 4, firstMove: 3, lastMove: 9 },
  ]);
});

// ── Timing ───────────────────────────────────────────────────────────────────

/** Play `times.length` prompts, spending each listed number of ms on one. */
function timedSession(game: Game, times: readonly (number | null)[]): Session {
  let session: Session = startSession(game, BLACK);
  for (const ms of times) {
    if (session.phase !== 'prompt' || session.move?.index == null) break;
    session = advance(guess(session, session.move.index, ms));
  }
  return session;
}

test('an untimed session reports no timing at all, rather than zeros', () => {
  const summary: Summary = summarize(playSession(load(SIMPLE), BLACK, new Set([1, 3])));
  assert.equal(summary.timing, null);
});

test('timings summarize to a total, a median, and both ends', () => {
  const summary: Summary = summarize(timedSession(longGame(20), [3000, 1000, 5000]));

  assert.equal(summary.timing?.timed, 3);
  assert.equal(summary.timing?.totalMs, 9000);
  assert.equal(summary.timing?.medianMs, 3000);
  assert.equal(summary.timing?.fastestMs, 1000);
  assert.equal(summary.timing?.slowestMs, 5000);
});

test('an even number of timings takes the mean of the middle pair', () => {
  const summary: Summary = summarize(timedSession(longGame(20), [1000, 2000, 3000, 6000]));
  assert.equal(summary.timing?.medianMs, 2500);
});

test('one very slow guess moves the slowest but not the median', () => {
  // The reason the median leads: nothing stops the clock when a user walks
  // away, and a mean would be all lunch break and no measurement.
  const summary: Summary = summarize(timedSession(longGame(20), [2000, 2000, 2000, 3_600_000]));

  assert.equal(summary.timing?.medianMs, 2000);
  assert.equal(summary.timing?.slowestMs, 3_600_000);
});

test('unmeasured guesses are left out rather than counted as instant', () => {
  const summary: Summary = summarize(timedSession(longGame(20), [4000, null, 6000]));

  assert.equal(summary.timing?.timed, 2);
  assert.equal(summary.timing?.totalMs, 10000);
  assert.equal(summary.rows[1].elapsedMs, null);
});

test('each row carries the time its own guess took', () => {
  const summary: Summary = summarize(timedSession(longGame(20), [1500, 2500]));
  assert.deepEqual(summary.rows.map((row) => row.elapsedMs), [1500, 2500]);
});

test('durations read as seconds under a minute, keeping one decimal', () => {
  assert.equal(duration(0), '0.0s');
  assert.equal(duration(1400), '1.4s');
  assert.equal(duration(59_900), '59.9s');
});

test('durations past a minute switch to minutes, and past an hour to hours', () => {
  assert.equal(duration(60_000), '1m 00s');
  assert.equal(duration(125_000), '2m 05s');
  assert.equal(duration(3_600_000), '1h 00m');
  assert.equal(duration(5_460_000), '1h 31m');
});

test('the text export reports the timings when there are any', () => {
  const summary: Summary = summarize(timedSession(longGame(20), [2000, 4000, 9000]));
  assert.match(toText(summary), /Time: 15\.0s over 3 moves, median 4\.0s/);
});

test('the text export says nothing about time when nothing was timed', () => {
  const summary: Summary = summarize(playSession(load(SIMPLE), BLACK, new Set([1])));
  assert.doesNotMatch(toText(summary), /Time:/);
});

test('the JSON export carries the timings and the per-move times', () => {
  const summary: Summary = summarize(timedSession(longGame(20), [2000, 4000]));
  const json = JSON.parse(toJSON(summary)) as {
    timing: { timed: number; medianMs: number };
    moves: { ms: number | null }[];
  };

  assert.equal(json.timing.timed, 2);
  assert.equal(json.timing.medianMs, 3000);
  assert.deepEqual(json.moves.map((move) => move.ms), [2000, 4000]);
});

test('the JSON export carries a null timing rather than omitting it', () => {
  const summary: Summary = summarize(playSession(load(SIMPLE), BLACK, new Set([1])));
  const json = JSON.parse(toJSON(summary)) as Record<string, unknown>;

  assert.ok('timing' in json, 'the field is present');
  assert.equal(json.timing, null);
});

// ── Tenuki ───────────────────────────────────────────────────────────────────

/**
 * Black plays dd; White answers at fc (3 away, local); Black is prompted at
 * move 3. The reference point for move 3 is White's fc.
 */
const LOCAL_REPLY = '(;SZ[19];B[dd];W[fc];B[df];W[qq])';

test('the first move has nothing to measure against', () => {
  const game: Game = load(SIMPLE);
  const start: Session = startSession(game, BLACK);
  const summary: Summary = summarize(endSession(guess(start, point(start.position, 'pd'))));

  assert.equal(summary.tenuki.unscored, 1);
  assert.equal(tenukiAgreement(summary.tenuki).scored, 0);
  assert.equal(summary.rows[0].actualAway, null);
});

test('answering near the opponent s move counts as local for both', () => {
  // Move 3 is df, two points from White's fc. Guess dg, also close.
  const game: Game = load(LOCAL_REPLY);
  let session: Session = startSession(game, BLACK);
  session = advance(guess(session, session.move?.index ?? 0)); // move 1, unscored
  const summary: Summary = summarize(endSession(guess(session, point(session.position, 'dg'))));

  assert.equal(summary.tenuki.bothLocal, 1);
  assert.equal(summary.tenuki.stayedHome, 0);
});

test('the player leaving while you stay home is counted apart', () => {
  // Move 3 (cc) is 3 from White's pp? No - build it explicitly:
  // B dd, W pp (far), B cc. Reference for move 3 is pp; cc is far from pp,
  // so the player played away. A guess next to pp would be staying home.
  const game: Game = load(SIMPLE);
  let session: Session = startSession(game, BLACK);
  session = advance(guess(session, session.move?.index ?? 0));
  const summary: Summary = summarize(endSession(guess(session, point(session.position, 'pn'))));

  assert.equal(summary.tenuki.stayedHome, 1, 'pn sits beside pp; cc is across the board');
  assert.equal(summary.tenuki.bothAway, 0);
});

test('both leaving for the same corner counts as the same area', () => {
  const game: Game = load(SIMPLE);
  let session: Session = startSession(game, BLACK);
  session = advance(guess(session, session.move?.index ?? 0));
  // Actual move 3 is cc; guess dc is one point away, both far from pp.
  const summary: Summary = summarize(endSession(guess(session, point(session.position, 'dc'))));

  assert.equal(summary.tenuki.bothAway, 1);
  assert.equal(summary.tenuki.sameArea, 1);
});

test('both leaving for opposite corners is agreement without the same area', () => {
  const game: Game = load(SIMPLE);
  let session: Session = startSession(game, BLACK);
  session = advance(guess(session, session.move?.index ?? 0));
  // Actual is cc (top left); guess cq (bottom left) is far from both pp and cc.
  const summary: Summary = summarize(endSession(guess(session, point(session.position, 'cq'))));

  assert.equal(summary.tenuki.bothAway, 1, 'both played away from pp');
  assert.equal(summary.tenuki.sameArea, 0, 'but to different corners');
});

/**
 * A White session where move 1 sits at the given point and move 2 is the one
 * predicted, so the reference for the prediction is move 1. Offsets are
 * derived from TENUKI_RADIUS rather than written as literals: a test that
 * hard-codes the boundary stops testing the boundary the moment the constant
 * moves, and does it silently.
 */
function boardPoint(row: number, col: number): string {
  return String.fromCharCode(97 + col) + String.fromCharCode(97 + row);
}

function radiusFixture(): { game: Game; local: string; away: string } {
  // Anchored near the left edge so the fixture still fits as the radius grows.
  const row = 9;
  const col = 1;
  assert.ok(col + TENUKI_RADIUS + 1 < 19, 'the fixture needs room on the board');

  return {
    game: load(`(;SZ[19];B[${boardPoint(row, col)}];W[${boardPoint(row, col + 2)}])`),
    local: boardPoint(row, col + TENUKI_RADIUS),
    away: boardPoint(row, col + TENUKI_RADIUS + 1),
  };
}

test('a guess exactly TENUKI_RADIUS away still counts as local', () => {
  const { game, local } = radiusFixture();
  const start: Session = startSession(game, WHITE);
  const summary: Summary = summarize(endSession(guess(start, point(start.position, local))));

  assert.equal(summary.rows[0].guessAway, false, `${local} is exactly ${TENUKI_RADIUS} away`);
  assert.equal(summary.tenuki.bothLocal, 1);
});

test('one point beyond TENUKI_RADIUS counts as playing away', () => {
  const { game, away } = radiusFixture();
  const start: Session = startSession(game, WHITE);
  const summary: Summary = summarize(endSession(guess(start, point(start.position, away))));

  assert.equal(summary.rows[0].guessAway, true, `${away} is one past ${TENUKI_RADIUS}`);
  assert.equal(summary.tenuki.leftEarly, 1, 'the played move answered locally');
});

test('agreement counts the diagonal of the matrix, not the totals', () => {
  const tenuki = {
    bothAway: 4,
    stayedHome: 29,
    bothLocal: 40,
    leftEarly: 4,
    unscored: 1,
    sameArea: 2,
  };
  assert.deepEqual(tenukiAgreement(tenuki), { agreed: 44, scored: 77 });
});

test('the text export reports the matrix when anything was scored', () => {
  const game: Game = load(SIMPLE);
  let session: Session = startSession(game, BLACK);
  session = advance(guess(session, session.move?.index ?? 0));
  const text: string = toText(summarize(endSession(guess(session, point(session.position, 'dc')))));

  assert.match(text, /Local or away: agreed on 1 of 1/);
  assert.match(text, /to the same area\s+1/);
});

test('the JSON export carries the matrix and the per-move flags', () => {
  const game: Game = load(SIMPLE);
  let session: Session = startSession(game, BLACK);
  session = advance(guess(session, session.move?.index ?? 0));
  const parsed = JSON.parse(toJSON(summarize(endSession(guess(session, point(session.position, 'dc'))))));

  assert.equal(parsed.tenuki.bothAway, 1);
  assert.equal(parsed.tenuki.sameArea, 1);
  assert.equal(parsed.moves[0].playedAway, null, 'move 1 had no reference');
  assert.equal(parsed.moves[1].playedAway, true);
});

// ── Exports ──────────────────────────────────────────────────────────────────

test('the JSON export parses and carries the totals', () => {
  const summary: Summary = summarize(playSession(load(SIMPLE), BLACK, new Set([1])));
  const parsed = JSON.parse(toJSON(summary));

  assert.equal(parsed.hits, 1);
  assert.equal(parsed.predicted, 2);
  assert.equal(parsed.rate, 0.5);
  assert.equal(parsed.color, 'Black');
  assert.equal(parsed.moves.length, 2);
  assert.equal(parsed.moves[0].actual, 'D16');
});

test('the JSON export names the game from its metadata', () => {
  const summary: Summary = summarize(playSession(load(SIMPLE), BLACK, new Set()));
  assert.equal(JSON.parse(toJSON(summary)).game, 'Ada 3d vs Bo 4d');
});

test('the text export leads with the score and lists every move', () => {
  const summary: Summary = summarize(playSession(load(SIMPLE), BLACK, new Set([1])));
  const text: string = toText(summary);

  assert.match(text, /Ada 3d vs Bo 4d/);
  assert.match(text, /Played as Black/);
  assert.match(text, /1 \/ 2 correct \(50%\)/);
  assert.equal(text.split('\n').filter((line) => /hit |miss/.test(line)).length, 2);
});

test('the text export says so when the session was cut short', () => {
  const game: Game = load(SIMPLE);
  const start: Session = startSession(game, BLACK);
  const text: string = toText(summarize(endSession(guess(start, point(start.position, 'dd')))));

  assert.match(text, /Ended early: 1 of 2 moves predicted/);
});

test('a phase with no moves reads as "not reached" rather than 0%', () => {
  const text: string = toText(summarize(playSession(load(SIMPLE), BLACK, new Set([1]))));
  assert.match(text, /endgame\s+not reached/);
});

test('percentages round to whole numbers', () => {
  assert.equal(percent(0), '0%');
  assert.equal(percent(1), '100%');
  assert.equal(percent(1 / 3), '33%');
});
