/**
 * The engine's mutable board, checked against `rules.ts`.
 *
 * There are two board implementations in this project and only one of them can
 * be right. `rules.ts` is the authority — it decides what a user may click —
 * and `engine/board.ts` exists only because a tree search cannot afford an
 * immutable position per node. A disagreement between them is a bug in one, and
 * finding out which is time well spent, exactly as it was against kifu.
 *
 * The differential test below is the real instrument. A professional record is
 * a poor exercise for a board: pros do not play many captures, almost never a
 * ko, and never an illegal move. Random legal play does all three constantly,
 * so a few thousand seeded moves cover shapes no fixture would.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from '../src/sgf-parser.ts';
import { readGame, type Game, type GameMove } from '../src/game.ts';
import {
  BLACK as RULES_BLACK,
  WHITE as RULES_WHITE,
  createPosition,
  moveError,
  playRecorded,
  stoneAt,
  type Color,
  type MoveError,
  type Position,
} from '../src/rules.ts';
import {
  BLACK,
  EMPTY,
  WHITE,
  createBoard,
  emptyState,
  fromPosition,
  libertiesAt,
  passMove,
  playMove,
  toPosition,
  undoMove,
  type Board,
  type BoardState,
  type Undo,
} from '../src/engine/board.ts';

const FIXTURES: string = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Both boards' stones and ko point, as one comparable string. */
function render(position: Position): string {
  let out = '';
  for (let point = 0; point < position.stones.length; point++) {
    const stone: number = stoneAt(position, point);
    out += stone === RULES_BLACK ? 'b' : stone === RULES_WHITE ? 'w' : '.';
  }
  return `${out} ko=${position.koPoint ?? -1}`;
}

