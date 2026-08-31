/**
 * The ladder search, on what `test/golden-v7.test.ts` cannot reach.
 *
 * That test is the authority on whether our ladders agree with KataGo's, and it
 * checks planes 14 and 17 against KataGo's own committed output. It cannot check
 * 15 and 16, which are the same search run on the two previous boards: the
 * fixture draws one position, and a drawing does not record what was captured,
 * so the earlier boards cannot be recovered from it.
 *
 * What is left for here is everything about the search that is not its verdict
 * on one position — that it takes its moves back, that reusing its scratch does
 * not corrupt the next answer, that the verdict actually responds to a ladder
 * breaker rather than being a constant, and that history composes the way
 * upstream composes it.
 *
 * The position below is the 7x7 case from the golden fixture, inlined so this
 * file reads on its own. KataGo says two black stones are caught in a ladder:
 * board indices 26 and 40.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLACK,
  WHITE,
  createBoard,
  emptyState,
  libertiesAt,
  type Board,
  type BoardState,
  type Stone,
} from '../src/engine/board.ts';
import {
  createLadderInputs,
  createLadderScratch,
  ladderInputs,
  ladderPlanes,
  type LadderInputs,
  type LadderPlanes,
} from '../src/engine/ladder.ts';

const POSITION: readonly string[] = [
  '. . . . . . .',
  '. . . . . X .',
  '. . . O . . .',
  '. . . X O X .',
  '. . X O . O .',
  '. X . X O X .',
  '. . . . O . .',
];

/** KataGo's verdict on the position above, from the golden fixture. */
const CAUGHT: readonly number[] = [26, 40];

interface Setup {
  readonly board: Board;
  readonly state: BoardState;
}

function setup(drawing: readonly string[] = POSITION): Setup {
  const size: number = drawing.length;
  const board: Board = createBoard(size, size);
  const state: BoardState = emptyState(board);

  drawing.forEach((line, row) => {
    line.split(' ').forEach((cell, col) => {
      if (cell === 'X') state.stones[row * size + col] = BLACK;
      else if (cell === 'O') state.stones[row * size + col] = WHITE;
    });
  });
  return { board, state };
}

function planes(board: Board): LadderPlanes {
  return { captured: new Uint8Array(board.area), workingMoves: new Uint8Array(board.area) };
}

/** The set bits of a plane, which is how every expectation here is written. */
function set(plane: Uint8Array): number[] {
  const points: number[] = [];
  plane.forEach((value, point) => {
    if (value) points.push(point);
  });
  return points;
}

test('finds the ladders KataGo finds', () => {
  const { board, state } = setup();
  const out: LadderPlanes = ladderPlanes(board, state, BLACK, createLadderScratch(board), planes(board));
  assert.deepEqual(set(out.captured), [...CAUGHT]);
});

test('a ladder breaker changes the verdict', () => {
  // Both caught stones are Black's, so a Black stone in the ladder's path is a
  // breaker. Without this the test above could pass on a search that answered
  // "caught" for everything with few liberties.
  const one = setup();
  one.state.stones[13] = BLACK;
  const first: LadderPlanes = ladderPlanes(
    one.board, one.state, BLACK, createLadderScratch(one.board), planes(one.board),
  );
  assert.deepEqual(set(first.captured), [40], 'a stone at 13 should save the stone at 26');

  const both = setup();
  both.state.stones[34] = BLACK;
  const second: LadderPlanes = ladderPlanes(
    both.board, both.state, BLACK, createLadderScratch(both.board), planes(both.board),
  );
  assert.deepEqual(set(second.captured), [], 'a stone at 34 should save both');
});

test('working moves are the opponent\'s to make', () => {
  const { board, state } = setup();
  const scratch = createLadderScratch(board);

  // Plane 17 is about ladders the player to move can start, so the caught
  // stones being Black's means Black has nothing to start.
  const mine: LadderPlanes = ladderPlanes(board, state, BLACK, scratch, planes(board));
  assert.deepEqual(set(mine.workingMoves), []);

  const theirs: LadderPlanes = ladderPlanes(board, state, WHITE, scratch, planes(board));
  assert.deepEqual(set(theirs.workingMoves), [19, 41, 47]);

  // Which stones are caught does not depend on whose turn it is.
  assert.deepEqual(set(theirs.captured), [...CAUGHT]);
});

