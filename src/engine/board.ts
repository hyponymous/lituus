/**
 * A mutable board for the search to play on and take back.
 *
 * Upstream: the move half of `src/engine/katago/fastBoard.ts` in web-katrain
 * (https://github.com/Sir-Teo/web-katrain), MIT. The feature half — liberty
 * maps, pass-alive area, ladders — is a separate concern and comes across with
 * the network inputs.
 *
 * ## Why this exists when `rules.ts` already does
 *
 * `rules.ts` is the authority on legality and is deliberately immutable: every
 * move returns a new `Position`, which is what makes a session's history
 * trivially correct. A tree search does the opposite thing — descend, evaluate,
 * take the move back, try the next one, thousands of times per prompt — and
 * allocating a 361-byte board per node would dominate the profile.
 *
 * So there are two boards, and one shared corpus check keeping them honest
 * (`test/engine-board.test.ts`). That is the honest shape:
 * `docs/design-ai-scoring.md` §4.2 records why pretending one could serve both
 * roles was the wrong estimate.
 *
 * ## Divergences from upstream, both deliberate
 *
 * **No module-level mutable state.** Upstream keeps the board size, the
 * neighbour tables and every scratch buffer in module `let`s, reinitialized by
 * `setBoardSize`. Two boards of different sizes then quietly corrupt each
 * other, which is a live hazard here: the tests replay 9x9, 13x13 and 19x19
 * records in one process, and a session can load a second game without a
 * reload. A `Board` owns its own tables instead, built once and reused.
 *
 * **Rectangular boards work.** Upstream indexes by a single dimension. Nothing
 * here needs that, `rules.ts` reads rectangular `SZ`, and supporting it costs a
 * second field — so the corpus check can cover every record rather than the
 * square ones. (The *network* is a different matter: its input planes really
 * are square-indexed, which is why `docs/prd-ai-scoring.md` §12 restricts AI
 * scoring to square boards.)
 *
 * Stones are KataGo's encoding — 0 empty, 1 black, 2 white — not `rules.ts`'s
 * 1/-1. Everything downstream in the engine reads this encoding, so converting
 * at this boundary is one pass; converting at the feature boundary would be one
 * per evaluation.
 */

import { fromStones, stoneAt, BLACK as RULES_BLACK, type Position } from '../rules.ts';

export type Stone = 0 | 1 | 2;

export const EMPTY: Stone = 0;
export const BLACK: Stone = 1;
export const WHITE: Stone = 2;

export function opponentOf(color: Stone): Stone {
  return (3 - color) as Stone;
}

/**
 * Reusable working memory for the flood fills.
 *
 * Stamped rather than cleared: a search visits a group thousands of times a
 * second and zeroing 361 entries each time is most of the cost of asking how
 * many liberties it has. Incrementing a counter and comparing against it is the
 * same answer without the write.
 */
interface Scratch {
  readonly visited: Int32Array;
  readonly libVisited: Int32Array;
  readonly group: Int16Array;
  readonly stack: Int16Array;
  readonly processed: Int32Array;
  stamp: number;
  processedStamp: number;
}

/**
 * A board's fixed geometry, plus the scratch the fills run in.
 *
 * Created once per game and shared by every search on it. Holds no position:
 * the stones live in a `BoardState`, so one `Board` can serve a search
 * descending through many of them.
 */
export interface Board {
  readonly cols: number;
  readonly rows: number;
  readonly area: number;
  /** Index into `neighbors` where each point's neighbours start. */
  readonly neighborStart: Int16Array;
  readonly neighborCount: Int8Array;
  /** Flattened adjacency, at most four per point. */
  readonly neighbors: Int16Array;
  readonly scratch: Scratch;
}

/** The move index meaning "pass" — one past the last point, as the policy has it. */
export function passMove(board: Board): number {
  return board.area;
}

export function createBoard(cols: number, rows: number): Board {
  const area: number = cols * rows;
  const neighborStart = new Int16Array(area);
  const neighborCount = new Int8Array(area);
  const neighbors = new Int16Array(area * 4);

  let at = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const point: number = row * cols + col;
      neighborStart[point] = at;
      let count = 0;
      if (col > 0) { neighbors[at++] = point - 1; count++; }
      if (col + 1 < cols) { neighbors[at++] = point + 1; count++; }
      if (row > 0) { neighbors[at++] = point - cols; count++; }
      if (row + 1 < rows) { neighbors[at++] = point + cols; count++; }
      neighborCount[point] = count;
    }
  }

  return {
    cols,
    rows,
    area,
    neighborStart,
    neighborCount,
    neighbors,
    scratch: {
      visited: new Int32Array(area),
      libVisited: new Int32Array(area),
      group: new Int16Array(area),
      stack: new Int16Array(area),
      processed: new Int32Array(area),
      stamp: 0,
      processedStamp: 0,
    },
  };
}

