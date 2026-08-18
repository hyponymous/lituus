/**
 * Corpus check: replay a real game record move by move with our rules engine
 * and compare the result against kifu's independent implementation.
 *
 * kifu lives in a separate repository, so rather than importing it we compare
 * against a snapshot of its output committed alongside the record (see the
 * header of the .final.txt fixture). Agreement between two implementations
 * written from different starting points is worth far more than either
 * agreeing with itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse, type GameTree, type Props } from '../src/sgf-parser.ts';
import {
  BLACK,
  WHITE,
  createPosition,
  moveError,
  playRecorded,
  stoneAt,
  toIndex,
  type Color,
  type MoveError,
  type Position,
} from '../src/rules.ts';

const FIXTURES: string = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

interface Replay {
  position: Position;
  moves: number;
  /** Record moves our own legality rules would have refused. */
  rejected: { moveNumber: number; reason: MoveError }[];
}

function boardSize(root: Props): [number, number] {
  const sz: string = root.SZ?.[0] ?? '19';
  if (sz.includes(':')) {
    const [cols, rows] = sz.split(':').map(Number);
    return [cols, rows];
  }
  return [Number(sz), Number(sz)];
}

/** SGF point ('qd') to a board index, or null for a pass. */
function pointIndex(pos: Position, value: string): number | null {
  if (value === '' || value === 'tt') return null;
  const col: number = value.charCodeAt(0) - 97;
  const row: number = value.charCodeAt(1) - 97;
  if (col < 0 || col >= pos.cols || row < 0 || row >= pos.rows) return null;
  return toIndex(pos, row, col);
}

function applySetup(pos: Position, props: Props): Position {
  const stones = Int8Array.from(pos.stones);
  for (const [prop, value] of [['AB', BLACK], ['AW', WHITE], ['AE', 0]] as const) {
    for (const point of props[prop] ?? []) {
      const index: number | null = pointIndex(pos, point);
      if (index !== null) stones[index] = value;
    }
  }
  return { cols: pos.cols, rows: pos.rows, stones, koPoint: pos.koPoint };
}

/** Replay the main line: every node, then the first variation, recursively. */
function replayMainLine(tree: GameTree, state: Replay): Replay {
  let { position, moves } = state;

  for (const node of tree.nodes) {
    position = applySetup(position, node.props);

    for (const [prop, color] of [['B', BLACK], ['W', WHITE]] as const) {
      const value: string | undefined = node.props[prop]?.[0];
      if (value === undefined) continue;

      moves++;
      const index: number | null = pointIndex(position, value);
      if (index === null) continue; // a pass

      const error: MoveError | null = moveError(position, index, color as Color);
      if (error) state.rejected.push({ moveNumber: moves, reason: error });

      position = playRecorded(position, index, color as Color).position;
    }
  }

  const next: GameTree | undefined = tree.variations[0];
  const carried: Replay = { ...state, position, moves };
  return next ? replayMainLine(next, carried) : carried;
}

function render(pos: Position): string[] {
  const lines: string[] = [];
  for (let row = 0; row < pos.rows; row++) {
    let line = '';
    for (let col = 0; col < pos.cols; col++) {
      const point: number = stoneAt(pos, toIndex(pos, row, col));
      line += point === BLACK ? 'b' : point === WHITE ? 'w' : '.';
    }
    lines.push(line);
  }
  return lines;
}

function readSnapshot(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function replayFixture(name: string): Replay {
  const trees: GameTree[] = parse(readFileSync(join(FIXTURES, `${name}.sgf`), 'utf8'));
  const [cols, rows] = boardSize(trees[0].nodes[0].props);
  return replayMainLine(trees[0], {
    position: createPosition(cols, rows),
    moves: 0,
    rejected: [],
  });
}

// ── Ke Jie vs Ichiriki Ryo, 10th Ing Cup semi-final game 3 ───────────────────

test('replaying a pro game agrees with kifu, move for move', () => {
  const replay: Replay = replayFixture('2024-07-09d');
  assert.deepEqual(render(replay.position), readSnapshot('2024-07-09d.final.txt'));
});

test('the record plays out to a plausible length', () => {
  const replay: Replay = replayFixture('2024-07-09d');
  assert.ok(replay.moves > 100, `expected a full game, replayed ${replay.moves} moves`);
});

test('our legality rules refuse nothing the record actually plays', () => {
  // The real check on ko and suicide: a rule strict enough to reject a move a
  // professional played is a rule that would strand a user mid-game.
  const replay: Replay = replayFixture('2024-07-09d');
  assert.deepEqual(replay.rejected, []);
});
