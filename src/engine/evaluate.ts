/**
 * The bridge from a game record to a search, and from a search to a `Verdict`.
 *
 * `search.ts` knows about positions and does not know what a game is; the
 * `Evaluator` interface knows what a prompt is and does not know what a network
 * is. This module is the only place both are in scope. It answers the three
 * questions a search cannot answer for itself:
 *
 * - **What does the network need to know that a position does not carry?** The
 *   komi, the ruleset, the last five moves, how many stones each player has
 *   placed, and the two positions before this one. All of them come from the
 *   record, and all of them change the answer.
 * - **When is a second, restricted search worth running?** PRD §8b: forcing the
 *   guess is the difference between catching 14% of a twenty-kyu's blunders and
 *   catching 82%. The rule for *when* is a visit floor, not null-ness.
 * - **What is a point loss?** The unrestricted root's lead minus the move's,
 *   both quoted from the root player's side, exactly as `analyze.ts` computes
 *   it from KataGo's own output.
 */

import type { BestMove, EngineConfig, MoveVerdict, NaturalMove, Verdict } from '../analysis.ts';
import { MIN_TRUSTED_VISITS } from '../analysis.ts';
import { EvaluationError, type Evaluator, type Prompt } from '../evaluator.ts';
import type { Game, GameMove } from '../game.ts';
import { BLACK, WHITE, createBoard, fromPosition, passMove } from './board.ts';
import type { Board, BoardState, Stone } from './board.ts';
import { rulesetOf, type RecentMove, type Ruleset } from './features-v7.ts';
import {
  Search,
  type MoveAnalysis,
  type Network,
  type SearchRequest,
  type SearchResult,
  type SliceOutcome,
} from './search.ts';
import type { Position } from '../rules.ts';

/**
 * Komi when the record does not say.
 *
 * The same default `experiments/katago/analyze.ts` uses, so a browser search and
 * the reference run ask the network the same question about the same file.
 */
export const DEFAULT_KOMI = 6.5;

/** How many moves each player has actually placed before this turn. */
export function movesBefore(game: Game, turn: number): { black: number; white: number } {
  let black = 0;
  let white = 0;
  for (let i = 0; i < turn; i++) {
    const move: GameMove = game.moves[i];
    // Passes place no stone, so they do not chill the komi
    // (`docs/exploration-forward-pass-parity.md` §5.4). Handicap placements are
    // setup rather than moves and are not in `game.moves` at all, which is also
    // how KataGo counts them.
    if (move.index === null) continue;
    if (move.color === 1) black += 1;
    else white += 1;
  }
  return { black, white };
}

/** The last five moves before this turn, chronological. */
export function historyBefore(game: Game, board: Board, turn: number): RecentMove[] {
  const out: RecentMove[] = [];
  for (let i = Math.max(0, turn - 5); i < turn; i++) {
    const move: GameMove = game.moves[i];
    out.push({
      move: move.index ?? passMove(board),
      player: move.color === 1 ? BLACK : WHITE,
    });
  }
  return out;
}

/** Everything a search needs about a record, gathered once. */
export interface GameContext {
  readonly game: Game;
  readonly board: Board;
  readonly komi: number;
  readonly ruleset: Ruleset;
}

export function gameContext(game: Game): GameContext {
  const raw: number = Number(game.meta.komi);
  const ruleset: Ruleset | null = rulesetOf(game.meta.ruleset);
  return {
    game,
    board: createBoard(game.cols, game.rows),
    komi: Number.isFinite(raw) ? raw : DEFAULT_KOMI,
    // An unrecognized or absent ruleset reads as Japanese, matching
    // `analyze.ts`. Area scoring would need the pass-alive planes, which
    // `features-v7.ts` refuses rather than approximates.
    ruleset: ruleset ?? 'territory',
  };
}

/** The turn index whose move has this move number, or -1. */
function turnOf(game: Game, moveNumber: number): number {
  return game.moves.findIndex((move: GameMove) => move.number === moveNumber);
}

function stateAt(board: Board, game: Game, turn: number): BoardState | undefined {
  if (turn < 0 || turn >= game.moves.length) return undefined;
  return fromPosition(board, game.moves[turn].before);
}

/**
 * A variation stops at the first pass.
 *
 * `MoveVerdict.pv` promises this and the replay evaluator has always kept it —
 * KataGo writes "pass" into its analysis output, which does not name a point
 * and so ends the line there. The search hands back a board index for a pass
 * instead, which nothing downstream recognizes: `pointName` turned it into
 * "A0", a name for no point at all, and reading that export back silently
 * shortened every late-game line it appeared in.
 *
 * Truncating rather than dropping the pass is the same decision replay.ts
 * records: a line that continues through one tells a reader nothing, and
 * removing it in place would misrepresent whose move each later ply is.
 */
function untilPass(pv: readonly number[], pass: number): readonly number[] {
  const at: number = pv.indexOf(pass);
  return at === -1 ? pv : pv.slice(0, at);
}

