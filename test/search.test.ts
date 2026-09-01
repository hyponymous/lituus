/**
 * The PUCT search, against a hand-written network.
 *
 * No GPU and no 37MB download: every test here supplies its own `Network`, so
 * the search's arithmetic is exercised in milliseconds and the position that
 * produces a given answer is chosen rather than found. What these tests cannot
 * check is whether the transcription agrees with KataGo — only the conformance
 * run against `experiments/out/` can do that (`docs/design-ai-scoring.md` §9.1).
 * What they can check is everything that would make such a run meaningless: a
 * frame flipped, an illegal move visited, a mask ignored, a search that is not
 * a function of its inputs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLACK,
  WHITE,
  createBoard,
  emptyState,
  passMove,
  playMove,
  type Board,
  type BoardState,
  type Stone,
} from '../src/engine/board.ts';
import { SPATIAL_CHANNELS } from '../src/engine/features-v7.ts';
import type { Evaluation } from '../src/engine/model-v8.ts';
import { Search, type MoveAnalysis, type SearchRequest, type SearchResult } from '../src/engine/search.ts';

const SIZE = 7;
const AREA = SIZE * SIZE;

/**
 * Multipliers chosen so a test can name the number it wants.
 *
 * These are the real network's own scaling — twenty points per unit of raw
 * output — because the postprocessing that reads them is part of what is under
 * test, and a network with all multipliers set to one would leave it unexercised.
 */
const POST_PROCESS = {
  tdScoreMultiplier: 20,
  scoreMeanMultiplier: 20,
  scoreStdevMultiplier: 20,
  leadMultiplier: 20,
  varianceTimeMultiplier: 40,
  shorttermValueErrorMultiplier: 0.25,
  shorttermScoreErrorMultiplier: 30,
  outputScaleMultiplier: 1,
};

/**
 * Whether White is to move, read out of the global planes.
 *
 * The self-komi is the one input that carries the colour: it is the komi from
 * the point of view of whoever is to move, so with a positive komi it is
 * positive for White and negative for Black. A stub needs this because the
 * network answers in the player-to-move's frame, and an opinion that does not
 * flip with the colour is not an opinion about a position at all — it is a
 * contradiction, and the search is right to report it as one.
 */
function whiteToMove(global: Float32Array): boolean {
  return global[5] > 0;
}

/** What the stub says about one position, in the player-to-move's own terms. */
interface Opinion {
  /** Per-point policy logits; anything omitted is zero. */
  readonly policy?: ReadonlyMap<number, number>;
  readonly passLogit?: number;
  /** Points ahead, for whoever is to move. */
  readonly lead?: number;
  /** Win probability for whoever is to move, as a logit difference. */
  readonly winLogit?: number;
}

interface Stub {
  readonly network: {
    evaluate(spatial: Float32Array, global: Float32Array, cols: number): Evaluation;
    readonly postProcess: typeof POST_PROCESS;
  };
  /** How many forward passes have been asked for. */
  calls(): number;
}

/**
 * The stones on the board, read back out of the input planes.
 *
 * Plane 1 holds the stones of whoever is to move and plane 2 the opponent's, so
 * recovering an absolute colour needs to know which that is — the same
 * relativity the value head answers in.
 */
function occupied(spatial: Float32Array, white: boolean): Map<number, Stone> {
  const mover: Stone = white ? WHITE : BLACK;
  const other: Stone = white ? BLACK : WHITE;
  const stones = new Map<number, Stone>();
  for (let point = 0; point < AREA; point++) {
    const at: number = point * SPATIAL_CHANNELS;
    if (spatial[at + 1] === 1) stones.set(point, mover);
    else if (spatial[at + 2] === 1) stones.set(point, other);
  }
  return stones;
}

function stubNetwork(opine: (stones: Map<number, Stone>, white: boolean) => Opinion): Stub {
  let calls = 0;
  return {
    calls: () => calls,
    network: {
      postProcess: POST_PROCESS,
      evaluate: (spatial: Float32Array, global: Float32Array): Evaluation => {
        calls += 1;
        const white: boolean = whiteToMove(global);
        const opinion: Opinion = opine(occupied(spatial, white), white);
        const policy = new Float32Array(AREA);
        if (opinion.policy) for (const [point, logit] of opinion.policy) policy[point] = logit;
        return {
          policy,
          policyPass: opinion.passLogit ?? 0,
          // Win, loss and no-result logits. No-result is pushed far down: the
          // stub is not trying to model a triple ko.
          value: Float32Array.from([opinion.winLogit ?? 0, 0, -30]),
          // scoreMean, stdev pre-softplus, lead, varTimeLeft pre-softplus.
          scoreValue: Float32Array.from([
            (opinion.lead ?? 0) / POST_PROCESS.scoreMeanMultiplier,
            -2,
            (opinion.lead ?? 0) / POST_PROCESS.leadMultiplier,
            0,
          ]),
        };
      },
    },
  };
}

