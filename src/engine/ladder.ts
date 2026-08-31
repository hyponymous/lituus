/**
 * Ladder detection, for input planes 14-17.
 *
 * A ladder is the one tactical sequence a Go network cannot reliably see for
 * itself: whether a group in atari escapes depends on a stone forty points
 * away, far outside any convolution's reach. KataGo therefore does not ask the
 * network — it runs an actual search on the CPU and hands the answer in as
 * four input planes. Skipping them does not make the network slightly worse at
 * ladders; it makes it confidently wrong about them, which is why parity on a
 * real game was unreachable without this file.
 *
 * Ported from `Board::searchIsLadderCaptured`,
 * `Board::searchIsLadderCapturedAttackerFirst2Libs` and `iterLadders` in
 * KataGo's `cpp/game/board.cpp` and `cpp/neuralnet/nninputs.cpp`. The search is
 * followed closely rather than reinvented, including its move ordering and its
 * node budget: the planes are only useful if they say what KataGo's say, and a
 * cleverer search that finds one more ladder is a worse input, not a better
 * one.
 *
 * ## What the four planes mean
 *
 *   14  every stone of a chain that is ladder-captured right now
 *   15  the same, computed on the position one move ago
 *   16  the same, two moves ago
 *   17  the moves that *work* to start the ladder, for opponent chains with
 *       two liberties
 *
 * Planes 15 and 16 are why this module takes previous positions rather than
 * just the current one. KataGo reads them off its own history stack; lituus
 * keeps no such stack, so the caller supplies the boards.
 *
 * ## The one structural divergence
 *
 * KataGo maintains chain membership and liberty counts incrementally, so
 * `chain_data[chain_head[loc]].num_liberties` is a lookup. Our board recomputes
 * by flood fill (see `board.ts` on why it is built that way), so the same
 * question costs a walk. That is a constant factor on a search that is already
 * bounded, and it buys not having to maintain a second set of invariants
 * through every play and undo.
 */

import {
  EMPTY,
  libertiesAt,
  opponentOf,
  playMove,
  undoMove,
  type Board,
  type BoardState,
  type Stone,
  type Undo,
} from './board.ts';

/** KataGo's own budget, in nodes, before a ladder is assumed not to work. */
const NODE_BUDGET = 25000;

/**
 * Working memory for the search, owned by the caller and reused.
 *
 * The search plays and takes back thousands of moves per position and runs
 * once per point on the board, so everything it needs is allocated once.
 */
export interface LadderScratch {
  readonly mark: Int32Array;
  readonly walkStack: Int32Array;
  /** Two chain buffers, because one walk happens inside another. */
  readonly chainA: Int32Array;
  readonly chainB: Int32Array;
  /** Which chains have already been solved, so each is searched once. */
  readonly solved: Int32Array;
  readonly captureStack: number[];
  readonly buf: number[];
  readonly moveListStart: Int32Array;
  readonly moveListLen: Int32Array;
  readonly moveListCur: Int32Array;
  readonly records: (Undo | null)[];
  readonly recordMove: Int32Array;
  readonly recordPlayer: Uint8Array;
  readonly working: number[];
  stamp: number;
}

export function createLadderScratch(board: Board): LadderScratch {
  const area: number = board.area;
  const depth: number = Math.floor((area * 3) / 2) + 2;
  return {
    mark: new Int32Array(area),
    walkStack: new Int32Array(area),
    chainA: new Int32Array(area),
    chainB: new Int32Array(area),
    solved: new Int32Array(area),
    captureStack: [],
    buf: [],
    moveListStart: new Int32Array(depth),
    moveListLen: new Int32Array(depth),
    moveListCur: new Int32Array(depth),
    records: new Array<Undo | null>(depth).fill(null),
    recordMove: new Int32Array(depth),
    recordPlayer: new Uint8Array(depth),
    working: [],
    stamp: 0,
  };
}

/**
 * Collect every stone of the chain at `start` into `out`, returning the count.
 *
 * KataGo walks a circular `next_in_chain` list; this floods instead. The order
 * therefore differs, which reaches the search only through move ordering — and
 * the search explores its whole move list before answering, so the verdict does
 * not depend on it.
 */
