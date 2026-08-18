import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLACK,
  WHITE,
  createPosition,
  fromStones,
  isLegal,
  moveError,
  pass,
  play,
  playRecorded,
  stoneAt,
  toIndex,
  type Color,
  type MoveResult,
  type Position,
} from '../src/rules.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a position from an ASCII diagram: 'b' black, 'w' white, '.' empty.
 * Whitespace between rows only; every row must be the same length.
 */
function diagram(...rows: string[]): Position {
  const cols: number = rows[0].length;
  const stones: number[] = [];
  for (const row of rows) {
    assert.equal(row.length, cols, `ragged diagram row: "${row}"`);
    for (const ch of row) {
      stones.push(ch === 'b' ? BLACK : ch === 'w' ? WHITE : 0);
    }
  }
  return fromStones(cols, rows.length, stones);
}

function render(pos: Position): string[] {
  const out: string[] = [];
  for (let row = 0; row < pos.rows; row++) {
    let line = '';
    for (let col = 0; col < pos.cols; col++) {
      const point: number = stoneAt(pos, toIndex(pos, row, col));
      line += point === BLACK ? 'b' : point === WHITE ? 'w' : '.';
    }
    out.push(line);
  }
  return out;
}

function playAt(pos: Position, row: number, col: number, color: Color): MoveResult {
  return play(pos, toIndex(pos, row, col), color);
}

// ── Placing stones ───────────────────────────────────────────────────────────

test('a stone lands on the board and the position is new', () => {
  const empty: Position = createPosition(9, 9);
  const { position } = playAt(empty, 4, 4, BLACK);
  assert.equal(stoneAt(position, toIndex(position, 4, 4)), BLACK);
  assert.equal(stoneAt(empty, toIndex(empty, 4, 4)), 0, 'original position unchanged');
});

test('an occupied point is rejected', () => {
  const pos: Position = diagram(
    '...',
    '.b.',
    '...',
  );
  assert.equal(moveError(pos, toIndex(pos, 1, 1), WHITE), 'occupied');
  assert.equal(moveError(pos, toIndex(pos, 1, 1), BLACK), 'occupied');
});

test('an off-board index is rejected', () => {
  const pos: Position = createPosition(9, 9);
  assert.equal(moveError(pos, -1, BLACK), 'off-board');
  assert.equal(moveError(pos, 81, BLACK), 'off-board');
});

// ── Captures ─────────────────────────────────────────────────────────────────

test('a surrounded stone is captured', () => {
  const pos: Position = diagram(
    '.b.',
    'bw.',
    '.b.',
  );
  const { position, captured } = playAt(pos, 1, 2, BLACK);
  assert.deepEqual(captured, [toIndex(pos, 1, 1)]);
  assert.deepEqual(render(position), ['.b.', 'b.b', '.b.']);
});

test('a stone in the corner needs only two stones to capture', () => {
  const pos: Position = diagram(
    'w..',
    'b..',
    '...',
  );
  const { position, captured } = playAt(pos, 0, 1, BLACK);
  assert.equal(captured.length, 1);
  assert.deepEqual(render(position), ['.b.', 'b..', '...']);
});

test('a multi-stone group is captured together', () => {
  const pos: Position = diagram(
    '.bb.',
    'bww.',
    '.bb.',
  );
  const { position, captured } = playAt(pos, 1, 3, BLACK);
  assert.equal(captured.length, 2);
  assert.deepEqual(render(position), ['.bb.', 'b..b', '.bb.']);
});

test('one move can capture two separate groups', () => {
  // Both white stones share their last liberty at (1,2).
  const pos: Position = diagram(
    '.b.b.',
    'bw.wb',
    '.bbb.',
  );
  const { position, captured } = playAt(pos, 1, 2, BLACK);
  assert.equal(captured.length, 2, 'both white stones die');
  assert.deepEqual(render(position), ['.b.b.', 'b.b.b', '.bbb.']);
});

