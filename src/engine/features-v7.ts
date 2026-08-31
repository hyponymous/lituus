/**
 * KataGo's version-7 input planes: the question the network is actually asked.
 *
 * Upstream: `src/engine/katago/featuresV7Fast.ts` in web-katrain
 * (https://github.com/Sir-Teo/web-katrain), MIT, which is itself a
 * transcription of KataGo's own encoder.
 *
 * This is a specification, not a design. Every plane index and every global
 * below is fixed by the network file; there is nothing here to improve and one
 * thing to get exactly right. A wrong plane does not raise anything — the
 * network answers a different question, confidently, and the mistake surfaces
 * as point losses that are merely a bit off. `test/engine-network.test.ts`
 * exists because that failure has no other symptom.
 *
 * Twenty-two spatial channels in NHWC order and nineteen globals. Channels 7,
 * 8, 20 and 21 are never written: they carry Japanese-encore state that a
 * normal position does not have, and KataGo sees zeros there too.
 */

import {
  BLACK,
  EMPTY,
  libertyMap,
  opponentOf,
  passMove,
  type Board,
  type BoardState,
  type Stone,
} from './board.ts';

export const SPATIAL_CHANNELS = 22;
export const GLOBAL_CHANNELS = 19;

/**
 * Rulesets, as the network is told about them.
 *
 * `territory` covers Japanese and Korean, which is 92% of the corpus. Area
 * scoring needs two more planes derived from a pass-alive analysis that has not
 * been ported yet, so it is named here and refused at the door rather than
 * quietly encoded as territory — see `buildFeatures`.
 */
export type Ruleset = 'territory' | 'area';

/** Which ruleset a record's `RU` value means, or null if we cannot serve it. */
export function rulesetOf(value: string | undefined): Ruleset | null {
  const name: string = (value ?? '').toLowerCase().trim();
  if (name === '' || name === 'japanese' || name === 'korean') return 'territory';
  return null;
}

/** One move as the history planes need it. */
export interface RecentMove {
  /** Board index, or `passMove(board)`. */
  readonly move: number;
  readonly player: Stone;
}

export interface Inputs {
  /** `[1, rows, cols, 22]` in NHWC order. */
  readonly spatial: Float32Array;
  /** `[1, 19]`. */
  readonly global: Float32Array;
}

/** Reusable buffers, so a search does not allocate per evaluation. */
export interface FeatureScratch {
  readonly spatial: Float32Array;
  readonly global: Float32Array;
  readonly liberties: Uint8Array;
}

export function createFeatureScratch(board: Board): FeatureScratch {
  return {
    spatial: new Float32Array(board.area * SPATIAL_CHANNELS),
    global: new Float32Array(GLOBAL_CHANNELS),
    liberties: new Uint8Array(board.area),
  };
}

/** Raised when a position cannot be encoded, rather than encoded wrongly. */
export class FeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeatureError';
  }
}

export interface FeatureRequest {
  readonly board: Board;
  readonly state: BoardState;
  /** Whose turn it is. */
  readonly toPlay: Stone;
  /** Chronological; the last entry is the most recent move. */
  readonly history: readonly RecentMove[];
  /** Komi as the record gives it, from Black's point of view. */
  readonly komi: number;
  readonly ruleset: Ruleset;
  /**
   * Ladder planes 14-17, if computed. Absent leaves them zero, which is what
   * KataGo sees for a position with no ladders — and, for a position that has
   * one, a lie. `ladder.ts` supplies them.
   */
  readonly ladders?: {
    readonly captured?: Uint8Array;
    readonly capturedPrev?: Uint8Array;
    readonly capturedPrevPrev?: Uint8Array;
    readonly workingMoves?: Uint8Array;
  };
}

/**
 * Fill the input planes for one position.
 *
 * Writes into `scratch` and returns views onto it, so nothing is allocated per
 * evaluation. The result is only valid until the next call.
 */
export function buildFeatures(request: FeatureRequest, scratch: FeatureScratch): Inputs {
  const { board, state, toPlay, history, komi, ruleset } = request;

  if (board.cols !== board.rows) {
    // The planes themselves would encode fine; the network's own geometry is
    // what does not. Refusing here is the only place it can be said clearly.
    throw new FeatureError(`The network needs a square board, not ${board.cols}x${board.rows}.`);
  }
  if (ruleset !== 'territory') {
    throw new FeatureError(
      'Area scoring needs the pass-alive planes, which are not implemented. ' +
        'Only territory scoring (Japanese, Korean) is supported.',
    );
  }

  const spatial: Float32Array = scratch.spatial;
  const global: Float32Array = scratch.global;
  spatial.fill(0);
  global.fill(0);

  const opponent: Stone = opponentOf(toPlay);
  const liberties: Uint8Array = libertyMap(board, state, scratch.liberties);

  for (let point = 0; point < board.area; point++) {
    const at: number = point * SPATIAL_CHANNELS;
    // Plane 0 marks the board itself, which matters to a network whose input is
    // padded: it is how the edge is distinguished from empty space.
    spatial[at] = 1;

    const stone: number = state.stones[point];
    if (stone === EMPTY) continue;
    spatial[at + (stone === toPlay ? 1 : 2)] = 1;

    // Planes 3, 4, 5: one, two, three liberties. More than three is left blank
    // rather than given a plane of its own — a group with four is not in danger
    // in a way the network needs told.
    const count: number = liberties[point];
    if (count >= 1 && count <= 3) spatial[at + 2 + count] = 1;
  }

  if (state.koPoint >= 0) spatial[state.koPoint * SPATIAL_CHANNELS + 6] = 1;

  const ladders = request.ladders;
  if (ladders) {
    for (let point = 0; point < board.area; point++) {
      const at: number = point * SPATIAL_CHANNELS;
      if (ladders.captured?.[point]) spatial[at + 14] = 1;
      if (ladders.capturedPrev?.[point]) spatial[at + 15] = 1;
      if (ladders.capturedPrevPrev?.[point]) spatial[at + 16] = 1;
      if (ladders.workingMoves?.[point]) spatial[at + 17] = 1;
    }
  }

  /*
   * Planes 9-13 and globals 0-4: the last five moves, most recent first.
   *
   * The alternation check is not defensive coding. KataGo only encodes history
   * while the players actually alternated from the current player's point of
   * view, and stops at the first move that breaks the pattern — a handicap
   * placement, or a record with two moves by one colour. Encoding past that
   * point would tell the network a sequence that never happened.
   */
  const pass: number = passMove(board);
  const lastMove: RecentMove | undefined = history[history.length - 1];
  const passWouldEndGame: boolean = lastMove?.move === pass;
  const expected: readonly Stone[] = [opponent, toPlay, opponent, toPlay, opponent];

  for (let i = 0; i < 5; i++) {
    const move: RecentMove | undefined = history[history.length - 1 - i];
    if (!move || move.player !== expected[i]) break;
    if (move.move === pass) global[i] = 1;
    else spatial[move.move * SPATIAL_CHANNELS + 9 + i] = 1;
  }

  // Komi from the point of view of the player to move, scaled the way the
  // network was trained to read it.
  const selfKomi: number = toPlay === BLACK ? -komi : komi;
  global[5] = selfKomi / 20;

  // Territory scoring with a seki tax, which is what Japanese and Korean mean.
  global[9] = 1;
  global[10] = 1;

  global[14] = passWouldEndGame ? 1 : 0;

  return { spatial, global };
}
