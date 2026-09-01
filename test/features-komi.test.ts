/**
 * Global 5, the self-komi — and the territory-scoring chill folded into it.
 *
 * This plane cost more debugging than the rest of the encoder together, so it
 * gets a test of its own rather than a line in a larger one.
 *
 * Under territory scoring a played stone fills your own territory, so it is
 * worth a point less than the same stone under area scoring. KataGo folds that
 * into the komi instead of the board: `boardhistory.cpp` adds a point to
 * White's komi for every Black move and takes one away for every White move.
 * The result is *not* symmetric between the players — with komi 8 and Black one
 * stone ahead, White's self-komi is +9 while Black's is -8 — which is exactly
 * why the bug read as a colour problem for so long and was not one.
 *
 * Getting this wrong is invisible: the network answers a slightly different
 * question and returns a confident, plausible number about a point off. The
 * figures below are KataGo's own, dumped from `NNInputs::fillRowV7` via
 * `experiments/katago/dump-inputs.cpp`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLACK,
  WHITE,
  createBoard,
  emptyState,
  type Board,
  type BoardState,
  type Stone,
} from '../src/engine/board.ts';
import { buildFeatures, createFeatureScratch, type Inputs } from '../src/engine/features-v7.ts';

const SIZE = 19;

/** Global 5 for a position with the given move counts and player to move. */
function selfKomi(
  toPlay: Stone,
  movesPlayed: { black: number; white: number },
  komi = 8,
): number {
  const board: Board = createBoard(SIZE, SIZE);
  const state: BoardState = emptyState(board);
  const inputs: Inputs = buildFeatures(
    { board, state, toPlay, history: [], komi, movesPlayed, ruleset: 'territory' },
    createFeatureScratch(board),
  );
  // Global 5 is the self-komi over twenty; undo the scaling so the expectations
  // below can be read as points. Rounded because the value has been through a
  // Float32Array, which turns 8 into 8.00000011920929 — a difference four
  // orders of magnitude below anything this test is about.
  // The `+ 0` is not decoration: a komi of zero negated for Black is -0, which
  // fails a strict comparison against 0 and reads as a bug that is not there.
  return Math.round(inputs.global[5] * 20 * 1e4) / 1e4 + 0;
}

test('self-komi is negated for Black when the move counts are level', () => {
  assert.equal(selfKomi(WHITE, { black: 0, white: 0 }), 8);
  assert.equal(selfKomi(BLACK, { black: 0, white: 0 }), -8);
  assert.equal(selfKomi(WHITE, { black: 12, white: 12 }), 8);
  assert.equal(selfKomi(BLACK, { black: 12, white: 12 }), -8);
});

test('a stone played chills the komi by a point', () => {
  // KataGo's own numbers for komi 8 after one black stone: White sees +9.
  assert.equal(selfKomi(WHITE, { black: 1, white: 0 }), 9);
  assert.equal(selfKomi(WHITE, { black: 3, white: 2 }), 9);

  // And the asymmetry that made this hard to see: Black one stone behind gets
  // -7, not the -9 a naive negation of White's value would give.
  assert.equal(selfKomi(BLACK, { black: 0, white: 1 }), -7);
});

test('the chill follows the move difference, not the move count', () => {
  assert.equal(selfKomi(BLACK, { black: 40, white: 40 }), -8);
  assert.equal(selfKomi(BLACK, { black: 41, white: 40 }), -9);
  assert.equal(selfKomi(BLACK, { black: 40, white: 41 }), -7);
});

test('komi still reaches the plane', () => {
  assert.equal(selfKomi(BLACK, { black: 0, white: 0 }, 0), 0);
  assert.equal(selfKomi(WHITE, { black: 0, white: 0 }, 6.5), 6.5);
  assert.equal(selfKomi(WHITE, { black: 1, white: 0 }, 0), 1);
});

test('self-komi is bounded the way upstream bounds it', () => {
  // `NNPos::KOMI_CLIP_RADIUS` past the board area. Unreachable in a real game,
  // but the network was never shown anything outside this range.
  const limit: number = SIZE * SIZE + 20;
  assert.equal(selfKomi(WHITE, { black: 0, white: 0 }, 10_000), limit);
  assert.equal(selfKomi(BLACK, { black: 0, white: 0 }, 10_000), -limit);
});