/** Stones and the one point that may not be retaken. `-1` for no ko. */
export interface BoardState {
  readonly stones: Uint8Array;
  koPoint: number;
}

export function emptyState(board: Board): BoardState {
  return { stones: new Uint8Array(board.area), koPoint: -1 };
}

/** Read a `rules.ts` position into the engine's encoding. */
export function fromPosition(board: Board, position: Position): BoardState {
  const stones = new Uint8Array(board.area);
  for (let point = 0; point < board.area; point++) {
    const stone: number = stoneAt(position, point);
    stones[point] = stone === 0 ? EMPTY : stone === RULES_BLACK ? BLACK : WHITE;
  }
  return { stones, koPoint: position.koPoint ?? -1 };
}

/** Hand a state back to `rules.ts`, for comparison or for display. */
export function toPosition(board: Board, state: BoardState): Position {
  const stones = new Int8Array(board.area);
  for (let point = 0; point < board.area; point++) {
    const stone: number = state.stones[point];
    stones[point] = stone === EMPTY ? 0 : stone === BLACK ? 1 : -1;
  }
  return fromStones(board.cols, board.rows, stones, state.koPoint < 0 ? null : state.koPoint);
}

/**
 * Walk the group at `start`, collecting its stones and counting liberties.
 *
 * `maxLiberties` caps the count. Every caller here only needs to tell zero from
 * one from more, and stopping early on a large group is the difference between
 * a cheap question and a whole-board fill.
 *
 * Results land in `board.scratch.group`, valid until the next call.
 */
function collectGroup(
  board: Board,
  stones: Uint8Array,
  start: number,
  color: Stone,
  maxLiberties: number,
): { size: number; liberties: number } {
  const { scratch, neighborStart, neighborCount, neighbors } = board;
  const stamp: number = ++scratch.stamp;
  let size = 0;
  let top = 0;
  let liberties = 0;

  scratch.visited[start] = stamp;
  scratch.stack[top++] = start;

  while (top > 0) {
    const point: number = scratch.stack[--top];
    scratch.group[size++] = point;

    const from: number = neighborStart[point];
    const count: number = neighborCount[point];
    for (let i = 0; i < count; i++) {
      const next: number = neighbors[from + i];
      const stone: number = stones[next];
      if (stone === EMPTY) {
        if (liberties < maxLiberties && scratch.libVisited[next] !== stamp) {
          scratch.libVisited[next] = stamp;
          liberties++;
        }
      } else if (stone === color && scratch.visited[next] !== stamp) {
        scratch.visited[next] = stamp;
        scratch.stack[top++] = next;
      }
    }
  }

  return { size, liberties };
}

/** How many liberties the group at `point` has, capped at `max`. */
export function libertiesAt(board: Board, state: BoardState, point: number, max = 4): number {
  const color: number = state.stones[point];
  if (color === EMPTY) return 0;
  return collectGroup(board, state.stones, point, color as Stone, max).liberties;
}

/**
 * Liberties for every stone on the board, capped at `max`, written into `out`.
 *
 * Input plane material: the network is shown where the one-, two- and
 * three-liberty stones are. The cap is nonetheless **four**, and that is not an
 * off-by-one to tidy away — it is the difference between "three liberties" and
 * "more than three". Capping at three stores three for a group with ten, and
 * the plane that means *in some danger* then lights up under half the stones on
 * the board. Nothing raises; the network simply answers a different question.
 * (Found exactly that way: the empty board matched the reference to 1e-6 and
 * every position with stones on it did not.)
 *
 * One fill per group rather than one per stone — the whole group's count is
 * known as soon as it has been walked, so writing it to every member costs
 * nothing and saves walking the group again from each of its stones.
 */
