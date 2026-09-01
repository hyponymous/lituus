/**
 * A single-threaded PUCT search, transcribed from KataGo.
 *
 * `analyzeMcts.ts` upstream is 2,836 lines because it serves an analysis
 * product: ownership maps, regions of interest, wide-root noise, tree reuse,
 * progressive reporting. lituus needs none of that. What it needs is the part
 * that determines the numbers, and that part has to match, because every
 * threshold in `docs/prd-ai-scoring.md` was calibrated against searches this
 * one is meant to reproduce (`docs/design-ai-scoring.md` §4.3, §9.1).
 *
 * The constants live in `search-params.ts`, with a note on each saying where
 * upstream keeps it. The arithmetic that turns points into utility lives in
 * `score-value.ts`. What is left here is the tree.
 *
 * **Simplifications, and why each is safe.** Upstream distinguishes a child's
 * *edge* visits from its *node* visits, because two paths can reach the same
 * node under graph search. Graph search is deferred (`search-params.ts`), so
 * the two are always equal here and the distinction is dropped rather than
 * carried as a field that is never different. Upstream also runs many threads
 * with virtual losses; one thread has none, so the virtual-loss term in
 * `getExploreSelectionValueOfChild` is gone. Neither is a change to a formula:
 * both are the formula with a term that is provably zero.
 *
 * **What this search does not know how to do is end a game.** Under territory
 * scoring two passes send KataGo into the encore rather than finishing, and the
 * encore is a large part of `boardhistory.cpp` with its own ko rules. No node
 * is ever treated as terminal here. From a prompted position at fifty visits
 * the tree does not reach a double pass, so the case is unreachable rather than
 * handled — but it is a real limit, and the endgame rows of the conformance run
 * are where it would show.
 */

import {
  BLACK,
  EMPTY,
  WHITE,
  opponentOf,
  passMove,
  playMove,
  undoMove,
  type Board,
  type BoardState,
  type Stone,
  type Undo,
} from './board.ts';
import {
  buildFeatures,
  createFeatureScratch,
  type FeatureScratch,
  type Inputs,
  type RecentMove,
  type Ruleset,
} from './features-v7.ts';
import {
  createLadderInputs,
  createLadderScratch,
  ladderInputs,
  type LadderInputs,
  type LadderScratch,
} from './ladder.ts';
import type { Evaluation, Judgement } from './model-v8.ts';
import type { ParsedKataGoModelV8 } from './model-types.ts';
import { expectedScoreValue, scoreStdev, valueWeightCdf } from './score-value.ts';
import {
  CPUCT_EXPLORATION,
  CPUCT_EXPLORATION_BASE,
  CPUCT_EXPLORATION_LOG,
  CPUCT_UTILITY_STDEV_PRIOR,
  CPUCT_UTILITY_STDEV_PRIOR_WEIGHT,
  CPUCT_UTILITY_STDEV_SCALE,
  DYNAMIC_SCORE_CENTER_SCALE,
  DYNAMIC_SCORE_CENTER_ZERO_WEIGHT,
  DYNAMIC_SCORE_UTILITY_FACTOR,
  FPU_LOSS_PROP,
  FPU_PARENT_WEIGHT_BY_VISITED_POLICY_POW,
  FPU_REDUCTION_MAX,
  LCB_STDEVS,
  MIN_VISIT_PROP_FOR_LCB,
  NOISE_PRUNE_UTILITY_SCALE,
  NO_RESULT_UTILITY_FOR_WHITE,
  POLICY_ILLEGAL_SELECTION_VALUE,
  ROOT_FPU_LOSS_PROP,
  ROOT_FPU_REDUCTION_MAX,
  STATIC_SCORE_UTILITY_FACTOR,
  TOTAL_CHILD_WEIGHT_PUCT_OFFSET,
  UTILITY_RANGE_RADIUS,
  VALUE_WEIGHT_EXPONENT,
  WIN_LOSS_UTILITY_FACTOR,
} from './search-params.ts';

/**
 * What the search needs of a network: one forward pass, and the per-network
 * multipliers that turn its logits into points.
 *
 * `ModelV8` satisfies this. So does a hand-written stub, which is how the
 * search is unit-tested without a GPU or a 37MB download.
 */
export interface Network {
  evaluate(spatial: Float32Array, global: Float32Array, cols: number): Evaluation;
  readonly postProcess: ParsedKataGoModelV8['postProcessParams'];
}

/** The position to search, and everything the network needs to read it. */
export interface SearchRequest {
  readonly board: Board;
  /** The position as the guesser saw it. Copied; not mutated. */
  readonly state: BoardState;
  readonly toPlay: Stone;
  /** Moves before this position, chronological, most recent last. */
  readonly history: readonly RecentMove[];
  /** The two positions before this one, for ladder planes 15 and 16. */
  readonly previous?: BoardState;
  readonly previousPrevious?: BoardState;
  readonly komi: number;
  readonly movesPlayed: { readonly black: number; readonly white: number };
  readonly ruleset: Ruleset;
  readonly maxVisits: number;
  /**
   * Restrict the root to these moves, as board indices.
   *
   * This is KataGo's `allowMoves` with `untilDepth: 1`, which is how every
   * forced-guess figure in `docs/prd-ai-scoring.md` §8b was measured: the mask
   * applies at the root and nowhere below it. Playing the guess and searching
   * the child instead is close but not the same search, and the recall numbers
   * were not measured that way (`docs/design-ai-scoring.md` §4.3).
   */
  readonly allowedRootMoves?: readonly number[];
}

/** What the search made of one move from the root. */
export interface MoveAnalysis {
  /** Board index, or `board.area` for a pass. */
  readonly point: number;
  readonly visits: number;
  /** The policy's prior, after legality masking. */
  readonly prior: number;
  /** Points, from the *root player's* point of view — KataGo's SIDETOMOVE. */
  readonly scoreLead: number;
  readonly winrate: number;
  /** How play is expected to continue, as board indices. */
  readonly pv: readonly number[];
}

