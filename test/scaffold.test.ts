// Smoke test for the test harness itself: confirms the runner executes
// TypeScript and resolves cross-module imports from src/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_SIZES, isSquare } from '../src/board-sizes.ts';

test('runner executes TypeScript with type annotations', () => {
  const n: number = BOARD_SIZES.length;
  assert.ok(n > 0);
});

test('imports resolve from src/', () => {
  assert.equal(isSquare(19, 19), true);
  assert.equal(isSquare(19, 13), false);
});
