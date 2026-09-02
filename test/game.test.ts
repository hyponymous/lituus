/**
 * Game model tests: reading a parsed SGF tree as one playable game.
 *
 * These use hand-written records rather than fixtures, because the cases worth
 * pinning down are the awkward ones — handicap, passes, mid-game setup, a
 * collection of several games — and a real record contains at most one of them.
 * The corpus check covers agreement with reality.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/sgf-parser.ts';
import {
  GameError,
  describe,
  pointIndex,
  promptableMoves,
  readGame,
  type Game,
  type GameMove,
} from '../src/game.ts';
import { BLACK, EMPTY, WHITE, stoneAt, type Position } from '../src/rules.ts';

function load(sgf: string): Game {
  return readGame(parse(sgf));
}

/** Stone at an SGF point ('dd'), for asserting about setup. */
function at(pos: Position, point: string): number {
  const index: number | null = pointIndex(pos, point);
  if (index === null) assert.fail(`"${point}" is not a point on this board`);
  return stoneAt(pos, index);
}

function stoneCount(pos: Position): number {
  return pos.stones.reduce((total, point) => total + (point === EMPTY ? 0 : 1), 0);
}

// ── Board size ───────────────────────────────────────────────────────────────

test('board size defaults to 19 when SZ is absent', () => {
  const game: Game = load('(;GM[1];B[dd])');
  assert.equal(game.cols, 19);
  assert.equal(game.rows, 19);
});

test('square SZ sets both dimensions', () => {
  const game: Game = load('(;SZ[9];B[ee])');
  assert.deepEqual([game.cols, game.rows], [9, 9]);
});

test('rectangular SZ is read as cols:rows', () => {
  const game: Game = load('(;SZ[9:13];B[ee])');
  assert.deepEqual([game.cols, game.rows], [9, 13]);
});

test('a nonsense board size is refused with a readable message', () => {
  assert.throws(() => load('(;SZ[banana];B[dd])'), (error: unknown) => {
    assert.ok(error instanceof GameError);
    assert.match(error.message, /board size "banana"/);
    return true;
  });
});

test('an absurd board size is refused', () => {
  assert.throws(() => load('(;SZ[500];B[dd])'), GameError);
});

// ── Main line ────────────────────────────────────────────────────────────────

test('the main line follows the first variation at every branch', () => {
  const game: Game = load('(;SZ[19];B[dd](;W[pp];B[cc])(;W[qq];B[cq]))');
  assert.deepEqual(
    game.moves.map((move) => move.index),
    ['dd', 'pp', 'cc'].map((point) => pointIndex(game.initial, point)),
  );
});

test('a record with variations says so, so the user is not misled', () => {
  const game: Game = load('(;SZ[19];B[dd](;W[pp])(;W[qq]))');
  assert.equal(game.notes.length, 1);
  assert.match(game.notes[0], /main line/);
});

test('a record without variations carries no notes', () => {
  assert.deepEqual(load('(;SZ[19];B[dd];W[pp])').notes, []);
});

// ── Collections ──────────────────────────────────────────────────────────────

test('a collection takes the first game and admits it', () => {
  const game: Game = load('(;SZ[19];B[dd])(;SZ[19];B[pp])(;SZ[19];B[cc])');
  assert.equal(game.moves.length, 1);
  assert.equal(game.moves[0].index, pointIndex(game.initial, 'dd'));
  assert.equal(game.notes.length, 1);
  assert.match(game.notes[0], /3 games/);
});

// ── Setup and handicap ───────────────────────────────────────────────────────

test('handicap stones are on the board before move 1', () => {
  const game: Game = load('(;SZ[19]HA[4]AB[dd][pd][dp][pp];W[qq];B[cc])');

  for (const point of ['dd', 'pd', 'dp', 'pp']) {
    assert.equal(at(game.initial, point), BLACK, `expected a black stone at ${point}`);
  }
  assert.equal(game.meta.handicap, 4);
});

test('a handicap game starts with White to play', () => {
  const game: Game = load('(;SZ[19]HA[2]AB[dd][pp];W[qq];B[cc])');
  assert.equal(game.moves[0].color, WHITE);
  assert.equal(game.moves[0].number, 1);
});

test('the starting position is what the guesser sees before move 1', () => {
  const game: Game = load('(;SZ[19]HA[2]AB[dd][pp];W[qq])');
  assert.equal(game.moves[0].before, game.initial);
});

test('the starting position does not drift forward as the game is replayed', () => {
  // It would be easy to leave `initial` pointing at the latest position rather
  // than the first, and a one-move record would never notice.
  const game: Game = load('(;SZ[19]HA[2]AB[dd][pp];W[qq];B[cc];W[cq];B[dq])');
  assert.equal(stoneCount(game.initial), 2, 'only the handicap stones are placed');
  assert.equal(stoneCount(game.moves.at(-1)?.after ?? game.initial), 6);
});