export interface SearchResult {
  readonly rootVisits: number;
  /** Points, from the root player's point of view. */
  readonly rootScoreLead: number;
  readonly rootWinrate: number;
  /** Sorted as KataGo orders `moveInfos`: best first. */
  readonly moves: readonly MoveAnalysis[];
}

/**
 * A node's accumulated statistics.
 *
 * Every value is in **White's frame**, as upstream's are: `winLossValueAvg` is
 * positive when White is ahead whoever is to move. The player-to-move framing
 * that the product quotes is applied once, at the very end. Getting this
 * backwards produces numbers that look entirely reasonable and are negated.
 */
interface Stats {
  visits: number;
  winLossValueAvg: number;
  noResultValueAvg: number;
  scoreMeanAvg: number;
  scoreMeanSqAvg: number;
  leadAvg: number;
  utilityAvg: number;
  utilitySqAvg: number;
  weightSum: number;
  weightSqSum: number;
}

/** One leaf evaluation, in White's frame. */
interface LeafValues {
  readonly winLossValue: number;
  readonly noResultValue: number;
  readonly scoreMean: number;
  readonly scoreMeanSq: number;
  readonly lead: number;
}

interface Node {
  readonly toPlay: Stone;
  /** Null until the node has been evaluated. */
  nn: LeafValues | null;
  /** Length `area + 1`; -1 marks an illegal move, as upstream's does. */
  policy: Float32Array | null;
  readonly childMoves: number[];
  readonly children: Node[];
  readonly stats: Stats;
}

function emptyStats(): Stats {
  return {
    visits: 0,
    winLossValueAvg: 0,
    noResultValueAvg: 0,
    scoreMeanAvg: 0,
    scoreMeanSqAvg: 0,
    leadAvg: 0,
    utilityAvg: 0,
    utilitySqAvg: 0,
    weightSum: 0,
    weightSqSum: 0,
  };
}

function createNode(toPlay: Stone): Node {
  return { toPlay, nn: null, policy: null, childMoves: [], children: [], stats: emptyStats() };
}

const softplus = (x: number): number => {
  if (x > 20) return x;
  if (x < -20) return Math.exp(x);
  return Math.log1p(Math.exp(x));
};

/** Scratch shared across one node's stats recomputation. */
interface ChildStats {
  stats: Stats;
  selfUtility: number;
  weightAdjusted: number;
  prior: number;
}

export class Search {
  private readonly network: Network;
  private readonly board: Board;
  private readonly sqrtBoardArea: number;
  private readonly pass: number;

  private readonly featureScratch: FeatureScratch;
  private readonly ladderScratch: LadderScratch;
  private readonly ladders: LadderInputs;
  private readonly captureStack: number[] = [];

  /** The state the descent is currently standing on; the root's, mutated. */
  private state!: BoardState;
  /**
   * The positions one and two moves back, as a stack: the last entry is the
   * most recent. Ladder planes 15 and 16 read them. Seeded from the record at
   * the root and extended with a snapshot before every move of the descent.
   */
  private readonly path: (BoardState | undefined)[] = [];
  private history!: RecentMove[];
  private blackMoves = 0;
  private whiteMoves = 0;
  private komi = 0;
  private ruleset: Ruleset = 'territory';
  private recentScoreCenter = 0;
  private allowedRootMoves: Set<number> | null = null;

  constructor(network: Network, board: Board) {
    this.network = network;
    this.board = board;
    // Upstream's `Board::sqrtBoardArea`. Square boards only, which
    // `buildFeatures` already enforces, but the formula is upstream's.
    this.sqrtBoardArea = Math.sqrt(board.cols * board.rows);
    this.pass = passMove(board);
    this.featureScratch = createFeatureScratch(board);
    this.ladderScratch = createLadderScratch(board);
    this.ladders = createLadderInputs(board);
  }

  run(request: SearchRequest): SearchResult {
    this.state = { stones: Uint8Array.from(request.state.stones), koPoint: request.state.koPoint };
    this.history = [...request.history];
    this.blackMoves = request.movesPlayed.black;
    this.whiteMoves = request.movesPlayed.white;
    this.komi = request.komi;
    this.ruleset = request.ruleset;
    this.captureStack.length = 0;
    this.path.length = 0;
    this.allowedRootMoves = request.allowedRootMoves
      ? new Set(request.allowedRootMoves)
      : null;

    // The two positions before the root come from the record rather than from
    // the tree. Either may be absent — in the opening they do not exist — and
    // `ladderInputs` falls back the way upstream does when they are.
    this.path.push(request.previousPrevious, request.previous);

    const root: Node = createNode(request.toPlay);

    /*
     * The dynamic score centre, fixed once for the whole search.
     *
     * Upstream: `Search::beginSearch`. With no tree to reuse it takes a fresh
     * network evaluation of the root and pulls it a fifth of the way towards
     * zero, capped at a board-length either side. Every score utility in the
     * search is measured relative to this number, so it has to be settled
     * before the first playout rather than drifting with the tree.
     */
    const rootEval: LeafValues = this.evaluateInto(root);
    const expectedScore: number = rootEval.scoreMean;
    let center: number = expectedScore * (1 - DYNAMIC_SCORE_CENTER_ZERO_WEIGHT);
    const cap: number = this.sqrtBoardArea * DYNAMIC_SCORE_CENTER_SCALE;
    if (center > expectedScore + cap) center = expectedScore + cap;
    if (center < expectedScore - cap) center = expectedScore - cap;
    this.recentScoreCenter = center;

    // The root's own stats were written before the centre was known, so its
    // utility is stale by exactly that. Rewrite it.
    this.setLeafStats(root, rootEval);

    while (root.stats.visits < request.maxVisits) this.playout(root, true);

    return this.report(root);
  }

  // ---------------------------------------------------------------- utility

  /** Upstream: `getResultUtility`. */
  private resultUtility(winLossValue: number, noResultValue: number): number {
    return (
      winLossValue * WIN_LOSS_UTILITY_FACTOR + noResultValue * NO_RESULT_UTILITY_FOR_WHITE
    );
  }