test('only chains with one or two liberties are searched', () => {
  const { board, state } = setup([
    '. . . . . . .',
    '. . . . . . .',
    '. . . . . . .',
    '. . . X . . .',
    '. . . . . . .',
    '. . . . . . .',
    '. . . . . . .',
  ]);
  assert.equal(libertiesAt(board, state, 24, 4), 4);

  const out: LadderPlanes = ladderPlanes(board, state, WHITE, createLadderScratch(board), planes(board));
  assert.deepEqual(set(out.captured), []);
  assert.deepEqual(set(out.workingMoves), []);
});

test('the search leaves the position exactly as it found it', () => {
  // The search plays and takes back thousands of moves. One unbalanced undo
  // would leave a stone behind and quietly corrupt every later evaluation.
  const { board, state } = setup();
  const stones: Uint8Array = state.stones.slice();
  const koPoint: number = state.koPoint;

  ladderPlanes(board, state, BLACK, createLadderScratch(board), planes(board));

  assert.deepEqual([...state.stones], [...stones]);
  assert.equal(state.koPoint, koPoint);
});

test('reusing one scratch gives the same answers as a fresh one', () => {
  // Everything the search needs is allocated once and reused across every point
  // on the board and every position in a search. A stale stamp or an unreset
  // buffer would show up as an answer that depends on what was asked before.
  const { board, state } = setup();
  const shared = createLadderScratch(board);
  const expected: number[] = set(
    ladderPlanes(board, state, BLACK, createLadderScratch(board), planes(board)).captured,
  );

  const other = setup([
    '. . . . . . .',
    '. . . . . . .',
    '. . O X . . .',
    '. . O X . . .',
    '. . . O . . .',
    '. . . . . . .',
    '. . . . . . .',
  ]);

  for (let round = 0; round < 3; round++) {
    ladderPlanes(other.board, other.state, WHITE, shared, planes(other.board));
    const again: number[] = set(ladderPlanes(board, state, BLACK, shared, planes(board)).captured);
    assert.deepEqual(again, expected, `round ${round} disagreed with a fresh scratch`);
  }
});

test('history planes read the boards they are named for', () => {
  const { board, state } = setup();
  const scratch = createLadderScratch(board);

  // A board one move earlier, before White sealed the ladder at 34.
  const earlier: BoardState = { stones: state.stones.slice(), koPoint: -1 };
  earlier.stones[34] = BLACK;

  const out: LadderInputs = ladderInputs(
    board, state, earlier, earlier, BLACK, scratch, createLadderInputs(board),
  );

  assert.deepEqual(set(out.captured), [...CAUGHT], 'plane 14 reads the current board');
  assert.deepEqual(set(out.capturedPrev), [], 'plane 15 reads the previous board');
  assert.deepEqual(set(out.capturedPrevPrev), [], 'plane 16 reads the one before that');
});

test('missing history falls back to the current board, as upstream does', () => {
  // In the opening there is no previous position. KataGo encodes the current
  // board into planes 15 and 16 rather than an empty one, so a network trained
  // on that must see the same thing here.
  const { board, state } = setup();
  const out: LadderInputs = ladderInputs(
    board, state, undefined, undefined, BLACK, createLadderScratch(board), createLadderInputs(board),
  );

  assert.deepEqual(set(out.capturedPrev), [...CAUGHT]);
  assert.deepEqual(set(out.capturedPrevPrev), [...CAUGHT]);
});

test('an edge ladder runs to the corner', () => {
  // A lone stone on the 1-1 point has two liberties and no room to turn, so the
  // chase runs down the edge. Worth pinning because it is the case where the
  // search's depth limit and its move ordering matter most.
  const { board, state } = setup([
    'X . . . . . .',
    '. . . . . . .',
    '. . . . . . .',
    '. . . . . . .',
    '. . . . . . .',
    '. . . . . . .',
    '. . . . . . .',
  ]);
  const out: LadderPlanes = ladderPlanes(board, state, WHITE, createLadderScratch(board), planes(board));

  assert.deepEqual(set(out.captured), [0]);
  assert.deepEqual(set(out.workingMoves), [1, 7]);
});

test('a stone with room to run is not laddered', () => {
  const { board, state } = setup([
    '. . . . . . .',
    '. . . . . . .',
    '. . . . . . .',
    '. . O X . . .',
    '. . . . . . .',
    '. . . . . . .',
    '. . . . . . .',
  ]);
  const black: Stone = BLACK;
  assert.equal(state.stones[24], black);

  const out: LadderPlanes = ladderPlanes(board, state, WHITE, createLadderScratch(board), planes(board));
  assert.deepEqual(set(out.captured), []);
});