test('AW places white setup stones', () => {
  const game: Game = load('(;SZ[19]AB[dd]AW[pp];B[cc])');
  assert.equal(at(game.initial, 'dd'), BLACK);
  assert.equal(at(game.initial, 'pp'), WHITE);
});

test('setup arriving mid-game is applied to the running position', () => {
  const game: Game = load('(;SZ[19];B[dd];W[pp];AE[dd];B[cc])');
  const last: GameMove = game.moves[2];
  assert.equal(at(last.before, 'dd'), EMPTY, 'AE should have cleared the stone');
  assert.equal(at(game.initial, 'dd'), EMPTY, 'the stone was played, not set up');
});

test('handicap is only reported when it means something', () => {
  assert.equal(load('(;SZ[19];B[dd])').meta.handicap, undefined);
  assert.equal(load('(;SZ[19]HA[0];B[dd])').meta.handicap, undefined);
});

// ── Passes ───────────────────────────────────────────────────────────────────

test('an empty move value is a pass, kept in the record', () => {
  const game: Game = load('(;SZ[19];B[dd];W[];B[pp])');
  assert.equal(game.moves.length, 3);
  assert.equal(game.moves[1].index, null);
  assert.equal(game.moves[1].color, WHITE);
});

test('the historical tt is a pass on boards up to 19', () => {
  const game: Game = load('(;SZ[19];B[dd];W[tt];B[pp])');
  assert.equal(game.moves[1].index, null);
});

test('a pass leaves the board untouched but still consumes a move number', () => {
  const game: Game = load('(;SZ[19];B[dd];W[];B[pp])');
  assert.deepEqual(game.moves[1].after.stones, game.moves[1].before.stones);
  assert.deepEqual(game.moves.map((move) => move.number), [1, 2, 3]);
});

test('a pass is a prompt like any other move of that color', () => {
  const game: Game = load('(;SZ[19];B[dd];W[pp];B[];W[qq];B[cc])');
  const prompts: GameMove[] = promptableMoves(game, BLACK);
  assert.deepEqual(
    prompts.map((move) => move.number),
    [1, 3, 5],
    'the black pass at move 3 is asked about too',
  );
  assert.equal(prompts[1].index, null, 'and it carries no point');
});

test('promptable moves are filtered to the chosen color', () => {
  const game: Game = load('(;SZ[19];B[dd];W[pp];B[cc];W[qq])');
  assert.deepEqual(promptableMoves(game, WHITE).map((move) => move.number), [2, 4]);
});

// ── Captures ─────────────────────────────────────────────────────────────────

test('a move records what it captured', () => {
  // Black surrounds a lone white stone in the corner: W a1, B b1 and a2.
  const game: Game = load('(;SZ[9];W[aa];B[ba];W[ii];B[ab])');
  const capture: GameMove = game.moves[3];
  assert.deepEqual(capture.captured, [pointIndex(game.initial, 'aa')]);
  assert.equal(at(capture.after, 'aa'), EMPTY);
  assert.equal(at(capture.before, 'aa'), WHITE);
});

// ── Metadata ─────────────────────────────────────────────────────────────────

test('header fields are read, and absent ones stay undefined', () => {
  const game: Game = load(
    '(;SZ[19]PB[Ke Jie]BR[9p]PW[Ichiriki Ryo]WR[9p]RE[W+R]KM[7.5]DT[2024-07-09];B[dd])',
  );
  assert.equal(game.meta.blackName, 'Ke Jie');
  assert.equal(game.meta.whiteRank, '9p');
  assert.equal(game.meta.result, 'W+R');
  assert.equal(game.meta.komi, '7.5');
  assert.equal(game.meta.event, undefined);
});

test('an empty header value counts as absent', () => {
  assert.equal(load('(;SZ[19]PB[];B[dd])').meta.blackName, undefined);
});

test('describe names both players, tolerating missing ones', () => {
  assert.equal(
    describe(load('(;SZ[19]PB[Ke Jie]BR[9p]PW[Ichiriki Ryo];B[dd])')),
    'Ke Jie 9p vs Ichiriki Ryo',
  );
  assert.equal(describe(load('(;SZ[19];B[dd])')), '? vs ?');
});

// ── Refusals ─────────────────────────────────────────────────────────────────

test('a record with no moves is refused rather than started', () => {
  assert.throws(() => load('(;SZ[19]PB[nobody])'), (error: unknown) => {
    assert.ok(error instanceof GameError);
    assert.match(error.message, /no moves/);
    return true;
  });
});

test('an empty collection is refused', () => {
  assert.throws(() => readGame([]), GameError);
});