  /** Upstream: `getScoreUtility`. */
  private scoreUtility(scoreMean: number, scoreMeanSq: number): number {
    const stdev: number = scoreStdev(scoreMean, scoreMeanSq);
    const staticValue: number = expectedScoreValue(
      scoreMean, stdev, 0, 2.0, this.sqrtBoardArea,
    );
    const dynamicValue: number = expectedScoreValue(
      scoreMean, stdev, this.recentScoreCenter, DYNAMIC_SCORE_CENTER_SCALE, this.sqrtBoardArea,
    );
    return (
      staticValue * STATIC_SCORE_UTILITY_FACTOR + dynamicValue * DYNAMIC_SCORE_UTILITY_FACTOR
    );
  }

  private utilityOf(values: LeafValues): number {
    return (
      this.resultUtility(values.winLossValue, values.noResultValue) +
      this.scoreUtility(values.scoreMean, values.scoreMeanSq)
    );
  }

  // ------------------------------------------------------------ evaluation

  /**
   * Run the network on the position the descent is standing on, and store the
   * result on the node.
   *
   * Upstream: `initNodeNNOutput` plus the client-side postprocessing in
   * `nneval.cpp`. Everything comes back in **White's frame**: the network
   * answers from the point of view of the player to move, and upstream negates
   * the score and swaps win for loss when that player is Black. Values inside
   * the tree are compared across plies, so they cannot be left in a frame that
   * alternates.
   */
  private evaluateInto(node: Node): LeafValues {
    const toPlay: Stone = node.toPlay;
    const back: number = this.path.length;
    ladderInputs(
      this.board,
      this.state,
      this.path[back - 1],
      this.path[back - 2],
      toPlay,
      this.ladderScratch,
      this.ladders,
    );

    const inputs: Inputs = buildFeatures(
      {
        board: this.board,
        state: this.state,
        toPlay,
        history: this.history,
        komi: this.komi,
        movesPlayed: { black: this.blackMoves, white: this.whiteMoves },
        ruleset: this.ruleset,
        ladders: this.ladders,
      },
      this.featureScratch,
    );

    const evaluation: Evaluation = this.network.evaluate(
      inputs.spatial, inputs.global, this.board.cols,
    );
    const params = this.network.postProcess;
    const scale: number = params.outputScaleMultiplier;

    const winLogit: number = evaluation.value[0] * scale;
    const lossLogit: number = evaluation.value[1] * scale;
    const noResultLogit: number = evaluation.value[2] * scale;
    const highest: number = Math.max(winLogit, lossLogit, noResultLogit);
    const winExp: number = Math.exp(winLogit - highest);
    const lossExp: number = Math.exp(lossLogit - highest);
    const noResultExp: number = Math.exp(noResultLogit - highest);
    const total: number = winExp + lossExp + noResultExp;
    const winProb: number = winExp / total;
    const lossProb: number = lossExp / total;
    const noResultProb: number = noResultExp / total;

    // Territory scoring keeps the no-result head. Upstream suppresses it only
    // when the ko rule is not simple *and* scoring is not territory, which
    // Japanese and Korean rules never are.
    let scoreMean: number = evaluation.scoreValue[0] * scale * params.scoreMeanMultiplier;
    const stdev: number =
      softplus(evaluation.scoreValue[1] * scale) * params.scoreStdevMultiplier;
    let scoreMeanSq: number = scoreMean * scoreMean + stdev * stdev;
    let lead: number = evaluation.scoreValue[2] * scale * params.leadMultiplier;

    // Score is conditional on the game having a result; make it unconditional,
    // counting a no-result as zero points.
    const alive: number = 1 - noResultProb;
    scoreMean *= alive;
    scoreMeanSq *= alive;
    lead *= alive;

    const white: boolean = toPlay === WHITE;
    const values: LeafValues = {
      winLossValue: white ? winProb - lossProb : lossProb - winProb,
      noResultValue: noResultProb,
      scoreMean: white ? scoreMean : -scoreMean,
      scoreMeanSq,
      lead: white ? lead : -lead,
    };

    node.nn = values;
    node.policy = this.policyProbabilities(evaluation, toPlay);
    return values;
  }

  /**
   * Softmax the policy over legal moves, marking the rest -1.
   *
   * Upstream: `nneval.cpp`. The -1 is load-bearing rather than cosmetic — the
   * selection code tests `nnPolicyProb < 0` to skip a move, so an illegal move
   * has to be negative and not merely small.
   *
   * Legality here is the full question, not just "is the point empty": a
   * suicide and a ko retake are both occupied-looking to a mask that only reads
   * stones, and both are excluded upstream. `playMove` already answers it, and
   * asking it 361 times costs about 25 microseconds against a forward pass of
   * tens of milliseconds.
   */
  private policyProbabilities(evaluation: Evaluation, toPlay: Stone): Float32Array {
    const area: number = this.board.area;
    const out = new Float32Array(area + 1);

    let highest = -Infinity;
    const legal = new Uint8Array(area + 1);
    for (let point = 0; point < area; point++) {
      if (this.state.stones[point] !== EMPTY) continue;
      const undo: Undo | null = playMove(
        this.board, this.state, point, toPlay, this.captureStack,
      );
      if (undo === null) continue;
      undoMove(this.board, this.state, point, toPlay, undo, this.captureStack);
      legal[point] = 1;
      if (evaluation.policy[point] > highest) highest = evaluation.policy[point];
    }
    // Passing is always legal in the main phase.
    legal[area] = 1;
    if (evaluation.policyPass > highest) highest = evaluation.policyPass;

    let total = 0;
    for (let i = 0; i <= area; i++) {
      if (!legal[i]) continue;
      const logit: number = i === area ? evaluation.policyPass : evaluation.policy[i];
      const value: number = Math.exp(logit - highest);
      out[i] = value;
      total += value;
    }
    for (let i = 0; i <= area; i++) out[i] = legal[i] ? out[i] / total : -1;
    return out;
  }

  // --------------------------------------------------------------- playouts