test('capturing takes priority over suicide', () => {
  // Black's group has no liberty of its own, but it kills the white group
  // first, and the emptied points become its liberties.
  const pos: Position = diagram(
    '.bwb',
    'bww.',
    '.bwb',
  );
  const { position, captured } = playAt(pos, 1, 3, BLACK);
  assert.equal(captured.length, 4);
  assert.deepEqual(render(position), ['.b.b', 'b..b', '.b.b']);
});

// ── Suicide ──────────────────────────────────────────────────────────────────

test('filling your own last liberty is suicide', () => {
  const pos: Position = diagram(
    '.w.',
    'w.w',
    '.w.',
  );
  assert.equal(moveError(pos, toIndex(pos, 1, 1), BLACK), 'suicide');
  assert.equal(isLegal(pos, toIndex(pos, 1, 1), WHITE), true, 'white may fill its own eye');
});

test('joining a group into a dead shape is suicide', () => {
  const pos: Position = diagram(
    '.ww.',
    'wb.w',
    '.ww.',
  );
  assert.equal(moveError(pos, toIndex(pos, 1, 2), BLACK), 'suicide');
});

test('a recorded suicide is replayed rather than rejected', () => {
  const pos: Position = diagram(
    '.w.',
    'w.w',
    '.w.',
  );
  const { position } = playRecorded(pos, toIndex(pos, 1, 1), BLACK);
  assert.deepEqual(render(position), ['.w.', 'w.w', '.w.'], 'the dead stone is removed');
});

// ── Ko ───────────────────────────────────────────────────────────────────────

/**
 *   . b w .
 *   b . b w      Black to take at (1,1) sets up the ko: White may not
 *   . b w .      immediately retake at (1,2).
 */
function koPosition(): Position {
  return diagram(
    '.bw.',
    'b.bw',
    '.bw.',
  );
}

test('taking a single stone with a single stone sets a ko ban', () => {
  const pos: Position = koPosition();
  const { position, captured } = playAt(pos, 1, 1, WHITE);
  assert.equal(captured.length, 1);
  assert.equal(position.koPoint, toIndex(pos, 1, 2), 'the emptied point is banned');
  assert.equal(moveError(position, toIndex(position, 1, 2), BLACK), 'ko');
});

test('the ko ban lifts after any other move', () => {
  const pos: Position = koPosition();
  const afterTake = playAt(pos, 1, 1, WHITE).position;
  const elsewhere = play(afterTake, toIndex(afterTake, 0, 0), BLACK).position;
  assert.equal(elsewhere.koPoint, null);
  assert.equal(isLegal(elsewhere, toIndex(elsewhere, 1, 2), WHITE), true);
});

test('a pass clears the ko ban', () => {
  const pos: Position = koPosition();
  const afterTake = playAt(pos, 1, 1, WHITE).position;
  assert.notEqual(afterTake.koPoint, null);
  assert.equal(pass(afterTake).koPoint, null);
});

test('capturing two stones is not a ko', () => {
  const pos: Position = diagram(
    '.bb.',
    'bww.',
    '.bb.',
  );
  const { position } = playAt(pos, 1, 3, BLACK);
  assert.equal(position.koPoint, null, 'two stones taken cannot be retaken at once');
});

test('snapback: retaking is not banned as a ko', () => {
  // Black has thrown in at (2,3). White captures it at (2,2) — but that
  // fills white's own shape, leaving the group in atari, and Black takes all
  // five back at (2,3). The ko ban must not fire: white's capturing group is
  // five stones, not the lone stone that makes a ko.
  // The white ring's only liberties are its two-point eye. Black has thrown
  // in at (3,3); the outer black wall keeps its own liberties on the border.
  const pos: Position = diagram(
    '........',
    '.bbbbbb.',
    '.bwwwwb.',
    '.bwb.wb.',
    '.bwwwwb.',
    '.bbbbbb.',
    '........',
  );
  const { position, captured } = playAt(pos, 3, 4, WHITE);
  assert.equal(captured.length, 1, 'white takes the throw-in stone');
  assert.equal(position.koPoint, null, 'an eleven-stone group is not a ko shape');

  const back = play(position, toIndex(position, 3, 3), BLACK);
  assert.equal(back.captured.length, 11, 'black snaps back the whole ring');
});
