/**
 * An evaluator backed by verdicts recorded earlier, rather than by an engine.
 *
 * Everything the product shows about an engine's opinion can be built and
 * tested against this: the six dogfood games already have real verdicts from
 * the shipping configuration sitting in `experiments/out/dogfood/`, produced by
 * native KataGo at b15c192 @ 50 visits. Feeding those through the same
 * interface an in-browser engine will implement means the summary, the exports
 * and the miss taxonomy can be finished, reviewed and regression-tested before
 * a single network is parsed (`docs/design-ai-scoring.md` §12, steps 1–2).
 *
 * It is also the fixture mechanism. A recorded session is a regression test for
 * every AI figure on the summary screen, and needs no GPU to run.
 *
 * Pure: rows come in already parsed, so this module reads no files and works
 * identically in a test, in the dev harness, and in a browser.
 */

import type {
  BestMove,
  EngineConfig,
  MoveVerdict,
  NaturalMove,
  Verdict,
} from './analysis.ts';
import { EvaluationError, type Evaluator, type Prompt } from './evaluator.ts';
import { pointFromName, pointName } from './goban.ts';
import type { Position } from './rules.ts';

/**
 * One prompted position as the harnesses recorded it, with the three files they
 * write already joined — see `joinRecorded`.
 *
 * Points are GTP names ("Q16") because that is what KataGo speaks and what the
 * files hold. Converting them to board indices is this module's job, so that
 * nothing above the evaluator interface ever sees an engine's coordinate
 * system.
 */
export interface RecordedRow {
  readonly moveNumber: number;
  readonly played: string;
  /** Null where the search never looked at the played move. */
  readonly pointLoss: number | null;
  readonly playedVisits: number | null;
  readonly playedPv?: readonly string[];
  /** True where the loss came from a second, forced query rather than the root search. */
  readonly backfilled?: boolean;
  readonly best: string;
  readonly bestScoreLead: number;
  readonly bestPv?: readonly string[];
  readonly topPolicy?: string;
  readonly topPolicyPrior?: number;
  readonly topPolicyLoss?: number;
  readonly rootScoreLead: number;
  readonly rootVisits: number;
  /** From the guesses pass, which forces every guess with `allowMoves`. */
  readonly guess?: string;
  readonly guessLoss?: number;
  readonly guessPv?: readonly string[];
}

/** The `analyze.ts` / backfill row shape, as those files are written. */
export interface RecordedAnalysis {
  readonly moveNumber: number;
  readonly turn: number;
  readonly played: string;
  readonly pointLoss: number | null;
  readonly playedVisits?: number | null;
  readonly playedPv?: readonly string[];
  readonly backfilled?: boolean;
  readonly best: string;
  readonly bestScoreLead: number;
  readonly bestPv?: readonly string[];
  readonly topPolicy?: string;
  readonly topPolicyPrior?: number;
  readonly topPolicyLoss?: number;
  readonly rootScoreLead: number;
  readonly rootVisits: number;
}

/** The `guesses.ts` row shape. Keyed by `turn`, as that file is. */
export interface RecordedGuess {
  readonly turn: number;
  readonly guess: string;
  readonly guessLoss: number;
  readonly guessPv?: readonly string[];
}

/** The backfill row shape: a repair for one turn, carrying no root of its own. */
export interface RecordedBackfill {
  readonly turn: number;
  readonly played: string;
  readonly pointLoss: number | null;
  readonly playedPv?: readonly string[];
  readonly backfilled?: boolean;
}

/**
 * Join the three files the harnesses write into one row per position.
 *
 * The backfill pass repairs positions whose played move the root search barely
 * looked at, so it wins over the base analysis wherever it has an opinion — but
 * only for the played move. It carries no root of its own, deliberately: a
 * query restricted to one move treats that move as best and reports a
 * meaningless root, so the loss has to be measured against the *unrestricted*
 * query's root, which stays here (`docs/prd-ai-scoring.md` §5).
 *
 * Everything is keyed by `turn`, which is what the harnesses agree on; the
 * move number comes from the analysis rows.
 */
export function joinRecorded(
  analysis: readonly RecordedAnalysis[],
  guesses: readonly RecordedGuess[] = [],
  backfill: readonly RecordedBackfill[] = [],
): RecordedRow[] {
  const repairs = new Map(backfill.map((row) => [row.turn, row]));
  const guessed = new Map(guesses.map((row) => [row.turn, row]));

  return analysis.map((row: RecordedAnalysis): RecordedRow => {
    const repair: RecordedBackfill | undefined = repairs.get(row.turn);
    const guess: RecordedGuess | undefined = guessed.get(row.turn);

    // A repair supersedes the base row's verdict on the played move, and brings
    // the full visit budget with it — that is what forcing buys.
    const repaired: boolean = repair !== undefined && repair.pointLoss !== null;

    return {
      moveNumber: row.moveNumber,
      played: row.played,
      pointLoss: repaired ? (repair?.pointLoss ?? null) : row.pointLoss,
      playedVisits: repaired ? null : (row.playedVisits ?? null),
      playedPv: repaired ? repair?.playedPv : row.playedPv,
      backfilled: repaired,
      best: row.best,
      bestScoreLead: row.bestScoreLead,
      bestPv: row.bestPv,
      topPolicy: row.topPolicy,
      topPolicyPrior: row.topPolicyPrior,
      topPolicyLoss: row.topPolicyLoss,
      rootScoreLead: row.rootScoreLead,
      rootVisits: row.rootVisits,
      guess: guess?.guess,
      guessLoss: guess?.guessLoss,
      guessPv: guess?.guessPv,
    };
  });
}