function request(
  board: Board, state: BoardState, toPlay: Stone, maxVisits: number,
  extra: Partial<SearchRequest> = {},
): SearchRequest {
  return {
    board,
    state,
    toPlay,
    history: [],
    komi: 6.5,
    movesPlayed: { black: 0, white: 0 },
    ruleset: 'territory',
    maxVisits,
    ...extra,
  };
}

test('the root gets exactly the visits it was asked for, one forward pass each', () => {
  const board: Board = createBoard(SIZE, SIZE);
  const stub: Stub = stubNetwork(() => ({}));
  const result: SearchResult = new Search(stub.network, board).run(
    request(board, emptyState(board), BLACK, 20),
  );
  assert.equal(result.rootVisits, 20);
  // The root's own evaluation is the first of them, so the count is not 21.
  assert.equal(stub.calls(), 20);
});

test('visits follow the policy when the network sees no difference in value', () => {
  const board: Board = createBoard(SIZE, SIZE);
  const centre: number = 3 * SIZE + 3;
  const corner = 0;
  const stub: Stub = stubNetwork(() => ({
    policy: new Map([
      [centre, 4],
      [corner, 2],
    ]),
    passLogit: -10,
  }));
  const result: SearchResult = new Search(stub.network, board).run(
    request(board, emptyState(board), BLACK, 40),
  );

  const byPoint = new Map(result.moves.map((m: MoveAnalysis) => [m.point, m]));
  const centreMove = byPoint.get(centre);
  const cornerMove = byPoint.get(corner);
  assert.ok(centreMove && cornerMove);
  assert.ok(centreMove.prior > cornerMove.prior);
  assert.ok(
    centreMove.visits > cornerMove.visits,
    `centre ${centreMove.visits} vs corner ${cornerMove.visits}`,
  );
  assert.equal(result.moves[0].point, centre);
});

test('the search finds the move the network rewards, and quotes its lead', () => {
  const board: Board = createBoard(SIZE, SIZE);
  const prize: number = 2 * SIZE + 4;
  // One consistent claim about the world: a *Black* stone on the prize point is
  // worth twenty points to Black. The stub reports it in whichever frame it is
  // asked in, so the claim does not change as the search descends — and White
  // taking the point for itself is worth nothing, which is what makes the move
  // Black's to find rather than something every line arrives at.
  // The prize is given a *lower* prior than three decoys, so ranking it first
  // has to come from reading rather than from the policy. Some prior is needed:
  // with a flat policy the parent's utility variance collapses, exploration
  // with it, and the search never tries the eighteenth-best-looking move —
  // which is KataGo's behaviour too, and not what this test is about.
  const decoys: readonly number[] = [0, 1, 2];
  const stub: Stub = stubNetwork((stones: Map<number, Stone>, white: boolean) => ({
    lead: stones.get(prize) === BLACK ? (white ? -20 : 20) : 0,
    policy: new Map([[prize, 2], ...decoys.map((d): [number, number] => [d, 3])]),
    passLogit: -10,
  }));
  const result: SearchResult = new Search(stub.network, board).run(
    request(board, emptyState(board), BLACK, 60),
  );

  assert.ok(
    result.moves.find((m: MoveAnalysis) => m.point === prize)!.prior <
      result.moves.find((m: MoveAnalysis) => m.point === decoys[0])!.prior,
  );
  assert.equal(result.moves[0].point, prize);
  assert.ok(result.moves[0].scoreLead > 15, `lead was ${result.moves[0].scoreLead}`);
  const decoy = result.moves.find((m: MoveAnalysis) => m.point === decoys[0]);
  assert.ok(decoy && decoy.scoreLead < 5);
  // The root is worth something now that it can see the prize, but less than
  // the prize itself: most of its weight is its own unimproved evaluation.
  assert.ok(result.rootScoreLead > 0 && result.rootScoreLead < 20);
});

test('a lead is quoted for whoever moved at the root, whichever colour that is', () => {
  const board: Board = createBoard(SIZE, SIZE);
  // White is ten points ahead, said in the frame of whoever is asked.
  const stub: Stub = stubNetwork((_stones: Map<number, Stone>, white: boolean) => ({
    lead: white ? 10 : -10,
  }));
  const search = new Search(stub.network, board);

  const black: SearchResult = search.run(request(board, emptyState(board), BLACK, 8));
  assert.ok(black.rootScoreLead < 0, `Black was told it was ahead: ${black.rootScoreLead}`);
  assert.ok(Math.abs(black.rootScoreLead + 10) < 1e-6);

  const white: SearchResult = search.run(request(board, emptyState(board), WHITE, 8));
  assert.ok(white.rootScoreLead > 0, `White was told it was behind: ${white.rootScoreLead}`);
  assert.ok(Math.abs(white.rootScoreLead - 10) < 1e-6);
});

