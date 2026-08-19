/**
 * Session tests: the prompt → reveal → advance loop, scoring, and the shape of
 * a session over handicap games, passes, and the end of the record.
 *
 * These are the tests that matter most for correctness the user cannot see. A
 * guess scored against the wrong move, or an opponent move silently skipped,
 * looks exactly like working software on screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/sgf-parser.ts';
import { pointIndex, readGame, type Game } from '../src/game.ts';
import {
  SessionError,
  advance,
  canGuess,
  countPrompts,
  endSession,
  guess,
  score,
  startSession,
  type Score,
  type Session,
} from '../src/session.ts';
import { BLACK, WHITE, stoneAt, type Position } from '../src/rules.ts';

function load(sgf: string): Game {
  return readGame(parse(sgf));
}

/** An SGF point as a board index, failing loudly rather than returning null. */
function point(pos: Position, name: string): number {
  const index: number | null = pointIndex(pos, name);
  if (index === null) assert.fail(`"${name}" is not a point on this board`);
  return index;
}

/** A four-move game: Black dd, White pp, Black cc, White qq. */
const SIMPLE = '(;SZ[19];B[dd];W[pp];B[cc];W[qq])';

// ── Starting ─────────────────────────────────────────────────────────────────

test('a session opens on a prompt for the chosen color', () => {
  const game: Game = load(SIMPLE);
  const session: Session = startSession(game, BLACK);

  assert.equal(session.phase, 'prompt');
  assert.equal(session.move?.number, 1);
  assert.equal(session.move?.color, BLACK);
});

test('choosing White starts at White s first move, not the game s', () => {
  const session: Session = startSession(load(SIMPLE), WHITE);
  assert.equal(session.move?.number, 2);
  assert.equal(session.position, session.move?.before);
});

test('the board shown at a prompt has the opponent s previous move on it', () => {
  const game: Game = load(SIMPLE);
  const session: Session = startSession(game, WHITE);
  assert.equal(stoneAt(session.position, point(session.position, 'dd')), BLACK);
});

test('a handicap game starts a White session at move 1, on the placed stones', () => {
  const game: Game = load('(;SZ[19]HA[2]AB[dd][pp];W[qq];B[cc];W[cq])');
  const session: Session = startSession(game, WHITE);

  assert.equal(session.move?.number, 1);
  assert.equal(session.position, game.initial);
  assert.equal(stoneAt(session.position, point(session.position, 'dd')), BLACK);
});

test('a handicap game starts a Black session after the placed stones', () => {
  const game: Game = load('(;SZ[19]HA[2]AB[dd][pp];W[qq];B[cc];W[cq])');
  const session: Session = startSession(game, BLACK);

  assert.equal(session.move?.number, 2, 'the handicap stones are not moves to guess');
  assert.equal(session.move?.index, pointIndex(game.initial, 'cc'));
});

// ── Guessing and revealing ───────────────────────────────────────────────────

test('a correct guess is a hit, and the reveal shows the move played', () => {
  const start: Session = startSession(load(SIMPLE), BLACK);
  const revealed: Session = guess(start, point(start.position, 'dd'));

  assert.equal(revealed.phase, 'reveal');
  assert.equal(revealed.lastGuess?.hit, true);
  assert.equal(revealed.position, start.move?.after);
  assert.equal(stoneAt(revealed.position, point(revealed.position, 'dd')), BLACK);
});

test('a wrong guess is a miss, and records both points', () => {
  const start: Session = startSession(load(SIMPLE), BLACK);
  const revealed: Session = guess(start, point(start.position, 'pd'));

  assert.equal(revealed.lastGuess?.hit, false);
  assert.equal(revealed.lastGuess?.guess, point(start.position, 'pd'));
  assert.equal(revealed.lastGuess?.actual, point(start.position, 'dd'));
});

test('a miss still reveals the played move, not the guess', () => {
  const start: Session = startSession(load(SIMPLE), BLACK);
  const revealed: Session = guess(start, point(start.position, 'pd'));

  assert.equal(stoneAt(revealed.position, point(revealed.position, 'dd')), BLACK);
  assert.equal(stoneAt(revealed.position, point(revealed.position, 'pd')), 0);
});

test('guessing is refused while a reveal is showing', () => {
  const start: Session = startSession(load(SIMPLE), BLACK);
  const revealed: Session = guess(start, point(start.position, 'dd'));
  assert.throws(() => guess(revealed, point(revealed.position, 'cc')), SessionError);
});

test('an occupied point is not a legal guess', () => {
  const game: Game = load(SIMPLE);
  const session: Session = startSession(game, WHITE);

  assert.equal(canGuess(session, point(session.position, 'dd')), false);
  assert.throws(() => guess(session, point(session.position, 'dd')), SessionError);
});

test('nothing is guessable once the session is done', () => {
  const done: Session = endSession(startSession(load(SIMPLE), BLACK));
  assert.equal(canGuess(done, 0), false);
});

// ── Advancing ────────────────────────────────────────────────────────────────

test('advancing moves to the next prompt of the same color', () => {
  const start: Session = startSession(load(SIMPLE), BLACK);
  const next: Session = advance(guess(start, point(start.position, 'dd')));

  assert.equal(next.phase, 'prompt');
  assert.equal(next.move?.number, 3);
  assert.equal(next.move?.color, BLACK);
});