/**
 * And a variation stops where the search stopped reading it.
 *
 * The search reports the visits behind every ply, so the length of a line can
 * be measured instead of assumed: keep the plies a search actually read and
 * drop the tail it merely walked. The floor is `MIN_TRUSTED_VISITS`, the same
 * one that decides a *number* is worth quoting — a ply nobody looked at is not
 * worth showing for the same reason a one-visit score is not.
 *
 * This is PRD §5's honest cutoff, and it is why a line needs no fitted
 * constant: at fifty visits it comes out short on its own, and a deeper search
 * lengthens it without anybody choosing a number.
 */
function untilUnread(pv: readonly number[], pvVisits: readonly number[]): readonly number[] {
  let kept = 0;
  while (kept < pv.length && (pvVisits[kept] ?? 0) >= MIN_TRUSTED_VISITS) kept += 1;
  return pv.slice(0, kept);
}

/** The line as a reader should see it: cut at a pass, then at the search's edge. */
function shownLine(move: MoveAnalysis, pass: number): readonly number[] {
  return untilUnread(untilPass(move.pv, pass), move.pvVisits);
}

/**
 * Everything the network needs to read one prompted position, gathered from the
 * record.
 *
 * Shared by the scoring search and the deepening pass, and that sharing is the
 * point: a deeper search of the same position has to *be* the same question
 * asked harder. A history or a komi assembled twice is a second place for the
 * two to drift apart, and the drift would show up as a line that does not
 * belong to the position it is drawn on.
 */
function requestFor(
  context: GameContext,
  position: Position,
  color: number,
  turn: number,
  visits: number,
): SearchRequest {
  const { game, board } = context;
  return {
    board,
    state: fromPosition(board, position),
    toPlay: color === 1 ? BLACK : WHITE,
    history: historyBefore(game, board, turn),
    previous: stateAt(board, game, turn - 1),
    previousPrevious: stateAt(board, game, turn - 2),
    komi: context.komi,
    movesPlayed: movesBefore(game, turn),
    ruleset: context.ruleset,
    maxVisits: visits,
  };
}

/**
 * Search one prompted position, forcing the guess when the root search did not
 * look at it hard enough to be worth quoting.
 */
export function evaluatePrompt(
  search: Search,
  context: GameContext,
  prompt: Prompt,
  visits: number,
): Verdict {
  const { game, board } = context;
  const turn: number = turnOf(game, prompt.moveNumber);
  if (turn < 0) {
    throw new EvaluationError(`Move ${prompt.moveNumber} is not in this record.`);
  }

  const base: SearchRequest = requestFor(context, prompt.position, prompt.color, turn, visits);

  const root: SearchResult = search.run(base);
  if (root.moves.length === 0) {
    throw new EvaluationError(`The search found no legal move at move ${prompt.moveNumber}.`);
  }

  const pass: number = passMove(board);
  const shown = (move: MoveAnalysis): readonly number[] => shownLine(move, pass);

  const rootLead: number = root.rootScoreLead;
  const found = (point: number): MoveAnalysis | undefined =>
    root.moves.find((move: MoveAnalysis) => move.point === point);

  /*
   * A move the root search barely looked at gets a second search of its own.
   *
   * The condition is a visit floor rather than "did the search visit it at
   * all", and that is a measured distinction: during the rank survey's backfill
   * a one-visit `scoreLead` was out by ten points on a position where every
   * fifty-visit move agreed with a forced search to within 0.2. A one-visit
   * estimate is the raw network evaluation wearing the confidence of a searched
   * one (`analysis.ts`, `MIN_TRUSTED_VISITS`).
   *
   * The loss is measured across both searches — the unrestricted root's lead
   * minus the restricted search's — because a search allowed only one move
   * calls that move best and reports no loss for it, however bad it is.
   */
  const verdictFor = (point: number): MoveVerdict | null => {
    const direct: MoveAnalysis | undefined = found(point);
    if (direct !== undefined && direct.visits >= MIN_TRUSTED_VISITS) {
      return {
        point,
        loss: rootLead - direct.scoreLead,
        visits: direct.visits,
        forced: false,
        pv: shown(direct),
        pvBudget: visits,
      };
    }
    const forcedResult: SearchResult = search.run({ ...base, allowedRootMoves: [point] });
    const forced: MoveAnalysis | undefined = forcedResult.moves[0];
    if (forced === undefined) return null;
    return {
      point,
      loss: rootLead - forced.scoreLead,
      visits: forced.visits,
      forced: true,
      pv: shown(forced),
      pvBudget: visits,
    };
  };

  const bestMove: MoveAnalysis = root.moves[0];
  const best: BestMove = {
    point: bestMove.point,
    scoreLead: bestMove.scoreLead,
    pv: shown(bestMove),
    pvBudget: visits,
  };

  // The move the policy liked before any reading, and what reading made of it.
  // Its loss comes from the root search alone: this is a difficulty signal
  // about the position, and a move nobody looked at was, by construction, not
  // one the search thought worth looking at.
  const top: MoveAnalysis = root.moves.reduce(
    (a: MoveAnalysis, b: MoveAnalysis) => (b.prior > a.prior ? b : a),
  );
  const natural: NaturalMove = {
    point: top.point,
    prior: top.prior,
    loss: rootLead - top.scoreLead,
  };

  // A pass arrives as null and is searched like any other move: the policy has
  // one, numbered past the last intersection, and `search.ts` treats it as
  // always legal in the main phase.
  const played: MoveVerdict | null = verdictFor(prompt.played ?? pass);
  /*
   * A hit is the same move twice; do not pay for it twice. Two passes are the
   * same move on the same terms.
   *
   * No guess at all is a prompt nobody answered, and it is asked about for the
   * position rather than for a comparison: the best move and the played move
   * are the whole answer, and there is no third search to run.
   */
  const guessed: MoveVerdict | null =
    prompt.guess === undefined
      ? null
      : prompt.guess === prompt.played
        ? played
        : verdictFor(prompt.guess ?? pass);

  return {
    moveNumber: prompt.moveNumber,
    rootScoreLead: rootLead,
    rootVisits: root.rootVisits,
    best,
    played,
    guessed,
    natural,
  };
}