function collectChain(
  board: Board,
  state: BoardState,
  start: number,
  out: Int32Array,
  scratch: LadderScratch,
): number {
  const { neighborStart, neighborCount, neighbors } = board;
  const stones: Uint8Array = state.stones;
  const color: number = stones[start];
  const stamp: number = ++scratch.stamp;

  let size = 0;
  let top = 0;
  scratch.mark[start] = stamp;
  scratch.walkStack[top++] = start;

  while (top > 0) {
    const point: number = scratch.walkStack[--top];
    out[size++] = point;

    const from: number = neighborStart[point];
    const count: number = neighborCount[point];
    for (let i = 0; i < count; i++) {
      const next: number = neighbors[from + i];
      if (stones[next] === color && scratch.mark[next] !== stamp) {
        scratch.mark[next] = stamp;
        scratch.walkStack[top++] = next;
      }
    }
  }
  return size;
}

/** The lowest point index in a chain, used as its identity. */
function chainId(board: Board, state: BoardState, point: number, scratch: LadderScratch): number {
  const size: number = collectChain(board, state, point, scratch.chainA, scratch);
  let lowest: number = scratch.chainA[0];
  for (let i = 1; i < size; i++) {
    if (scratch.chainA[i] < lowest) lowest = scratch.chainA[i];
  }
  return lowest;
}

/** Empty points adjacent to `point` itself, not to its chain. */
function immediateLiberties(board: Board, state: BoardState, point: number): number {
  const from: number = board.neighborStart[point];
  const count: number = board.neighborCount[point];
  let libs = 0;
  for (let i = 0; i < count; i++) {
    if (state.stones[board.neighbors[from + i]] === EMPTY) libs++;
  }
  return libs;
}

/**
 * Append the liberties of the chain at `point` to `buf`, skipping any already
 * present from `bufStart` on.
 *
 * The deduplication window is KataGo's: a move list may already hold capturing
 * moves, and a liberty that is also a capture must not be searched twice.
 */
function findLiberties(
  board: Board,
  state: BoardState,
  point: number,
  buf: number[],
  bufStart: number,
  bufIdx: number,
  scratch: LadderScratch,
): number {
  const size: number = collectChain(board, state, point, scratch.chainB, scratch);
  const { neighborStart, neighborCount, neighbors } = board;
  let found = 0;

  for (let i = 0; i < size; i++) {
    const stone: number = scratch.chainB[i];
    const from: number = neighborStart[stone];
    const count: number = neighborCount[stone];
    for (let j = 0; j < count; j++) {
      const lib: number = neighbors[from + j];
      if (state.stones[lib] !== EMPTY) continue;

      let duplicate = false;
      for (let k = bufStart; k < bufIdx + found; k++) {
        if (buf[k] === lib) {
          duplicate = true;
          break;
        }
      }
      if (!duplicate) buf[bufIdx + found++] = lib;
    }
  }
  return found;
}

/**
 * Append the moves that capture an adjacent chain in atari, gaining liberties.
 *
 * Those moves are exactly the liberties of the surrounding one-liberty chains,
 * which is why this is expressed in terms of `findLiberties`.
 */
function findLibertyGainingCaptures(
  board: Board,
  state: BoardState,
  point: number,
  buf: number[],
  bufStart: number,
  bufIdx: number,
  scratch: LadderScratch,
): number {
  const opponent: number = opponentOf(state.stones[point] as Stone);
  const size: number = collectChain(board, state, point, scratch.chainA, scratch);
  const { neighborStart, neighborCount, neighbors } = board;
  const checked: number[] = [];
  let found = 0;

  for (let i = 0; i < size; i++) {
    const stone: number = scratch.chainA[i];
    const from: number = neighborStart[stone];
    const count: number = neighborCount[stone];
    for (let j = 0; j < count; j++) {
      const adj: number = neighbors[from + j];
      if (state.stones[adj] !== opponent) continue;
      if (libertiesAt(board, state, adj, 2) !== 1) continue;

      const head: number = chainId(board, state, adj, scratch);
      if (checked.includes(head)) continue;
      checked.push(head);
      found += findLiberties(board, state, adj, buf, bufStart, bufIdx + found, scratch);
    }
  }
  return found;
}

/** Does the chain at `point` touch any opponent chain in atari? */
function hasLibertyGainingCaptures(
  board: Board,
  state: BoardState,
  point: number,
  scratch: LadderScratch,
): boolean {
  const opponent: number = opponentOf(state.stones[point] as Stone);
  const size: number = collectChain(board, state, point, scratch.chainA, scratch);
  const { neighborStart, neighborCount, neighbors } = board;

  for (let i = 0; i < size; i++) {
    const stone: number = scratch.chainA[i];
    const from: number = neighborStart[stone];
    const count: number = neighborCount[stone];
    for (let j = 0; j < count; j++) {
      const adj: number = neighbors[from + j];
      if (state.stones[adj] === opponent && libertiesAt(board, state, adj, 2) === 1) return true;
    }
  }
  return false;
}

