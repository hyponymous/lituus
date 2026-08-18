/**
 * Go rules: board state, captures, ko, and move legality.
 *
 * Positions are immutable — every move returns a new one — which keeps the
 * session's history trivially correct and costs little at 361 bytes a board.
 *
 * Stones are stored row-major as an Int8Array, 1 for black and -1 for white,
 * matching kifu's representation so the two can be compared directly (see
 * docs/design-proof-of-concept.md §3).
 */

export type Color = 1 | -1;
export type Point = Color | 0;

export const BLACK: Color = 1;
export const WHITE: Color = -1;

export const EMPTY = 0;

export interface Position {
  readonly cols: number;
  readonly rows: number;
  readonly stones: Int8Array;
  /**
   * The point the player to move may not retake, or null. Set only after a
   * move that captured exactly one stone with a lone stone of its own — the
   * shape that makes an immediate recapture a ko.
   */
  readonly koPoint: number | null;
}

export type MoveError = 'off-board' | 'occupied' | 'suicide' | 'ko';

export interface MoveResult {
  readonly position: Position;
  readonly captured: readonly number[];
}

interface Group {
  cells: number[];
  liberties: number;
}

export function createPosition(cols: number, rows: number): Position {
  return { cols, rows, stones: new Int8Array(cols * rows), koPoint: null };
}

export function fromStones(
  cols: number,
  rows: number,
  stones: ArrayLike<number>,
  koPoint: number | null = null,
): Position {
  if (stones.length !== cols * rows) {
    throw new Error(`expected ${cols * rows} points, got ${stones.length}`);
  }
  return { cols, rows, stones: Int8Array.from(stones), koPoint };
}

export function toIndex(pos: Position, row: number, col: number): number {
  return row * pos.cols + col;
}

export function toRowCol(pos: Position, index: number): [number, number] {
  return [Math.floor(index / pos.cols), index % pos.cols];
}

export function stoneAt(pos: Position, index: number): Point {
  // Cast is safe by construction: nothing writes a value other than 0, 1, -1.
  return pos.stones[index] as Point;
}

function onBoard(pos: Position, index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < pos.stones.length;
}

function neighbors(pos: Position, index: number): number[] {
  const [row, col] = toRowCol(pos, index);
  const out: number[] = [];
  if (row > 0) out.push(index - pos.cols);
  if (row < pos.rows - 1) out.push(index + pos.cols);
  if (col > 0) out.push(index - 1);
  if (col < pos.cols - 1) out.push(index + 1);
  return out;
}

/** Flood-fill the connected group at `index`, counting its distinct liberties. */
function groupAt(pos: Position, stones: Int8Array, index: number): Group {
  const color: number = stones[index];
  const cells: number[] = [];
  const seen = new Set<number>([index]);
  const liberties = new Set<number>();
  const queue: number[] = [index];

  for (let cell = queue.pop(); cell !== undefined; cell = queue.pop()) {
    cells.push(cell);
    for (const next of neighbors(pos, cell)) {
      if (stones[next] === EMPTY) {
        liberties.add(next);
      } else if (stones[next] === color && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }

  return { cells, liberties: liberties.size };
}

/**
 * Why `color` may not play at `index`, or null if the move is legal.
 * Returning the reason rather than a boolean lets the interface say which
 * rule a click ran into.
 */
export function moveError(pos: Position, index: number, color: Color): MoveError | null {
  if (!onBoard(pos, index)) return 'off-board';
  if (pos.stones[index] !== EMPTY) return 'occupied';
  if (pos.koPoint === index) return 'ko';

  const { captured, liberties } = simulate(pos, index, color);
  if (captured.length === 0 && liberties === 0) return 'suicide';
  return null;
}

export function isLegal(pos: Position, index: number, color: Color): boolean {
  return moveError(pos, index, color) === null;
}

/** Place a stone and resolve captures, without judging legality. */
function simulate(
  pos: Position,
  index: number,
  color: Color,
): { stones: Int8Array; captured: number[]; liberties: number; groupSize: number } {
  const stones = Int8Array.from(pos.stones);
  stones[index] = color;

  const captured: number[] = [];
  for (const next of neighbors(pos, index)) {
    if (stones[next] !== -color) continue;
    const group: Group = groupAt(pos, stones, next);
    if (group.liberties > 0) continue;
    for (const cell of group.cells) {
      stones[cell] = EMPTY;
      captured.push(cell);
    }
  }

  const own: Group = groupAt(pos, stones, index);
  return { stones, captured, liberties: own.liberties, groupSize: own.cells.length };
}

/**
 * Play a legal move. Throws if the move is illegal — callers taking user
 * input should ask `moveError` first.
 */
export function play(pos: Position, index: number, color: Color): MoveResult {
  const error: MoveError | null = moveError(pos, index, color);
  if (error) throw new Error(`illegal move at ${index}: ${error}`);
  return apply(pos, index, color);
}

/**
 * Play a move from a game record, permitting what the record contains.
 *
 * Records are not always legal under our rules: a few rulesets allow
 * multi-stone suicide, and a file may simply be wrong. Rejecting such a move
 * would strand the user mid-game, which is worse than replaying it — so this
 * removes a suicided group and plays on. Legality is a question for the
 * user's guesses, not for the record.
 */
export function playRecorded(pos: Position, index: number, color: Color): MoveResult {
  if (!onBoard(pos, index)) throw new Error(`move at ${index} is off the board`);
  return apply(pos, index, color);
}

function apply(pos: Position, index: number, color: Color): MoveResult {
  const { stones, captured, liberties, groupSize } = simulate(pos, index, color);

  if (liberties === 0) {
    // Suicide: only reachable via playRecorded, which permits it.
    for (const cell of groupAt(pos, stones, index).cells) stones[cell] = EMPTY;
  }

  // A ko is the position a single stone taking a single stone leaves behind:
  // retaking immediately would repeat the previous position.
  const isKo: boolean = captured.length === 1 && groupSize === 1 && liberties === 1;

  return {
    position: { cols: pos.cols, rows: pos.rows, stones, koPoint: isKo ? captured[0] : null },
    captured,
  };
}

/** A pass changes nothing but clears the ko ban. */
export function pass(pos: Position): Position {
  return { cols: pos.cols, rows: pos.rows, stones: pos.stones, koPoint: null };
}
