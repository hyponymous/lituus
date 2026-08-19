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
  percent,
  phaseOf,
  summarize,
  toJSON,
  toText,
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