/**
 * How many playouts run between two chances to be called off.
 *
 * One prompt's worth. The worker is deaf for the length of a slice — the
 * canary, the memory reading and the cancellation itself all wait behind it —
 * and a prompt's block is the deafness the product already lives with on every
 * guess, so it is the largest unit that adds no new kind of stall.
 */
export const DEEP_SLICE = 50;

/**
 * How long one line may take before the pass settles for what it has.
 *
 * The visit cap is a ceiling on *work* and this is the ceiling on *waiting*,
 * and only the second one is felt: five hundred visits is four and a half
 * seconds on the laptop that was measured and nobody knows what on a device
 * five times slower. Rather than let that run, the search stops here and
 * reports the smaller search it managed — a line read at two hundred visits is
 * still deeper than the fifty the reader already has, and `pvBudget` says which
 * it was.
 *
 * Ten seconds because the fast case must never reach it: a cap the common path
 * trips is a cap that quietly changes what every reader sees.
 */
export const DEEP_MS = 10_000;

/** One move re-read at a larger budget: its line, and deliberately nothing else. */
export interface DeepLine {
  readonly moveNumber: number;
  readonly point: number;
  /**
   * The visits actually spent on it, which becomes the line's `pvBudget`.
   *
   * What was spent rather than what was asked for: a pass that ran out of time
   * reports the smaller search it managed, and a receipt naming a budget the
   * search never reached would be the one field on a deep line that lies.
   */
  readonly visits: number;
  readonly pv: readonly number[];
}

/**
 * Re-read one move at a larger budget and return the line, or null if called off.
 *
 * A loss and a visit count come back from this search too, and both are thrown
 * away here rather than downstream. That is PRD §5 held at the point where the
 * temptation is: a second figure for a move that already has one, measured at a
 * different budget and disagreeing by a point, is worse than the one figure the
 * reader was given — so the only thing allowed out of this function is the
 * shape of the type.
 *
 * The root is restricted to the one move, as the forced scoring search is:
 * the whole budget then reads *this* move's continuation instead of spending
 * most of it confirming that some other move is better, which is the question
 * nobody asked.
 */
export async function deepenLine(
  search: Search,
  context: GameContext,
  moveNumber: number,
  point: number | null,
  visits: number,
  between: () => SliceOutcome,
): Promise<DeepLine | null> {
  const { game, board } = context;
  const turn: number = turnOf(game, moveNumber);
  if (turn < 0) throw new EvaluationError(`Move ${moveNumber} is not in this record.`);
  const move: GameMove = game.moves[turn];
  const at: number = point ?? passMove(board);

  const result: SearchResult | null = await search.runSliced(
    { ...requestFor(context, move.before, move.color, turn, visits), allowedRootMoves: [at] },
    DEEP_SLICE,
    between,
  );
  if (result === null) return null;

  const read: MoveAnalysis | undefined = result.moves[0];
  if (read === undefined) return null;
  return {
    moveNumber,
    point: at,
    visits: result.rootVisits,
    pv: shownLine(read, passMove(board)),
  };
}

/**
 * An evaluator backed by a network in this process.
 *
 * One `Search` is reused across prompts: it owns the feature and ladder scratch
 * buffers, which are sized to the board and would otherwise be reallocated for
 * every position.
 */
export function createEngineEvaluator(
  network: Network,
  game: Game,
  config: EngineConfig,
): Evaluator {
  const context: GameContext = gameContext(game);
  const search = new Search(network, context.board);
  return {
    config,
    evaluate: (prompt: Prompt): Promise<Verdict> =>
      Promise.resolve(evaluatePrompt(search, context, prompt, config.visits)),
  };
}