export function libertyMap(
  board: Board,
  state: BoardState,
  out: Uint8Array,
  max = 4,
): Uint8Array {
  out.fill(0);
  const { scratch } = board;
  const seen: Int32Array = scratch.processed;
  const stamp: number = ++scratch.processedStamp;

  for (let point = 0; point < board.area; point++) {
    const color: number = state.stones[point];
    if (color === EMPTY || seen[point] === stamp) continue;

    const group = collectGroup(board, state.stones, point, color as Stone, max);
    const liberties: number = group.liberties;
    for (let i = 0; i < group.size; i++) {
      const member: number = scratch.group[i];
      seen[member] = stamp;
      out[member] = liberties;
    }
  }
  return out;
}

/** What `undoMove` needs to put a move back. */
export interface Undo {
  readonly koPointBefore: number;
  /** Where this move's captures start in the shared capture stack. */
  readonly captureStart: number;
}

/**
 * Play a move, or report that it cannot be played.
 *
 * Returns null for an illegal move rather than throwing. A search asks this
 * question constantly and exceptions are the wrong instrument for an expected
 * answer; upstream throws, which is fine for a UI and wrong in a hot loop.
 *
 * Captured stones are pushed onto `captureStack`, which the caller owns and
 * shares across a whole descent — that is what makes taking a move back a
 * length reset rather than an allocation.
 */
export function playMove(
  board: Board,
  state: BoardState,
  move: number,
  player: Stone,
  captureStack: number[],
): Undo | null {
  const koPointBefore: number = state.koPoint;
  const captureStart: number = captureStack.length;

  if (move === board.area) {
    state.koPoint = -1;
    return { koPointBefore, captureStart };
  }
  if (move < 0 || move >= board.area) return null;
  if (state.stones[move] !== EMPTY) return null;
  if (state.koPoint === move) return null;

  const { scratch, neighborStart, neighborCount, neighbors } = board;
  const opponent: Stone = opponentOf(player);
  state.stones[move] = player;

  let captured = 0;
  let singleCapture = -1;

  const processedStamp: number = ++scratch.processedStamp;
  const from: number = neighborStart[move];
  const count: number = neighborCount[move];

  for (let i = 0; i < count; i++) {
    const next: number = neighbors[from + i];
    if (state.stones[next] !== opponent) continue;
    // Two neighbours can belong to one group; without this it would be walked
    // twice and, worse, captured twice onto the stack.
    if (scratch.processed[next] === processedStamp) continue;

    const group = collectGroup(board, state.stones, next, opponent, 1);
    for (let j = 0; j < group.size; j++) scratch.processed[scratch.group[j]] = processedStamp;
    if (group.liberties !== 0) continue;

    for (let j = 0; j < group.size; j++) {
      const point: number = scratch.group[j];
      state.stones[point] = EMPTY;
      captureStack.push(point);
    }
    captured += group.size;
    if (captured === 1 && group.size === 1) singleCapture = scratch.group[0];
    if (captured > 1) singleCapture = -1;
  }

  // Counting to two is enough: zero is suicide, one is the shape that makes a
  // ko, and anything more is neither.
  const own = collectGroup(board, state.stones, move, player, 2);
  if (own.liberties === 0) {
    // Suicide. Put the board back before reporting it, so a refused move leaves
    // no trace — the caller has no undo to apply.
    state.stones[move] = EMPTY;
    for (let i = captureStack.length - 1; i >= captureStart; i--) {
      state.stones[captureStack[i]] = opponent;
    }
    captureStack.length = captureStart;
    state.koPoint = koPointBefore;
    return null;
  }

  // The shape a single stone taking a single stone leaves behind: retaking
  // immediately would repeat the previous position. Identical to `rules.ts`,
  // and the corpus check exists to keep it that way.
  state.koPoint =
    captured === 1 && singleCapture >= 0 && own.size === 1 && own.liberties === 1
      ? singleCapture
      : -1;

  return { koPointBefore, captureStart };
}

/** Take back the move `undo` was returned for. */
export function undoMove(
  board: Board,
  state: BoardState,
  move: number,
  player: Stone,
  undo: Undo,
  captureStack: number[],
): void {
  const opponent: Stone = opponentOf(player);
  if (move !== board.area) state.stones[move] = EMPTY;

  for (let i = undo.captureStart; i < captureStack.length; i++) {
    state.stones[captureStack[i]] = opponent;
  }
  captureStack.length = undo.captureStart;
  state.koPoint = undo.koPointBefore;
}