/** Deterministic xorshift, so a failure is reproducible from its seed alone. */
function random(seed: number): () => number {
  let state: number = seed | 0 || 1;
  return (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

// ── Agreement on a real record ───────────────────────────────────────────────

test('the two boards agree move by move over a real game', () => {
  const game: Game = readGame(parse(readFileSync(join(FIXTURES, '2024-07-09d.sgf'), 'utf8')));
  const board: Board = createBoard(game.cols, game.rows);
  const state: BoardState = fromPosition(board, game.initial);
  const captures: number[] = [];

  for (const move of game.moves) {
    const point: number = move.index ?? passMove(board);
    const player = move.color === RULES_BLACK ? BLACK : WHITE;
    const undo: Undo | null = playMove(board, state, point, player, captures);

    assert.ok(undo, `the engine refused move ${move.number}, which the record contains`);
    assert.equal(
      render(toPosition(board, state)),
      render(move.after),
      `boards diverged after move ${move.number}`,
    );
  }
  assert.equal(game.moves.length, 200);
});

// ── Differential test ────────────────────────────────────────────────────────

/**
 * Play random points on both boards at once and require them to agree about
 * everything: which moves are legal, what the board looks like afterwards, and
 * where the ko ban sits.
 */
function differential(
  cols: number,
  rows: number,
  seed: number,
  moves: number,
): { played: number; kosRefused: number } {
  const next = random(seed);
  const board: Board = createBoard(cols, rows);
  const state: BoardState = emptyState(board);
  const captures: number[] = [];

  let position: Position = createPosition(cols, rows);
  let color: Color = RULES_BLACK;
  let played = 0;
  let kosRefused = 0;

  for (let i = 0; i < moves; i++) {
    // Whenever a ko ban stands, try it. Random play sets one every few hundred
    // moves and then lands on that exact point essentially never, so without
    // this the differential covers captures and suicide thoroughly and the ko
    // rule not at all — which is the one both boards are most likely to get
    // subtly different.
    if (state.koPoint >= 0) {
      const banned: number = state.koPoint;
      assert.equal(
        moveError(position, banned, color),
        'ko',
        `seed ${seed}, move ${i}: engine banned ${banned} and rules did not`,
      );
      const refused: Undo | null = playMove(
        board,
        state,
        banned,
        color === RULES_BLACK ? BLACK : WHITE,
        captures,
      );
      assert.equal(refused, null, `seed ${seed}, move ${i}: the engine allowed a ko retake`);
      kosRefused++;
    }

    const point: number = Math.floor(next() * cols * rows);
    const player = color === RULES_BLACK ? BLACK : WHITE;

    const error: MoveError | null = moveError(position, point, color);
    const undo: Undo | null = playMove(board, state, point, player, captures);

    assert.equal(
      undo !== null,
      error === null,
      `seed ${seed}, move ${i} at ${point}: rules says ${error ?? 'legal'}, engine says ` +
        `${undo ? 'legal' : 'illegal'}`,
    );

    if (!undo) continue;
    position = playRecorded(position, point, color).position;
    assert.equal(
      render(toPosition(board, state)),
      render(position),
      `seed ${seed}, move ${i} at ${point}: boards diverged`,
    );
    color = -color as Color;
    played++;
  }
  return { played, kosRefused };
}

test('the boards agree over thousands of random moves on 19x19', () => {
  const { played } = differential(19, 19, 12345, 3000);
  assert.ok(played > 200, `expected a real game, got ${played} legal moves`);
});

test('the boards agree on small boards, where groups die constantly', () => {
  // Small boards are the interesting ones: captures and kos arrive orders of
  // magnitude more often than on 19x19, so this is where the rules actually get
  // exercised rather than merely visited.
  let kos = 0;
  for (const seed of [1, 7, 99, 2024, 31337, 8, 64, 512]) {
    kos += differential(7, 7, seed, 1500).kosRefused;
    kos += differential(9, 9, seed, 1500).kosRefused;
  }
  // Guards the test rather than the code: if a change to the generator stopped
  // producing kos, this would keep passing while covering nothing.
  assert.ok(kos > 20, `the differential only refused ${kos} ko retakes`);
});

test('the boards agree on 13x13 and on a rectangular board', () => {
  differential(13, 13, 555, 2000);
  // Rectangular is the case upstream cannot represent at all.
  differential(9, 13, 777, 1500);
});

// ── Taking moves back ────────────────────────────────────────────────────────

test('undoing a move restores the board exactly, captures included', () => {
  // The property the whole search rests on: descend, evaluate, come back, and
  // find the position you left. A capture that is not put back is a stone the
  // engine believes it took, for the rest of the search.
  const next = random(4242);
  const board: Board = createBoard(9, 9);
  const state: BoardState = emptyState(board);
  const captures: number[] = [];
  let color: Color = RULES_BLACK;

  for (let i = 0; i < 400; i++) {
    const point: number = Math.floor(next() * 81);
    const player = color === RULES_BLACK ? BLACK : WHITE;
    const before: string = render(toPosition(board, state));
    const depth: number = captures.length;

    const undo: Undo | null = playMove(board, state, point, player, captures);
    if (!undo) {
      assert.equal(render(toPosition(board, state)), before, 'a refused move left a trace');
      assert.equal(captures.length, depth, 'a refused move left stones on the capture stack');
      continue;
    }

    undoMove(board, state, point, player, undo, captures);
    assert.equal(render(toPosition(board, state)), before, `undo did not restore at move ${i}`);
    assert.equal(captures.length, depth, 'undo left the capture stack longer than it found it');

    // Play it for real this time, so the game moves on.
    playMove(board, state, point, player, captures);
    color = -color as Color;
  }
});

test('a whole descent unwinds back to where it started', () => {
  const board: Board = createBoard(9, 9);
  const state: BoardState = emptyState(board);
  const captures: number[] = [];
  const start: string = render(toPosition(board, state));

  const line: number[] = [40, 41, 31, 32, 49, 50, 39, 30];
  const undos: Undo[] = [];
  for (const [ply, point] of line.entries()) {
    const undo: Undo | null = playMove(board, state, point, ply % 2 === 0 ? BLACK : WHITE, captures);
    assert.ok(undo, `move ${point} should be legal`);
    undos.push(undo);
  }
  for (let ply = line.length - 1; ply >= 0; ply--) {
    undoMove(board, state, line[ply], ply % 2 === 0 ? BLACK : WHITE, undos[ply], captures);
  }

  assert.equal(render(toPosition(board, state)), start);
  assert.equal(captures.length, 0);
});

// ── Specific shapes ──────────────────────────────────────────────────────────

test('a pass clears the ko ban and takes no stone', () => {
  const board: Board = createBoard(9, 9);
  const state: BoardState = emptyState(board);
  const captures: number[] = [];

  state.koPoint = 40;
  const undo: Undo | null = playMove(board, state, passMove(board), BLACK, captures);
  assert.ok(undo);
  assert.equal(state.koPoint, -1);
  assert.equal(captures.length, 0);

  undoMove(board, state, passMove(board), BLACK, undo, captures);
  assert.equal(state.koPoint, 40, 'undoing a pass restores the ko ban it cleared');
});

test('suicide is refused, and a move that captures first is not suicide', () => {
  const board: Board = createBoard(9, 9);
  const state: BoardState = emptyState(board);
  const captures: number[] = [];

  // White surrounds the corner point 0; Black may not fill it.
  for (const point of [1, 9]) state.stones[point] = WHITE;
  assert.equal(playMove(board, state, 0, BLACK, captures), null);
  assert.equal(state.stones[0], EMPTY, 'a refused suicide left a stone behind');

  // Give White's stones no liberties of their own and the same point captures.
  const second: BoardState = emptyState(board);
  second.stones[1] = WHITE;
  second.stones[9] = WHITE;
  second.stones[2] = BLACK;
  second.stones[10] = BLACK;
  second.stones[18] = BLACK;
  assert.ok(playMove(board, second, 0, BLACK, captures), 'capturing first is legal');
  assert.equal(second.stones[1], EMPTY);
});

test('the ko shape behaves identically on both boards', () => {
  /*
   *   . b w .
   *   b . b w      White takes at (1,1); Black may not retake at (1,2).
   *   . b w .
   *
   * The same diagram `test/rules.test.ts` uses, so the two boards are being
   * asked about a shape one of them is already known to get right.
   */
  const board: Board = createBoard(4, 3);
  const state: BoardState = emptyState(board);
  const captures: number[] = [];
  const layout = '.bw.b.bw.bw.';
  for (const [point, ch] of [...layout].entries()) {
    if (ch === 'b') state.stones[point] = BLACK;
    if (ch === 'w') state.stones[point] = WHITE;
  }

  const take = 5; // (1,1)
  const banned = 6; // (1,2)
  const undo: Undo | null = playMove(board, state, take, WHITE, captures);
  assert.ok(undo, 'White should be able to take');
  assert.equal(captures.length, 1, 'exactly one stone comes off');
  assert.equal(state.koPoint, banned, 'the emptied point is banned');

  assert.equal(playMove(board, state, banned, BLACK, captures), null, 'the retake is refused');

  // Any other move lifts the ban, and so does a pass.
  const elsewhere: Undo | null = playMove(board, state, 0, BLACK, captures);
  assert.ok(elsewhere);
  assert.equal(state.koPoint, -1, 'the ban lifts after a move elsewhere');
  assert.ok(playMove(board, state, banned, WHITE, captures), 'and the point is playable again');
});

test('liberties are counted, and capped where asked', () => {
  const board: Board = createBoard(9, 9);
  const state: BoardState = emptyState(board);
  state.stones[40] = BLACK;

  assert.equal(libertiesAt(board, state, 40), 4);
  assert.equal(libertiesAt(board, state, 40, 2), 2, 'the cap stops the count early');
  assert.equal(libertiesAt(board, state, 0), 0, 'an empty point has no group');
});

test('a converted position round-trips through the engine encoding', () => {
  const game: Game = readGame(parse(readFileSync(join(FIXTURES, '2024-07-09d.sgf'), 'utf8')));
  const board: Board = createBoard(game.cols, game.rows);
  const move: GameMove = game.moves[120];

  assert.equal(render(toPosition(board, fromPosition(board, move.after))), render(move.after));
});