test('an occupied point, a suicide and a ko retake are never visited', () => {
  const board: Board = createBoard(SIZE, SIZE);
  const state: BoardState = emptyState(board);
  const at = (col: number, row: number): number => row * SIZE + col;

  // White stone at (0,0) with Black surrounding it, so Black just took it and
  // (0,0) is a ko point; and a filled Black eye at (5,5) that White may not
  // fill without capturing itself.
  state.stones[at(1, 0)] = BLACK;
  state.stones[at(0, 1)] = BLACK;
  state.stones[at(2, 0)] = WHITE;
  state.stones[at(1, 1)] = WHITE;
  state.stones[at(0, 2)] = WHITE;
  state.koPoint = at(0, 0);

  state.stones[at(5, 4)] = BLACK;
  state.stones[at(4, 5)] = BLACK;
  state.stones[at(6, 5)] = BLACK;
  state.stones[at(5, 6)] = BLACK;

  const forbidden: number = at(0, 0);
  const suicide: number = at(5, 5);
  // Ask for exactly the points that cannot be played, as loudly as possible.
  const stub: Stub = stubNetwork(() => ({
    policy: new Map([
      [forbidden, 20],
      [suicide, 20],
      [at(1, 0), 20],
    ]),
  }));
  const result: SearchResult = new Search(stub.network, board).run(
    request(board, state, WHITE, 30),
  );

  for (const point of [forbidden, suicide, at(1, 0)]) {
    const move = result.moves.find((m: MoveAnalysis) => m.point === point);
    assert.equal(move, undefined, `illegal point ${point} was searched`);
  }
  assert.ok(result.moves.length > 0);
  // And the shape really is what the test claims it is.
  assert.equal(playMove(board, state, suicide, WHITE, []), null);
});

test('a root mask restricts the root and only the root', () => {
  const board: Board = createBoard(SIZE, SIZE);
  const allowed: number = 4 * SIZE + 1;
  const favourite: number = 3 * SIZE + 3;
  const stub: Stub = stubNetwork(() => ({
    policy: new Map([[favourite, 8]]),
    passLogit: -10,
  }));
  const result: SearchResult = new Search(stub.network, board).run(
    request(board, emptyState(board), BLACK, 25, { allowedRootMoves: [allowed] }),
  );

  assert.equal(result.moves.length, 1);
  assert.equal(result.moves[0].point, allowed);
  assert.equal(result.moves[0].visits, 24);
  // Below the root the search is unrestricted, so the reply it expects is the
  // move the policy actually likes.
  assert.ok(result.moves[0].pv.length > 1);
  assert.equal(result.moves[0].pv[1], favourite);
});

test('the same request twice gives the same answer', () => {
  const board: Board = createBoard(SIZE, SIZE);
  const build = (): Stub =>
    stubNetwork((stones: Map<number, Stone>) => ({
      policy: new Map([[stones.size * 3 + 1, 3]]),
      lead: stones.size % 2 === 0 ? 4 : -6,
    }));
  const first: SearchResult = new Search(build().network, board).run(
    request(board, emptyState(board), BLACK, 40),
  );
  const second: SearchResult = new Search(build().network, board).run(
    request(board, emptyState(board), BLACK, 40),
  );
  assert.deepEqual(first, second);
});

test('one Search instance can be reused, and does not remember the last position', () => {
  const board: Board = createBoard(SIZE, SIZE);
  const stub: Stub = stubNetwork((stones: Map<number, Stone>) => ({ lead: stones.size }));
  const search = new Search(stub.network, board);
  const alone: SearchResult = search.run(request(board, emptyState(board), BLACK, 15));

  const busy: BoardState = emptyState(board);
  busy.stones[0] = BLACK;
  busy.stones[1] = WHITE;
  search.run(request(board, busy, BLACK, 15));

  const again: SearchResult = search.run(request(board, emptyState(board), BLACK, 15));
  assert.deepEqual(again, alone);
});

test('passing is available and is searched when it is the only legal move', () => {
  const board: Board = createBoard(SIZE, SIZE);
  const state: BoardState = emptyState(board);
  // Fill the board so that nothing but a pass is legal for White.
  for (let point = 0; point < AREA; point++) state.stones[point] = BLACK;
  const stub: Stub = stubNetwork(() => ({}));
  const result: SearchResult = new Search(stub.network, board).run(
    request(board, state, WHITE, 6),
  );
  assert.equal(result.moves.length, 1);
  assert.equal(result.moves[0].point, passMove(board));
});