  /**
   * Write a freshly evaluated node's own evaluation as its whole statistics.
   *
   * Upstream: `addLeafValue` with `assumeNoExistingWeight`. The leaf weight is
   * 1: `computeWeightFromNNOutput` returns 1 unless uncertainty weighting is
   * on *and* the network has short-term error heads, and ours has neither.
   */
  private setLeafStats(node: Node, values: LeafValues): void {
    const utility: number = this.utilityOf(values);
    const stats: Stats = node.stats;
    stats.winLossValueAvg = values.winLossValue;
    stats.noResultValueAvg = values.noResultValue;
    stats.scoreMeanAvg = values.scoreMean;
    stats.scoreMeanSqAvg = values.scoreMeanSq;
    stats.leadAvg = values.lead;
    stats.utilityAvg = utility;
    stats.utilitySqAvg = utility * utility;
    stats.weightSum = 1;
    stats.weightSqSum = 1;
    if (stats.visits === 0) stats.visits = 1;
  }

  /**
   * One playout: descend to a leaf, evaluate it, and rebuild the statistics of
   * every node on the way back up.
   *
   * Upstream: `playoutDescend`, with the multithreading gone. The recursion is
   * bounded by the tree's own depth, which at fifty visits is a handful of
   * plies.
   */
  private playout(node: Node, isRoot: boolean): void {
    if (node.nn === null) {
      this.setLeafStats(node, this.evaluateInto(node));
      return;
    }

    const chosen: number = this.selectChild(node, isRoot);
    if (chosen < 0) {
      // Every move forbidden. Upstream counts the visit against the node's own
      // evaluation rather than expanding, and so does this.
      node.stats.visits += 1;
      this.recomputeStats(node);
      return;
    }

    let child: Node;
    if (chosen < node.children.length) {
      child = node.children[chosen];
    } else {
      child = createNode(opponentOf(node.toPlay));
      node.childMoves.push(this.pendingMove);
      node.children.push(child);
    }
    const move: number = node.childMoves[chosen];

    const snapshot: BoardState = {
      stones: Uint8Array.from(this.state.stones),
      koPoint: this.state.koPoint,
    };
    const undo: Undo | null = playMove(
      this.board, this.state, move, node.toPlay, this.captureStack,
    );
    // Selection only ever returns a move the policy mask called legal, so this
    // cannot fail. If it ever does, losing the playout is better than
    // corrupting the board the rest of the search stands on.
    if (undo === null) {
      node.stats.visits += 1;
      this.recomputeStats(node);
      return;
    }
    this.path.push(snapshot);
    this.history.push({ player: node.toPlay, move });
    if (move !== this.pass) {
      if (node.toPlay === BLACK) this.blackMoves += 1;
      else this.whiteMoves += 1;
    }

    this.playout(child, false);

    if (move !== this.pass) {
      if (node.toPlay === BLACK) this.blackMoves -= 1;
      else this.whiteMoves -= 1;
    }
    this.history.pop();
    this.path.pop();
    undoMove(this.board, this.state, move, node.toPlay, undo, this.captureStack);

    node.stats.visits += 1;
    this.recomputeStats(node);
  }

  /** The move `selectChild` picked when it picked a child that does not exist yet. */
  private pendingMove = -1;

  // -------------------------------------------------------------- selection

  /**
   * Pick the child to descend into, or -1 if every move is forbidden.
   *
   * Upstream: `selectBestChildToDescend`. Returns an index into `children`, or
   * `children.length` for a new child whose move is left in `pendingMove` —
   * upstream signals the same case the same way, with `bestChildIdx` equal to
   * the number of children found.
   */
  private selectChild(node: Node, isRoot: boolean): number {
    const policy: Float32Array = node.policy as Float32Array;
    const area: number = this.board.area;

    let policyProbMassVisited = 0;
    let totalChildWeight = 0;
    for (let i = 0; i < node.children.length; i++) {
      const prior: number = policy[node.childMoves[i]];
      if (prior < 0) continue;
      policyProbMassVisited += prior;
      totalChildWeight += node.children[i].stats.weightSum;
    }

    const fpu: number = this.fpuValue(node, isRoot, policyProbMassVisited);
    const exploreScaling: number = this.exploreScaling(
      totalChildWeight, this.parentUtilityStdevFactor,
    );

    let bestValue: number = POLICY_ILLEGAL_SELECTION_VALUE;
    let bestIdx = -1;
    this.pendingMove = -1;

    for (let i = 0; i < node.children.length; i++) {
      const child: Node = node.children[i];
      const prior: number = policy[node.childMoves[i]];
      const childWeight: number = child.stats.weightSum;
      const childUtility: number =
        child.stats.visits <= 0 || childWeight <= 0 ? fpu : child.stats.utilityAvg;
      const value: number = this.exploreSelectionValue(
        exploreScaling, prior, childWeight, childUtility, node.toPlay,
      );
      if (value > bestValue) {
        bestValue = value;
        bestIdx = i;
      }
    }

    // The best move not yet tried. Upstream considers exactly one — the
    // unvisited move with the highest prior — because every unvisited move
    // shares the same FPU utility, so the highest prior necessarily wins.
    const tried = new Set<number>(node.childMoves);
    let bestNewMove = -1;
    let bestNewPrior = -1;
    for (let move = 0; move <= area; move++) {
      if (tried.has(move)) continue;
      const prior: number = policy[move];
      if (prior < 0) continue;
      if (isRoot && this.allowedRootMoves !== null && !this.allowedRootMoves.has(move)) continue;
      if (prior > bestNewPrior) {
        bestNewPrior = prior;
        bestNewMove = move;
      }
    }
    if (bestNewMove >= 0) {
      const value: number = this.exploreSelectionValue(
        exploreScaling, bestNewPrior, 0, fpu, node.toPlay,
      );
      if (value > bestValue) {
        bestValue = value;
        bestIdx = node.children.length;
        this.pendingMove = bestNewMove;
      }
    }
    return bestIdx;
  }

  /** Upstream: `getExploreScaling`, and the `cpuctExploration` helper above it. */
  private exploreScaling(totalChildWeight: number, parentUtilityStdevFactor: number): number {
    const cpuct: number =
      CPUCT_EXPLORATION +
      CPUCT_EXPLORATION_LOG *
        Math.log((totalChildWeight + CPUCT_EXPLORATION_BASE) / CPUCT_EXPLORATION_BASE);
    return (
      cpuct *
      Math.sqrt(totalChildWeight + TOTAL_CHILD_WEIGHT_PUCT_OFFSET) *
      parentUtilityStdevFactor
    );
  }