/**
 * A variation as board indices.
 *
 * Truncated at anything that is not a point on this board, which in practice
 * means a pass: a line that continues through one tells a reader nothing, and
 * silently dropping the pass would misrepresent whose move each later ply is.
 */
function variation(board: Position, moves: readonly string[] | undefined): readonly number[] {
  const points: number[] = [];
  for (const move of moves ?? []) {
    const point: number | null = pointFromName(board, move);
    if (point === null) break;
    points.push(point);
  }
  return points;
}

/**
 * Build the verdict for the user's guess.
 *
 * A hit reuses the played move's verdict rather than reporting nothing: it is
 * still a move the engine has an opinion about, and consumers should not have
 * to special-case the case they most want to talk about.
 */
function guessVerdict(
  board: Position,
  row: RecordedRow,
  prompt: Prompt,
  played: MoveVerdict | null,
  visits: number,
): MoveVerdict | null {
  if (prompt.guess === prompt.played) return played;
  if (row.guess === undefined || row.guessLoss === undefined) return null;

  const point: number | null = pointFromName(board, row.guess);
  if (point === null || point !== prompt.guess) return null;

  return {
    point,
    loss: row.guessLoss,
    // The guesses pass forces every guess with `allowMoves`, which spends the
    // whole budget on that one move. The file does not record a visit count
    // because there is only one answer it could be.
    visits,
    forced: true,
    pv: variation(board, row.guessPv),
  };
}

function playedVerdict(board: Position, row: RecordedRow, visits: number): MoveVerdict | null {
  if (row.pointLoss === null) return null;
  const point: number | null = pointFromName(board, row.played);
  if (point === null) return null;

  return {
    point,
    loss: row.pointLoss,
    // A forced repair spent the whole budget on this move; an unforced verdict
    // reports whatever share of the root search it happened to receive.
    visits: row.backfilled === true ? visits : (row.playedVisits ?? 0),
    forced: row.backfilled === true,
    pv: variation(board, row.playedPv),
  };
}

function naturalMove(board: Position, row: RecordedRow): NaturalMove | null {
  if (row.topPolicy === undefined || row.topPolicyLoss === undefined) return null;
  const point: number | null = pointFromName(board, row.topPolicy);
  if (point === null) return null;
  return { point, prior: row.topPolicyPrior ?? 0, loss: row.topPolicyLoss };
}

/**
 * An evaluator that answers from recorded rows.
 *
 * Rows are keyed by move number, which is what a `Prompt` carries and what a
 * verdict is stored under.
 */
export function createReplayEvaluator(
  rows: readonly RecordedRow[],
  config: EngineConfig,
): Evaluator {
  const byMove = new Map(rows.map((row) => [row.moveNumber, row]));

  return {
    config,
    evaluate: (prompt: Prompt): Promise<Verdict> => {
      const row: RecordedRow | undefined = byMove.get(prompt.moveNumber);
      if (!row) {
        return Promise.reject(
          new EvaluationError(`No recorded verdict for move ${prompt.moveNumber}.`),
        );
      }

      const board: Position = prompt.position;

      // The record is checked against the position rather than trusted to
      // match it. A file joined to the wrong game answers every prompt
      // plausibly and wrongly, and there is nothing downstream that could
      // notice — every number in the summary would be quietly about a
      // different board.
      const played: number | null = pointFromName(board, row.played);
      if (played !== prompt.played) {
        return Promise.reject(
          new EvaluationError(
            `Recorded move ${prompt.moveNumber} is ${row.played}, but the game played ` +
              `${pointName(board, prompt.played)}. These records are not for this game.`,
          ),
        );
      }

      const best: number | null = pointFromName(board, row.best);
      if (best === null) {
        return Promise.reject(
          new EvaluationError(`Recorded best move "${row.best}" is not a point on this board.`),
        );
      }

      const playedFor: MoveVerdict | null = playedVerdict(board, row, config.visits);
      const bestMove: BestMove = {
        point: best,
        scoreLead: row.bestScoreLead,
        pv: variation(board, row.bestPv),
      };

      return Promise.resolve({
        moveNumber: row.moveNumber,
        rootScoreLead: row.rootScoreLead,
        rootVisits: row.rootVisits,
        best: bestMove,
        played: playedFor,
        guessed: guessVerdict(board, row, prompt, playedFor, config.visits),
        natural: naturalMove(board, row),
      });
    },
  };
}

/** The configuration the dogfood records were produced at. */
export const RECORDED_CONFIG: EngineConfig = {
  network: 'b15c192',
  visits: 50,
  backend: 'replay',
  // Native KataGo on a machine this build never saw, which is exactly what
  // "no device recorded" means.
  device: null,
};