/**
 * Bounds on the liberties a stone at `point` would have, without playing it.
 *
 * Cheap enough to be worth it: the defender wins outright if the lower bound
 * is three, and the attacker wins outright if the upper bound is one and there
 * is nothing else to try.
 */
function boundLibertiesAfterPlay(
  board: Board,
  state: BoardState,
  point: number,
  player: Stone,
): { lower: number; upper: number } {
  const opponent: Stone = opponentOf(player);
  const from: number = board.neighborStart[point];
  const count: number = board.neighborCount[point];

  let immediate = 0;
  let captures = 0;
  let fromCaptures = 0;
  let connection = 0;
  let maxConnection = 0;

  for (let i = 0; i < count; i++) {
    const adj: number = board.neighbors[from + i];
    const stone: number = state.stones[adj];
    if (stone === EMPTY) {
      immediate++;
    } else if (stone === opponent) {
      if (libertiesAt(board, state, adj, 2) === 1) {
        captures++;
        fromCaptures += collectChainSize(board, state, adj);
      }
    } else if (stone === player) {
      const libs: number = libertiesAt(board, state, adj, board.area) - 1;
      connection += libs;
      if (libs > maxConnection) maxConnection = libs;
    }
  }

  return {
    lower: captures + Math.max(maxConnection, immediate),
    upper: immediate + fromCaptures + connection,
  };
}