  /** Upstream: `getExploreSelectionValue`. */
  private exploreSelectionValue(
    exploreScaling: number,
    prior: number,
    childWeight: number,
    childUtility: number,
    toPlay: Stone,
  ): number {
    if (prior < 0) return POLICY_ILLEGAL_SELECTION_VALUE;
    const explore: number = (exploreScaling * prior) / (1 + childWeight);
    // Utilities are in White's frame; flip at the last moment so each player
    // prefers what is good for them.
    return explore + (toPlay === WHITE ? childUtility : -childUtility);
  }

  /** Set as a side effect of `fpuValue`, exactly as upstream's out-parameter is. */
  private parentUtilityStdevFactor = 1;

  /**
   * First-play urgency: what to assume about a move nobody has tried.
   *
   * Upstream: `getFpuValueForChildrenAssumeVisited`, which also computes the
   * parent's utility standard deviation on the way past — that is what makes
   * cPUCT dynamic, and it is returned through an out-parameter there and a
   * field here.
   */
  private fpuValue(node: Node, isRoot: boolean, policyProbMassVisited: number): number {
    const stats: Stats = node.stats;
    const parentUtility: number = stats.utilityAvg;

    const variancePrior: number = CPUCT_UTILITY_STDEV_PRIOR * CPUCT_UTILITY_STDEV_PRIOR;
    let parentUtilityStdev: number;
    if (stats.visits <= 0 || stats.weightSum <= 1) {
      parentUtilityStdev = CPUCT_UTILITY_STDEV_PRIOR;
    } else {
      const utilitySq: number = parentUtility * parentUtility;
      // Guard against a negative variance from floating-point noise, as upstream does.
      const utilitySqAvg: number = Math.max(stats.utilitySqAvg, utilitySq);
      parentUtilityStdev = Math.sqrt(
        Math.max(
          0,
          ((utilitySq + variancePrior) * CPUCT_UTILITY_STDEV_PRIOR_WEIGHT +
            utilitySqAvg * stats.weightSum) /
            (CPUCT_UTILITY_STDEV_PRIOR_WEIGHT + stats.weightSum - 1) -
            utilitySq,
        ),
      );
    }
    this.parentUtilityStdevFactor =
      1 + CPUCT_UTILITY_STDEV_SCALE * (parentUtilityStdev / CPUCT_UTILITY_STDEV_PRIOR - 1);

    // Blend the searched average towards the raw network value in proportion to
    // how much policy mass has actually been looked at: early on the average is
    // one child's opinion, and the network's own estimate is the better prior.
    const nn: LeafValues = node.nn as LeafValues;
    const avgWeight: number = Math.min(
      1, Math.pow(policyProbMassVisited, FPU_PARENT_WEIGHT_BY_VISITED_POLICY_POW),
    );
    const parentUtilityForFpu: number =
      avgWeight * parentUtility + (1 - avgWeight) * this.utilityOf(nn);

    const reductionMax: number = isRoot ? ROOT_FPU_REDUCTION_MAX : FPU_REDUCTION_MAX;
    const lossProp: number = isRoot ? ROOT_FPU_LOSS_PROP : FPU_LOSS_PROP;
    const reduction: number = reductionMax * Math.sqrt(policyProbMassVisited);
    let fpu: number =
      node.toPlay === WHITE
        ? parentUtilityForFpu - reduction
        : parentUtilityForFpu + reduction;
    const lossValue: number = node.toPlay === WHITE ? -UTILITY_RANGE_RADIUS : UTILITY_RANGE_RADIUS;
    fpu = fpu + (lossValue - fpu) * lossProp;
    return fpu;
  }

  // ---------------------------------------------------------------- backup

  /** Scratch for one node's recomputation. Reused; the search is single-threaded. */
  private readonly statsBuf: ChildStats[] = [];

  private childStatsAt(i: number): ChildStats {
    let entry: ChildStats | undefined = this.statsBuf[i];
    if (entry === undefined) {
      entry = { stats: emptyStats(), selfUtility: 0, weightAdjusted: 0, prior: 0 };
      this.statsBuf[i] = entry;
    }
    return entry;
  }

  /**
   * Rebuild a node's statistics from its children plus its own evaluation.
   *
   * Upstream: `recomputeNodeStats`. Not an incremental update — the whole node
   * is recomputed from scratch every visit, because both weightings below
   * depend on the full set of children and cannot be applied one at a time.
   */
  private recomputeStats(node: Node): void {
    const policy: Float32Array = node.policy as Float32Array;
    let good = 0;
    let totalChildWeight = 0;

    for (let i = 0; i < node.children.length; i++) {
      const child: Node = node.children[i];
      if (child.stats.visits <= 0 || child.stats.weightSum <= 0) continue;
      const entry: ChildStats = this.childStatsAt(good);
      Object.assign(entry.stats, child.stats);
      const childUtility: number = child.stats.utilityAvg;
      entry.selfUtility = node.toPlay === WHITE ? childUtility : -childUtility;
      entry.weightAdjusted = child.stats.weightSum;
      // Clamped as upstream clamps it: a zero prior would make the raw-policy
      // share of the weight a division by zero in noise pruning.
      entry.prior = Math.max(1e-30, policy[node.childMoves[i]]);
      totalChildWeight += entry.weightAdjusted;
      good += 1;
    }

    if (good > 0) totalChildWeight = this.pruneNoiseWeight(good, totalChildWeight);
    this.downweightBadChildren(good, totalChildWeight);

    let winLossSum = 0;
    let noResultSum = 0;
    let scoreMeanSum = 0;
    let scoreMeanSqSum = 0;
    let leadSum = 0;
    let utilitySum = 0;
    let utilitySqSum = 0;
    let weightSqSum = 0;
    let weightSum: number = totalChildWeight;

    for (let i = 0; i < good; i++) {
      const entry: ChildStats = this.statsBuf[i];
      const stats: Stats = entry.stats;
      const desired: number = entry.weightAdjusted;
      const scaling: number = desired / stats.weightSum;
      winLossSum += desired * stats.winLossValueAvg;
      noResultSum += desired * stats.noResultValueAvg;
      scoreMeanSum += desired * stats.scoreMeanAvg;
      scoreMeanSqSum += desired * stats.scoreMeanSqAvg;
      leadSum += desired * stats.leadAvg;
      utilitySum += desired * stats.utilityAvg;
      utilitySqSum += desired * stats.utilitySqAvg;
      weightSqSum += scaling * scaling * stats.weightSqSum;
    }

    // And the node's own evaluation, which never stops counting for one visit's
    // worth however deep the subtree below it grows.
    const nn: LeafValues = node.nn as LeafValues;
    const utility: number = this.utilityOf(nn);
    winLossSum += nn.winLossValue;
    noResultSum += nn.noResultValue;
    scoreMeanSum += nn.scoreMean;
    scoreMeanSqSum += nn.scoreMeanSq;
    leadSum += nn.lead;
    utilitySum += utility;
    utilitySqSum += utility * utility;
    weightSqSum += 1;
    weightSum += 1;

    const stats: Stats = node.stats;
    stats.winLossValueAvg = winLossSum / weightSum;
    stats.noResultValueAvg = noResultSum / weightSum;
    stats.scoreMeanAvg = scoreMeanSum / weightSum;
    stats.scoreMeanSqAvg = scoreMeanSqSum / weightSum;
    stats.leadAvg = leadSum / weightSum;
    stats.utilityAvg = utilitySum / weightSum;
    stats.utilitySqAvg = utilitySqSum / weightSum;
    stats.weightSqSum = weightSqSum;
    stats.weightSum = weightSum;
  }

