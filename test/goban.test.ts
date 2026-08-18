/**
 * Only the DOM-free parts of the renderer are tested here: geometry and point
 * naming, which are easy to get subtly wrong and invisible when they are.
 * Drawing itself is checked by eye (design doc §3).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hoshiPoints, pointName } from '../src/goban.ts';
import { createPosition, toIndex, type Position } from '../src/rules.ts';

test('a 19x19 board has nine star points on the 4th lines', () => {
  const points: [number, number][] = hoshiPoints(19);
  assert.equal(points.length, 9);
  assert.ok(points.some(([r, c]) => r === 3 && c === 3), 'corner star at 4-4');
  assert.ok(points.some(([r, c]) => r === 9 && c === 9), 'center star (tengen)');
});

test('a 13x13 board has five star points, a 9x9 five on the 3rd lines', () => {
  assert.equal(hoshiPoints(13).length, 5);
  const nine: [number, number][] = hoshiPoints(9);
  assert.equal(nine.length, 5);
  assert.ok(nine.some(([r, c]) => r === 2 && c === 2), '9x9 corners sit on the 3rd line');
});

test('boards too small for star points get none', () => {
  assert.deepEqual(hoshiPoints(4), []);
  assert.deepEqual(hoshiPoints(6), [], 'even and small: no center to mark');
});

test('point names skip the letter I, as the convention requires', () => {
  const pos: Position = createPosition(19, 19);
  assert.equal(pointName(pos, toIndex(pos, 0, 0)), 'A19', 'top-left');
  assert.equal(pointName(pos, toIndex(pos, 18, 0)), 'A1', 'bottom-left');
  assert.equal(pointName(pos, toIndex(pos, 3, 15)), 'Q16', 'the 4-4 point white often takes');
  assert.equal(pointName(pos, toIndex(pos, 0, 8)), 'J19', 'column 9 is J, not I');
});