test('the opponent s intervening move is on the board at the next prompt', () => {
  const start: Session = startSession(load(SIMPLE), BLACK);
  const next: Session = advance(guess(start, point(start.position, 'dd')));

  assert.equal(stoneAt(next.position, point(next.position, 'pp')), WHITE, 'White played pp');
});

test('advancing is refused from a prompt — there is nothing revealed yet', () => {
  assert.throws(() => advance(startSession(load(SIMPLE), BLACK)), SessionError);
});

test('the cursor only ever moves forward', () => {
  let session: Session = startSession(load(SIMPLE), BLACK);
  const seen: number[] = [session.cursor];

  // Bounded deliberately: a cursor that failed to advance would otherwise
  // hang the suite instead of failing it, and a hang reads as infrastructure
  // trouble rather than as the bug it is.
  const limit: number = session.game.moves.length + 1;
  for (let step = 0; step < limit && session.phase === 'prompt'; step++) {
    assert.notEqual(session.move?.index, null);
    session = advance(guess(session, session.move?.index ?? 0));
    seen.push(session.cursor);
  }

  assert.equal(session.phase, 'done', 'the session should have run out of moves');
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
  assert.equal(new Set(seen).size, seen.length, 'no move is offered twice');
});

// ── Passes ───────────────────────────────────────────────────────────────────

test('a pass by the chosen color is never prompted', () => {
  const game: Game = load('(;SZ[19];B[dd];W[pp];B[];W[qq];B[cc])');
  const start: Session = startSession(game, BLACK);
  const next: Session = advance(guess(start, point(start.position, 'dd')));

  assert.equal(next.move?.number, 5, 'the pass at move 3 is skipped');
});

test('a pass by the opponent is played through without comment', () => {
  const game: Game = load('(;SZ[19];B[dd];W[];B[cc])');
  const start: Session = startSession(game, BLACK);
  const next: Session = advance(guess(start, point(start.position, 'dd')));

  assert.equal(next.move?.number, 3);
});

// ── Ending ───────────────────────────────────────────────────────────────────

test('the session ends when the record runs out', () => {
  let session: Session = startSession(load(SIMPLE), BLACK);
  for (let i = 0; i < 2; i++) {
    // Guess correctly both times so the loop terminates on the record, not a miss.
    session = advance(guess(session, session.move?.index ?? 0));
  }
  assert.equal(session.phase, 'done');
  assert.equal(session.move, null);
});

test('the final board is shown when the session ends', () => {
  let session: Session = startSession(load(SIMPLE), BLACK);
  for (let i = 0; i < 2; i++) session = advance(guess(session, session.move?.index ?? 0));

  assert.equal(stoneAt(session.position, point(session.position, 'qq')), WHITE);
});

test('ending early keeps the guesses already made', () => {
  const start: Session = startSession(load(SIMPLE), BLACK);
  const ended: Session = endSession(guess(start, point(start.position, 'dd')));

  assert.equal(ended.phase, 'done');
  assert.equal(ended.guesses.length, 1);
  assert.equal(score(ended).hits, 1);
});

test('advancing past the end is refused', () => {
  const done: Session = endSession(startSession(load(SIMPLE), BLACK));
  assert.throws(() => advance(done), SessionError);
});

// ── Scoring ──────────────────────────────────────────────────────────────────

test('score counts hits over guesses made', () => {
  const game: Game = load(SIMPLE);
  const start: Session = startSession(game, BLACK);
  const afterHit: Session = advance(guess(start, point(start.position, 'dd')));
  const afterMiss: Session = guess(afterHit, point(afterHit.position, 'qd'));

  const result: Score = score(afterMiss);
  assert.equal(result.hits, 1);
  assert.equal(result.guessed, 2);
  assert.equal(result.rate, 0.5);
});

test('total counts every prompt in the game, so ending early reads as partial', () => {
  const game: Game = load(SIMPLE);
  const ended: Session = endSession(startSession(game, BLACK));

  assert.equal(score(ended).total, 2);
  assert.equal(score(ended).guessed, 0);
});

test('the rate is over guesses made, not over the whole game', () => {
  // Ending after one hit of two prompts is 100%, not 50%: the user answered
  // everything they were asked. `guessed` against `total` is what says the
  // session was cut short.
  const game: Game = load(SIMPLE);
  const start: Session = startSession(game, BLACK);
  const ended: Session = endSession(guess(start, point(start.position, 'dd')));

  const result: Score = score(ended);
  assert.equal(result.rate, 1);
  assert.equal(result.guessed, 1);
  assert.equal(result.total, 2);
});

test('an untouched session scores zero rather than dividing by zero', () => {
  const result: Score = score(startSession(load(SIMPLE), BLACK));
  assert.equal(result.rate, 0);
  assert.equal(Number.isFinite(result.rate), true);
});

test('prompt counts exclude the opponent s moves and both sides passes', () => {
  const game: Game = load('(;SZ[19];B[dd];W[pp];B[];W[qq];B[cc])');
  assert.equal(countPrompts(game, BLACK), 2);
  assert.equal(countPrompts(game, WHITE), 2);
});

// ── Immutability ─────────────────────────────────────────────────────────────

test('transitions do not mutate the session they came from', () => {
  const start: Session = startSession(load(SIMPLE), BLACK);
  const revealed: Session = guess(start, point(start.position, 'dd'));
  advance(revealed);

  assert.equal(start.phase, 'prompt');
  assert.equal(start.guesses.length, 0);
  assert.equal(revealed.phase, 'reveal');
  assert.equal(revealed.guesses.length, 1);
});