  /**
   * Take weight away from children that have more of it than the policy prior
   * justifies and are doing worse than the children ahead of them.
   *
   * Upstream: `pruneNoiseWeight`. Its purpose is to stop one unlucky burst of
   * visits on a bad move from dragging the parent's value down with it — the
   * search visited it, so it has weight, but the prior says it should not have
   * had that much. Returns the new total.
   *
   * Children are walked in creation order, which is descending policy order
   * except where the root mask reorders them, exactly as upstream notes.
   */
  private pruneNoiseWeight(numChildren: number, totalChildWeight: number): number {
    if (numChildren <= 1 || totalChildWeight <= 0.00001) return totalChildWeight;

    let utilitySumSoFar = 0;
    let weightSumSoFar = 0;
    let rawPolicySumSoFar = 0;
    for (let i = 0; i < numChildren; i++) {
      const entry: ChildStats = this.statsBuf[i];
      const utility: number = entry.selfUtility;
      const oldWeight: number = entry.weightAdjusted;
      let newWeight: number = oldWeight;

      if (weightSumSoFar > 0 && rawPolicySumSoFar > 0) {
        const utilityGap: number = utilitySumSoFar / weightSumSoFar - utility;
        if (utilityGap > 0) {
          const share: number = (weightSumSoFar * entry.prior) / rawPolicySumSoFar;
          // Twice its proper share before anything is taken away.
          const lenient: number = 2 * share;
          if (oldWeight > lenient) {
            const excess: number = oldWeight - lenient;
            newWeight =
              oldWeight - excess * (1 - Math.exp(-utilityGap / NOISE_PRUNE_UTILITY_SCALE));
            entry.weightAdjusted = newWeight;
          }
        }
      }
      utilitySumSoFar += utility * newWeight;
      weightSumSoFar += newWeight;
      rawPolicySumSoFar += entry.prior;
    }
    return weightSumSoFar;
  }

  /**
   * Downweight children whose value is bad relative to their siblings, then
   * renormalize back to the same total.
   *
   * Upstream: `downweightBadChildrenAndNormalizeWeight`. The weight a child
   * keeps is the probability, under a t-distribution with three degrees of
   * freedom, that its true value is at least the sibling average — raised to
   * `valueWeightExponent`. A child whose value is far worse and well measured
   * keeps almost none of its weight; one that is worse but barely visited keeps
   * most of it, because its own standard deviation is wide.
   *
   * The pruning and subtraction branches upstream carries are for root Dirichlet
   * noise, which is off, so both amounts are zero here.
   */
  private downweightBadChildren(numChildren: number, desiredTotalWeight: number): void {
    if (numChildren <= 0 || desiredTotalWeight <= 0) return;

    const stdevs = new Float64Array(numChildren);
    let simpleValueSum = 0;
    for (let i = 0; i < numChildren; i++) {
      const entry: ChildStats = this.statsBuf[i];
      if (entry.stats.visits === 0) continue;
      const precision: number = 1.5 * Math.sqrt(entry.weightAdjusted);
      // A floor on the variance, for stability rather than for realism.
      stdevs[i] = Math.sqrt(0.00000001 + 1 / precision);
      simpleValueSum += entry.selfUtility * entry.weightAdjusted;
    }
    const simpleValue: number = simpleValueSum / desiredTotalWeight;

    let totalNewUnnormWeight = 0;
    for (let i = 0; i < numChildren; i++) {
      const entry: ChildStats = this.statsBuf[i];
      if (entry.stats.visits === 0) continue;
      const z: number = (entry.selfUtility - simpleValue) / stdevs[i];
      // The tiny addend keeps a child that scores zero from vanishing outright.
      const p: number = valueWeightCdf(z) + 0.0001;
      entry.weightAdjusted *= Math.pow(p, VALUE_WEIGHT_EXPONENT);
      totalNewUnnormWeight += entry.weightAdjusted;
    }
    if (totalNewUnnormWeight <= 0) return;
    const factor: number = desiredTotalWeight / totalNewUnnormWeight;
    for (let i = 0; i < numChildren; i++) this.statsBuf[i].weightAdjusted *= factor;
  }

  // -------------------------------------------------------------- reporting

