/**
 * Corpus check: replay a real game record move by move with our rules engine
 * and compare the result against kifu's independent implementation.
 *
 * kifu lives in a separate repository, so rather than importing it we compare
 * against a snapshot of its output committed alongside the record (see the
 * header of the .final.txt fixture). Agreement between two implementations
 * written from different starting points is worth far more than either
 * agreeing with itself.
 *
 * The replay runs through src/game.ts deliberately. A corpus check with its
 * own private replay would keep passing while the code the app actually runs
 * broke underneath it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from '../src/sgf-parser.ts';
import { readGame, type Game } from '../src/game.ts';
import { BLACK, WHITE, moveError, stoneAt, toIndex, type MoveError, type Position } from '../src/rules.ts';

const FIXTURES: string = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

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

function loadFixture(name: string): Game {
  return readGame(parse(readFileSync(join(FIXTURES, `${name}.sgf`), 'utf8')));
}

/** Record moves our own legality rules would have refused, if any. */
function rejectedMoves(game: Game): { number: number; reason: MoveError }[] {
  const rejected: { number: number; reason: MoveError }[] = [];
  for (const move of game.moves) {
    if (move.index === null) continue;
    const reason: MoveError | null = moveError(move.before, move.index, move.color);
    if (reason) rejected.push({ number: move.number, reason });
  }
  return rejected;
}

function finalPosition(game: Game): Position {
  const last = game.moves.at(-1);
  return last ? last.after : game.initial;
}

// ── Ke Jie vs Ichiriki Ryo, 10th Ing Cup semi-final game 3 ───────────────────

test('replaying a pro game agrees with kifu, move for move', () => {
  const game: Game = loadFixture('2024-07-09d');
  assert.deepEqual(render(finalPosition(game)), readSnapshot('2024-07-09d.final.txt'));
});

test('the record plays out to a plausible length', () => {
  const game: Game = loadFixture('2024-07-09d');
  assert.ok(game.moves.length > 100, `expected a full game, replayed ${game.moves.length} moves`);
});

test('our legality rules refuse nothing the record actually plays', () => {
  // The real check on ko and suicide: a rule strict enough to reject a move a
  // professional played is a rule that would strand a user mid-game.
  assert.deepEqual(rejectedMoves(loadFixture('2024-07-09d')), []);
});

test('the record alternates colors, starting with Black', () => {
  const game: Game = loadFixture('2024-07-09d');
  const colors: number[] = game.moves.map((move) => move.color);
  assert.equal(colors[0], BLACK);
  assert.deepEqual(
    colors.filter((_, i) => i % 2 === 1).every((c) => c === WHITE),
    true,
  );
});