/** How many stones are in the chain at `point`. */
function collectChainSize(board: Board, state: BoardState, point: number): number {
  const { neighborStart, neighborCount, neighbors } = board;
  const stones: Uint8Array = state.stones;
  const color: number = stones[point];
  const seen = new Set<number>([point]);
  const stack: number[] = [point];
  let size = 0;

  while (stack.length > 0) {
    // Small by construction: this is only asked about chains in atari.
    const current: number = stack.pop() as number;
    size++;
    const from: number = neighborStart[current];
    const count: number = neighborCount[current];
    for (let i = 0; i < count; i++) {
      const next: number = neighbors[from + i];
      if (stones[next] === color && !seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return size;
}

/**
 * Liberties a stone at `point` would have, capped at `max`.
 *
 * Only asked in the double-ko branch below, where an exact small count is
 * needed and playing the move out is the clearest way to get one.
 */
function libertiesAfterPlay(
  board: Board,
  state: BoardState,
  point: number,
  player: Stone,
  max: number,
  scratch: LadderScratch,
): number {
  const undo: Undo | null = playMove(board, state, point, player, scratch.captureStack);
  if (!undo) return 0;
  const libs: number = libertiesAt(board, state, point, max);
  undoMove(board, state, point, player, undo, scratch.captureStack);
  return libs;
}

/**
 * Would playing at `point` be a ko capture — taking exactly one stone, with
 * every neighbour an opponent stone?
 */
function wouldBeKoCapture(
  board: Board,
  state: BoardState,
  point: number,
  player: Stone,
): boolean {
  if (state.stones[point] !== EMPTY) return false;
  const opponent: Stone = opponentOf(player);
  const from: number = board.neighborStart[point];
  const count: number = board.neighborCount[point];

  // A point on the edge has fewer than four neighbours, and every one of them
  // must still be an opponent stone; the missing ones are wall, which KataGo
  // treats as satisfying the same condition.
  let capturable = -1;
  for (let i = 0; i < count; i++) {
    const adj: number = board.neighbors[from + i];
    if (state.stones[adj] !== opponent) return false;
    if (libertiesAt(board, state, adj, 2) === 1) {
      if (capturable >= 0) return false;
      capturable = adj;
    }
  }
  if (capturable < 0) return false;
  return collectChainSize(board, state, capturable) === 1;
}

/** KataGo's move-ordering heuristic: how well a point connects to friends. */
function heuristicConnectionLibertiesX2(
  board: Board,
  state: BoardState,
  point: number,
  player: Stone,
): number {
  const from: number = board.neighborStart[point];
  const count: number = board.neighborCount[point];
  let total = 0;

  for (let i = 0; i < count; i++) {
    const adj: number = board.neighbors[from + i];
    if (state.stones[adj] !== player) continue;
    const libs: number = libertiesAt(board, state, adj, board.area);
    if (libs > 1) total += libs * 2 - 3;
  }
  return total;
}

/**
 * Is the chain at `loc` captured in a ladder?
 *
 * `defenderFirst` says whose move it is. The search is a plain alternating
 * minimax over a very narrow move list — the defender may run to a liberty or
 * capture something adjacent, the attacker may only fill a liberty — with
 * enough early exits that it terminates fast on the shapes that matter.
 *
 * Written as an explicit stack rather than recursion, as upstream is: the
 * sequence can run half the length of the board, and each level has to undo its
 * move on the way back up.
 */
function searchIsLadderCaptured(
  board: Board,
  state: BoardState,
  loc: number,
  defenderFirst: boolean,
  scratch: LadderScratch,
): boolean {
  if (loc < 0 || loc >= board.area) return false;
  const defender: number = state.stones[loc];
  if (defender === EMPTY) return false;

  const rootLibs: number = libertiesAt(board, state, loc, 4);
  if (rootLibs > 2 || (defenderFirst && rootLibs > 1)) return false;

  const pla: Stone = defender as Stone;
  const opp: Stone = opponentOf(pla);

  // Every ko is assumed to go the defender's way, so ladders that depend on one
  // are not reported. Cleared only at the root, exactly as upstream.
  const koSaved: number = state.koPoint;
  if (defenderFirst) state.koPoint = -1;

  const { buf, moveListStart, moveListLen, moveListCur, records, recordMove, recordPlayer } =
    scratch;
  const stackSize: number = Math.floor((board.cols * board.rows * 3) / 2) + 1;

  let stackIdx = 0;
  let nodes = 0;
  let returnValue = false;
  let returnedFromDeeper = false;

  moveListCur[0] = -1;
  moveListStart[0] = 0;
  moveListLen[0] = 0;

  for (;;) {
    if (stackIdx <= -1) {
      state.koPoint = koSaved;
      return returnValue;
    }

    // Out of depth: treat it as a working ladder, as upstream does.
    if (stackIdx >= stackSize - 1) {
      returnValue = true;
      returnedFromDeeper = true;
      stackIdx--;
      continue;
    }

    // Out of budget: unwind everything and give up on the ladder.
    if (nodes >= NODE_BUDGET) {
      for (let i = stackIdx - 1; i >= 0; i--) {
        const undo: Undo | null = records[i];
        if (undo) {
          undoMove(board, state, recordMove[i], recordPlayer[i] as Stone, undo, scratch.captureStack);
        }
      }
      state.koPoint = koSaved;
      return false;
    }

    const isDefender: boolean =
      defenderFirst === (stackIdx % 2 === 0);

    if (moveListCur[stackIdx] === -1) {
      const libs: number = libertiesAt(board, state, loc, 4);

      // Base cases, in upstream's order.
      if (!isDefender && libs <= 1) {
        returnValue = true; returnedFromDeeper = true; stackIdx--; continue;
      }
      if (!isDefender && libs >= 3) {
        returnValue = false; returnedFromDeeper = true; stackIdx--; continue;
      }
      if (isDefender && libs >= 2) {
        returnValue = false; returnedFromDeeper = true; stackIdx--; continue;
      }
      if (isDefender && state.koPoint >= 0) {
        returnValue = false; returnedFromDeeper = true; stackIdx--; continue;
      }

      const start: number = moveListStart[stackIdx];
      let length = 0;

      if (isDefender) {
        length = findLibertyGainingCaptures(board, state, loc, buf, start, start, scratch);
        length += findLiberties(board, state, loc, buf, start, start + length, scratch);

        // The list always ends with the group's lone liberty, so bounding that
        // move bounds the defender's best case.
        const bound = boundLibertiesAfterPlay(board, state, buf[start + length - 1], pla);
        if (bound.lower >= 3) {
          returnValue = false; returnedFromDeeper = true; stackIdx--; continue;
        }
        if (length === 1 && bound.upper <= 1) {
          returnValue = true; returnedFromDeeper = true; stackIdx--; continue;
        }
      } else {
        length = findLiberties(board, state, loc, buf, start, start, scratch);

        let libs0: number = immediateLiberties(board, state, buf[start]);
        let libs1: number = immediateLiberties(board, state, buf[start + 1]);

        // A double-ko death: both escapes are ko mouths and neither connection
        // gains anything, so the defender cannot win it outright.
        if (
          libs0 === 0 &&
          libs1 === 0 &&
          wouldBeKoCapture(board, state, buf[start], opp) &&
          wouldBeKoCapture(board, state, buf[start + 1], opp) &&
          libertiesAfterPlay(board, state, buf[start], pla, 3, scratch) <= 2 &&
          libertiesAfterPlay(board, state, buf[start + 1], pla, 3, scratch) <= 2 &&
          !hasLibertyGainingCaptures(board, state, loc, scratch)
        ) {
          returnValue = true; returnedFromDeeper = true; stackIdx--; continue;
        }

        // If the two liberties are not adjacent, filling one does not fill the
        // other, so each can be judged on its own.
        if (!adjacent(board, buf[start], buf[start + 1])) {
          if (libs0 >= 3 && libs1 >= 3) {
            returnValue = false; returnedFromDeeper = true; stackIdx--; continue;
          } else if (libs0 >= 3) {
            length = 1;
          } else if (libs1 >= 3) {
            buf[start] = buf[start + 1];
            length = 1;
          }
        }

        if (length > 1) {
          libs0 = libs0 * 2 + heuristicConnectionLibertiesX2(board, state, buf[start], pla);
          libs1 = libs1 * 2 + heuristicConnectionLibertiesX2(board, state, buf[start + 1], pla);
          if (libs1 > libs0) {
            const swap: number = buf[start];
            buf[start] = buf[start + 1];
            buf[start + 1] = swap;
          }
        }
      }

      moveListLen[stackIdx] = length;
      moveListCur[stackIdx] = 0;
    } else {
      if (returnedFromDeeper) {
        const undo: Undo | null = records[stackIdx];
        if (undo) {
          undoMove(
            board, state, recordMove[stackIdx], recordPlayer[stackIdx] as Stone,
            undo, scratch.captureStack,
          );
        }
      }

      // Either side stops as soon as it has found a move that suits it.
      if (isDefender && !returnValue) {
        returnedFromDeeper = true; stackIdx--; continue;
      }
      if (!isDefender && returnValue) {
        returnedFromDeeper = true; stackIdx--; continue;
      }

      moveListCur[stackIdx]++;
    }

    // Nothing left to try: the defender ran out of escapes, or the attacker ran
    // out of attacks.
    if (moveListCur[stackIdx] >= moveListLen[stackIdx]) {
      returnValue = isDefender;
      returnedFromDeeper = true;
      stackIdx--;
      continue;
    }

    const move: number = buf[moveListStart[stackIdx] + moveListCur[stackIdx]];
    const player: Stone = isDefender ? pla : opp;
    const undo: Undo | null = playMove(board, state, move, player, scratch.captureStack);

    // An illegal move counts as a failed one, but stays at this level so the
    // next move in the list is tried rather than returning up.
    if (!undo) {
      returnValue = isDefender;
      returnedFromDeeper = false;
      continue;
    }

    records[stackIdx] = undo;
    recordMove[stackIdx] = move;
    recordPlayer[stackIdx] = player;
    nodes++;

    stackIdx++;
    moveListCur[stackIdx] = -1;
    moveListStart[stackIdx] = moveListStart[stackIdx - 1] + moveListLen[stackIdx - 1];
    moveListLen[stackIdx] = 0;
  }
}

/** Are two points neighbours? */
function adjacent(board: Board, a: number, b: number): boolean {
  const from: number = board.neighborStart[a];
  const count: number = board.neighborCount[a];
  for (let i = 0; i < count; i++) {
    if (board.neighbors[from + i] === b) return true;
  }
  return false;
}

/**
 * A two-liberty chain is laddered if the attacker has a first move that puts it
 * in a ladder — and the moves that do are what plane 17 records.
 */
function searchLadderTwoLiberties(
  board: Board,
  state: BoardState,
  loc: number,
  working: number[],
  scratch: LadderScratch,
): boolean {
  if (state.stones[loc] === EMPTY) return false;
  if (libertiesAt(board, state, loc, 3) !== 2) return false;

  const pla: Stone = state.stones[loc] as Stone;
  const opp: Stone = opponentOf(pla);

  const moves: number[] = [];
  findLiberties(board, state, loc, moves, 0, 0, scratch);
  const [move0, move1] = moves;

  working.length = 0;
  for (const move of [move0, move1]) {
    const undo: Undo | null = playMove(board, state, move, opp, scratch.captureStack);
    if (!undo) continue;
    const captured: boolean = searchIsLadderCaptured(board, state, loc, true, scratch);
    undoMove(board, state, move, opp, undo, scratch.captureStack);
    if (captured) working.push(move);
  }
  return working.length > 0;
}

/** The four planes, as flat per-point flags. */
export interface LadderPlanes {
  /** Plane 14 (or 15, 16 on an earlier board): stones caught in a ladder. */
  readonly captured: Uint8Array;
  /** Plane 17: attacker moves that start a working ladder. */
  readonly workingMoves: Uint8Array;
}

/**
 * Find every laddered chain on one position.
 *
 * `toPlay` decides which chains contribute working moves: plane 17 is about
 * ladders the player to move can *start*, so only the opponent's two-liberty
 * chains count. For planes 15 and 16 the working moves are unused and `toPlay`
 * does not matter.
 *
 * Each chain is searched once and the answer written to all of its stones,
 * matching upstream's solved-heads cache.
 */
export function ladderPlanes(
  board: Board,
  state: BoardState,
  toPlay: Stone,
  scratch: LadderScratch,
  out: LadderPlanes,
): LadderPlanes {
  out.captured.fill(0);
  out.workingMoves.fill(0);

  const opponent: Stone = opponentOf(toPlay);
  const done = new Map<number, boolean>();

  for (let point = 0; point < board.area; point++) {
    const stone: number = state.stones[point];
    if (stone === EMPTY) continue;

    const libs: number = libertiesAt(board, state, point, 3);
    if (libs !== 1 && libs !== 2) continue;

    const head: number = chainId(board, state, point, scratch);
    const seen: boolean | undefined = done.get(head);
    if (seen !== undefined) {
      if (seen) out.captured[point] = 1;
      continue;
    }

    let laddered: boolean;
    const working: number[] = scratch.working;
    if (libs === 1) {
      working.length = 0;
      laddered = searchIsLadderCaptured(board, state, point, true, scratch);
    } else {
      laddered = searchLadderTwoLiberties(board, state, point, working, scratch);
    }

    done.set(head, laddered);
    if (!laddered) continue;

    out.captured[point] = 1;
    // Only the opponent's chains, and only those not already in atari: a stone
    // already captured needs no move to start the ladder.
    if (stone === opponent && libs > 1) {
      for (const move of working) out.workingMoves[move] = 1;
    }
  }
  return out;
}

/** All four planes, in the shape `features-v7.ts` takes them. */
export interface LadderInputs {
  readonly captured: Uint8Array;
  readonly capturedPrev: Uint8Array;
  readonly capturedPrevPrev: Uint8Array;
  readonly workingMoves: Uint8Array;
}

export function createLadderInputs(board: Board): LadderInputs {
  return {
    captured: new Uint8Array(board.area),
    capturedPrev: new Uint8Array(board.area),
    capturedPrevPrev: new Uint8Array(board.area),
    workingMoves: new Uint8Array(board.area),
  };
}

/**
 * Compute planes 14-17 for a position and the two before it.
 *
 * The ladder search runs three times, on three different boards. That is not
 * redundancy: 15 and 16 tell the network whether a ladder is *new*, which is
 * how it distinguishes a group that has just been put in danger from one that
 * has been dead for a while.
 *
 * `prev` and `prevPrev` fall back the way KataGo's do when there is not enough
 * history — to the current board and then to `prev` — so the opening, where no
 * previous position exists, encodes the same way it does upstream rather than
 * as a board with no ladders on it.
 */
export function ladderInputs(
  board: Board,
  current: BoardState,
  prev: BoardState | undefined,
  prevPrev: BoardState | undefined,
  toPlay: Stone,
  scratch: LadderScratch,
  out: LadderInputs,
): LadderInputs {
  const before: BoardState = prev ?? current;
  const beforeThat: BoardState = prevPrev ?? before;

  ladderPlanes(board, current, toPlay, scratch, {
    captured: out.captured,
    workingMoves: out.workingMoves,
  });

  // Working moves are only ever read from the current board, so the two
  // historical passes write theirs to a buffer nothing looks at.
  const discard: Uint8Array = new Uint8Array(board.area);
  ladderPlanes(board, before, toPlay, scratch, {
    captured: out.capturedPrev,
    workingMoves: discard,
  });
  ladderPlanes(board, beforeThat, toPlay, scratch, {
    captured: out.capturedPrevPrev,
    workingMoves: discard,
  });
  return out;
}