  /**
   * The weight each root move should be *played* with, which is also what the
   * analysis output sorts by.
   *
   * Upstream: `getPlaySelectionValues`. Three things happen here that do not
   * happen during the search, and all three change which move is called best:
   *
   * 1. A child that got more visits than it retrospectively deserved has them
   *    reduced (`getReducedPlaySelectionWeight`). The search commits visits
   *    before it knows how they turn out; this un-commits them.
   * 2. The move with the best lower confidence bound is promoted, by enough
   *    weight to beat every sibling it genuinely beats. A move with fewer
   *    visits but a tighter, better estimate should be played over a
   *    well-trodden one that is merely popular.
   * 3. Both are skipped when `useLcb` is false, which is how upstream computes
   *    the root's own reported value — that has to be an average over the
   *    children, not a ranking of them.
   */
  private playSelectionValues(node: Node, useLcb: boolean): {
    values: Float64Array;
    lcb: Float64Array;
    radius: Float64Array;
  } {
    const count: number = node.children.length;
    const policy: Float32Array = node.policy as Float32Array;
    const values = new Float64Array(count);
    const lcb = new Float64Array(count);
    const radius = new Float64Array(count);

    let totalChildWeight = 0;
    for (let i = 0; i < count; i++) {
      const weight: number = node.children[i].stats.weightSum;
      totalChildWeight += weight;
      values[i] = policy[node.childMoves[i]] < 0 ? 0 : weight;
    }
    if (count === 0) return { values, lcb, radius };

    // The most stably explored child, used as the yardstick for the reduction
    // below. Upstream discounts one visit's worth of weight because the most
    // recent visit is the one most likely to be an outlier, and adds a little
    // raw policy so that at very low visit counts the answer is not noise.
    let bestIdx = 0;
    let bestWeight = -1e30;
    let bestGoodness = -1e30;
    for (let i = 0; i < count; i++) {
      const visits: number = node.children[i].stats.visits;
      const goodness: number =
        (values[i] * Math.max(0, visits - 1)) / Math.max(1, visits) +
        2 * policy[node.childMoves[i]];
      if (goodness > bestGoodness) {
        bestGoodness = goodness;
        bestWeight = values[i];
        bestIdx = i;
      }
    }

    const policyProbMassVisited = 1.0; // Unused: the FPU value it feeds is not read here.
    this.fpuValue(node, true, policyProbMassVisited);
    const exploreScaling: number = this.exploreScaling(
      totalChildWeight, this.parentUtilityStdevFactor,
    );

    const bestChild: Node = node.children[bestIdx];
    const bestPrior: number = policy[node.childMoves[bestIdx]];
    const bestExploreValue: number = this.exploreSelectionValue(
      exploreScaling, bestPrior, bestChild.stats.weightSum, bestChild.stats.utilityAvg,
      node.toPlay,
    );

    for (let i = 0; i < count; i++) {
      if (i === bestIdx) continue;
      const child: Node = node.children[i];
      const prior: number = policy[node.childMoves[i]];
      if (child.stats.visits <= 0 || child.stats.weightSum <= 0 || prior < 0) {
        values[i] = 0;
        continue;
      }
      const wanted: number = this.exploreSelectionValueInverse(
        bestExploreValue, exploreScaling, prior, child.stats.utilityAvg, node.toPlay,
      );
      values[i] = Math.ceil(Math.min(child.stats.weightSum, wanted));
    }

    if (!useLcb) return { values, lcb, radius };

    let bestLcb = -1e10;
    let bestLcbIndex = -1;
    for (let i = 0; i < count; i++) {
      this.selfUtilityLcbAndRadius(node, node.children[i], i, lcb, radius);
      if (values[i] > 0 && values[i] >= MIN_VISIT_PROP_FOR_LCB * bestWeight) {
        if (lcb[i] > bestLcb) {
          bestLcb = lcb[i];
          bestLcbIndex = i;
        }
      }
    }
    if (bestLcbIndex >= 0) {
      let adjusted: number = values[bestLcbIndex];
      for (let i = 0; i < count; i++) {
        if (i === bestLcbIndex) continue;
        const excess: number = bestLcb - lcb[i];
        // This sibling is actually the better bound; it just failed the minimum
        // weight test. Nothing to claim over it.
        if (excess < 0) continue;
        // How much wider would this sibling's interval have to be before its
        // bound was worse? The denominator's 0.2 caps the factor at five.
        const factor: number = (radius[i] + excess) / (radius[i] + 0.2 * excess);
        const bound: number = factor * factor * values[i];
        if (bound > adjusted) adjusted = bound;
      }
      values[bestLcbIndex] = adjusted;
    }
    return { values, lcb, radius };
  }

  /** Upstream: `getExploreSelectionValueInverse`. */
  private exploreSelectionValueInverse(
    selectionValue: number,
    exploreScaling: number,
    prior: number,
    childUtility: number,
    toPlay: Stone,
  ): number {
    if (prior < 0) return 0;
    const value: number = toPlay === WHITE ? childUtility : -childUtility;
    const explore: number = selectionValue - value;
    if (explore <= 0) return 1e100;
    return Math.max(0, (exploreScaling * prior) / explore - 1);
  }

  /**
   * A child's lower confidence bound, in the parent's frame.
   *
   * Upstream: `getSelfUtilityLCBAndRadius`. The prior it mixes in is the point:
   * with three visits a sample variance means almost nothing, so upstream adds
   * a little weight at the widest variance the utility range allows, and lets
   * that prior wash out as the visit count grows.
   */
  private selfUtilityLcbAndRadius(
    node: Node, child: Node, index: number, lcb: Float64Array, radius: Float64Array,
  ): void {
    const widest: number = 2 * UTILITY_RANGE_RADIUS * LCB_STDEVS;
    radius[index] = widest;
    lcb[index] = -widest;

    const stats: Stats = child.stats;
    let weightSum: number = stats.weightSum;
    let weightSqSum: number = stats.weightSqSum;
    if (stats.visits <= 0 || weightSum <= 0 || weightSqSum <= 0) return;

    let ess: number = (weightSum * weightSum) / weightSqSum;
    const priorWeight: number = weightSum / (ess * ess * ess);
    let utilitySqAvg: number = Math.max(
      stats.utilitySqAvg, stats.utilityAvg * stats.utilityAvg + 1e-8,
    );
    utilitySqAvg =
      (utilitySqAvg * weightSum +
        (utilitySqAvg + UTILITY_RANGE_RADIUS * UTILITY_RANGE_RADIUS) * priorWeight) /
      (weightSum + priorWeight);
    weightSum += priorWeight;
    weightSqSum += priorWeight * priorWeight;
    ess = (weightSum * weightSum) / weightSqSum;

    const selfUtility: number =
      node.toPlay === WHITE ? stats.utilityAvg : -stats.utilityAvg;
    const variance: number = utilitySqAvg - stats.utilityAvg * stats.utilityAvg;
    const estimateStdev: number = Math.sqrt(variance / ess);
    radius[index] = estimateStdev * LCB_STDEVS;
    lcb[index] = selfUtility - radius[index];
  }

