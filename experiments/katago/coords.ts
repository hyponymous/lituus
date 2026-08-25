/**
 * Board indices (row-major, row 0 at the top, as `rules.ts` and SGF both
 * count) to and from KataGo's GTP coordinates ("Q16"), which letter the
 * columns skipping I and number the rows from the *bottom*.
 */
import { toRowCol, type Position } from '../../src/rules.ts';

const LETTERS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';

export function toGtp(pos: Position, index: number | null): string {
  if (index === null) return 'pass';
  const [row, col] = toRowCol(pos, index);
  return `${LETTERS[col]}${pos.rows - row}`;
}

/** Null for 'pass' and for anything that does not name a point on this board. */
export function fromGtp(pos: Position, move: string): number | null {
  if (move === 'pass') return null;
  const col: number = LETTERS.indexOf(move[0].toUpperCase());
  const number: number = Number(move.slice(1));
  if (col < 0 || col >= pos.cols) return null;
  if (!Number.isInteger(number) || number < 1 || number > pos.rows) return null;
  return (pos.rows - number) * pos.cols + col;
}
