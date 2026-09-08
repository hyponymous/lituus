/**
 * The variation walk: what a line looks like once it has been played out.
 *
 * These are the cases the end position cannot show on its own — a capture, a
 * recapture, a stone that vanishes — which is precisely why the mode replays
 * the line instead of pinning markers to the position before it (design
 * §6.2). The drawing is checked by eye; the arithmetic is checked here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { footnoteLine, variationFrom, type Variation } from '../src/variation.ts';
import {
  BLACK,
  EMPTY,
  WHITE,
  createPosition,
  fromStones,
  stoneAt,
  toIndex,
  type Position,
} from '../src/rules.ts';

/** Labels by board index, which is what the board actually shows. */
const labels = (line: Variation): Record<number, string> =>
  Object.fromEntries(line.markers.map((mark) => [mark.index, mark.label ?? '']));

test('a line is numbered from one and alternates colour from the side to move', () => {
  const empty: Position = createPosition(9, 9);
  const line: Variation = variationFrom(empty, [40, 41, 30], WHITE);

  assert.equal(line.plies, 3);
  assert.equal(line.stopped, null);
  assert.deepEqual(labels(line), { 40: '1', 41: '2', 30: '3' });
  assert.equal(stoneAt(line.position, 40), WHITE, 'the first ply belongs to the side to move');
  assert.equal(stoneAt(line.position, 41), BLACK);
  assert.equal(stoneAt(line.position, 30), WHITE);
  assert.equal(footnoteLine(line), '', 'nothing the position cannot say for itself');
});

test('an empty line is the position it started from', () => {
  const empty: Position = createPosition(9, 9);
  const line: Variation = variationFrom(empty, [], BLACK);

  assert.equal(line.plies, 0);
  assert.equal(line.position, empty);
  assert.deepEqual(line.markers, []);
});

test('a line that captures shows the capture, which is the whole point', () => {
  // A white stone on the edge with one liberty left; the line takes it.
  const board: Position = createPosition(5, 5);
  const white: number = toIndex(board, 0, 0);
  const stones = new Int8Array(25);
  stones[white] = WHITE;
  stones[toIndex(board, 1, 0)] = BLACK;
  const before: Position = fromStones(5, 5, stones);

  const line: Variation = variationFrom(before, [toIndex(board, 0, 1)], BLACK);

  assert.equal(stoneAt(line.position, white), EMPTY, 'the stone the line took is gone');
  assert.deepEqual(labels(line), { [toIndex(board, 0, 1)]: '1' });
  assert.equal(footnoteLine(line), '', 'a captured stone of the record needs no note');
});

/**
 * The ko shape, on the top edge of a 5x5:
 *
 * ```
 *   O . O X .      A = (0,1), B = (0,2)
 *   . O X . .
 * ```
 *
 * Black takes at A, White retakes at B, Black takes at A again. Both of the
 * footnote's causes fall out of the one line: ply 1's point ends up carrying
 * ply 3's number, and ply 2's stone is captured with nothing replacing it.
 */
test('a recapture leaves two plies the end position cannot name', () => {
  const board: Position = createPosition(5, 5);
  const a: number = toIndex(board, 0, 1);
  const b: number = toIndex(board, 0, 2);
  const stones = new Int8Array(25);
  stones[toIndex(board, 0, 0)] = WHITE;
  stones[toIndex(board, 1, 1)] = WHITE;
  stones[b] = WHITE;
  stones[toIndex(board, 0, 3)] = BLACK;
  stones[toIndex(board, 1, 2)] = BLACK;
  const before: Position = fromStones(5, 5, stones);

  const line: Variation = variationFrom(before, [a, b, a], BLACK);

  assert.equal(line.plies, 3, 'a ko retake is played out rather than truncating the line');
  assert.equal(stoneAt(line.position, a), BLACK);
  assert.equal(stoneAt(line.position, b), EMPTY);
  assert.deepEqual(labels(line), { [a]: '3' }, 'the number shown is the stone that is there');
  assert.deepEqual(line.footnotes, [
    { ply: 1, point: a, at: 3 },
    { ply: 2, point: b, at: null },
  ]);
  assert.equal(footnoteLine(line), '1 at 3 (B5) · 2 captured (C5)');
});

test('a suicide is played out, and the ply that vanished says where it went', () => {
  const board: Position = createPosition(5, 5);
  const corner: number = toIndex(board, 0, 0);
  const stones = new Int8Array(25);
  stones[toIndex(board, 0, 1)] = WHITE;
  stones[toIndex(board, 1, 0)] = WHITE;
  const before: Position = fromStones(5, 5, stones);

  const line: Variation = variationFrom(before, [corner], BLACK);

  assert.equal(line.plies, 1, 'suicide is a difference of ruleset, not a broken line');
  assert.equal(stoneAt(line.position, corner), EMPTY);
  assert.deepEqual(line.markers, [], 'and no marker for a stone that is not on the board');
  assert.equal(footnoteLine(line), '1 captured (A5)');
});

test('a line stops at a point already occupied rather than overwriting it', () => {
  const board: Position = createPosition(9, 9);
  const taken: number = toIndex(board, 4, 4);
  const stones = new Int8Array(81);
  stones[taken] = WHITE;
  const before: Position = fromStones(9, 9, stones);

  const line: Variation = variationFrom(before, [toIndex(board, 3, 3), taken, 0], BLACK);

  assert.equal(line.plies, 1);
  assert.equal(line.stopped, 'occupied');
  assert.equal(stoneAt(line.position, taken), WHITE, 'the stone that was there is still there');
});

test('a line stops at a pass, which says nothing a reader can use', () => {
  const empty: Position = createPosition(9, 9);
  const line: Variation = variationFrom(empty, [40, 81, 30], BLACK);

  assert.equal(line.plies, 1);
  assert.equal(line.stopped, 'pass');
  assert.deepEqual(labels(line), { 40: '1' });
});