  /**
   * The principal variation from a node down, as board indices.
   *
   * Upstream: `appendPV`. At every ply it asks the same question the root asks
   * — the highest play selection value, LCB and all — rather than simply
   * following visit counts, so the line the reader is shown is the line the
   * search would actually play.
   */
  private principalVariation(node: Node, maxDepth: number): number[] {
    const pv: number[] = [];
    let current: Node = node;
    for (let depth = 0; depth < maxDepth; depth++) {
      if (current.children.length === 0 || current.policy === null) break;
      const { values } = this.playSelectionValues(current, true);
      let bestIdx = -1;
      let bestValue: number = POLICY_ILLEGAL_SELECTION_VALUE;
      for (let i = 0; i < values.length; i++) {
        if (values[i] > bestValue) {
          bestValue = values[i];
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;
      pv.push(current.childMoves[bestIdx]);
      current = current.children[bestIdx];
    }
    return pv;
  }

  /**
   * The root's own reported value: an average over its children weighted by
   * how much they would be played, plus its own evaluation.
   *
   * Upstream: `getPrunedNodeValues`. Deliberately *not* `stats.leadAvg` — that
   * average is weighted by how much the search happened to visit each child,
   * and the retrospective reduction in `playSelectionValues` is exactly the
   * correction for the difference. Every point loss in this product is a
   * difference between this number and a child's, so using the wrong one would
   * bias every loss by the same amount and be invisible in the result.
   */
  private prunedRootValues(node: Node): { lead: number; winLossValue: number } {
    const { values } = this.playSelectionValues(node, false);
    let leadSum = 0;
    let winLossSum = 0;
    let weightSum = 0;
    for (let i = 0; i < node.children.length; i++) {
      const stats: Stats = node.children[i].stats;
      if (stats.visits <= 0 || stats.weightSum <= 0) continue;
      const weight: number = values[i];
      leadSum += weight * stats.leadAvg;
      winLossSum += weight * stats.winLossValueAvg;
      weightSum += weight;
    }
    const nn: LeafValues = node.nn as LeafValues;
    leadSum += nn.lead;
    winLossSum += nn.winLossValue;
    weightSum += 1;
    return { lead: leadSum / weightSum, winLossValue: winLossSum / weightSum };
  }

  /**
   * Turn the finished tree into the analysis output.
   *
   * The frame flips here and only here. Everything above is in White's frame;
   * KataGo's analysis engine reports with `reportAnalysisWinratesAs = SIDETOMOVE`,
   * which negates by the **root** player — so a child's score is quoted from
   * the point of view of the player who was to move at the root, not of
   * whoever moves at the child. That is what makes a point loss the plain
   * difference of two numbers.
   */
  private report(root: Node): SearchResult {
    const flip: number = root.toPlay === BLACK ? -1 : 1;
    const { values } = this.playSelectionValues(root, true);
    const policy: Float32Array = root.policy as Float32Array;

    // Carries the selection value the sort needs and the result does not.
    interface Ranked extends MoveAnalysis {
      readonly selectionValue: number;
    }
    const moves: Ranked[] = root.children.map((child: Node, i: number): Ranked => {
      const stats: Stats = child.stats;
      const searched: boolean = stats.visits > 0 && stats.weightSum > 1e-30;
      // An unsearched child reports its parent's numbers, as upstream does:
      // saying nothing would be worse than saying "no different from here".
      const lead: number = searched ? stats.leadAvg : root.stats.leadAvg;
      const winLossValue: number = searched
        ? stats.winLossValueAvg
        : root.stats.winLossValueAvg;
      return {
        point: root.childMoves[i],
        visits: stats.visits,
        prior: policy[root.childMoves[i]],
        scoreLead: lead * flip,
        winrate: 0.5 + 0.5 * winLossValue * flip,
        pv: [root.childMoves[i], ...this.principalVariation(child, ANALYSIS_PV_LENGTH - 1)],
        selectionValue: values[i],
      };
    });

    // Upstream: `operator<` on AnalysisData, applied with a stable sort.
    moves.sort((a, b) => {
      const aSearched: number = a.visits > 0 ? 1 : 0;
      const bSearched: number = b.visits > 0 ? 1 : 0;
      if (aSearched !== bSearched) return bSearched - aSearched;
      const bySelection: number = b.selectionValue - a.selectionValue;
      if (bySelection !== 0) return bySelection;
      if (a.visits !== b.visits) return b.visits - a.visits;
      return b.prior - a.prior;
    });

    const rootValues: { lead: number; winLossValue: number } = this.prunedRootValues(root);
    return {
      rootVisits: root.stats.visits,
      rootScoreLead: rootValues.lead * flip,
      rootWinrate: 0.5 + 0.5 * rootValues.winLossValue * flip,
      moves: moves.map(({ selectionValue: _selectionValue, ...move }) => move),
    };
  }
}

/**
 * How far a reported variation runs.
 *
 * `analysisPVLen` in `cpp/command/analysis.cpp`, whose default is 15 and which
 * the configs that recorded `experiments/out/` did not set. The product shows
 * only the first two or three plies — at fifty visits the tail of a line is
 * barely searched — but the recorded reference PVs are this long, and a
 * conformance run that compares them has to ask for the same depth.
 */
const ANALYSIS_PV_LENGTH = 15;
