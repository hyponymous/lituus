/**
 * Session summary: what the user gets at the end of a run.
 *
 * Pure. Takes a finished (or abandoned) session and produces a plain data
 * structure plus its two export forms. Kept out of the views so the numbers
 * can be tested without a DOM, since a hit rate that is quietly wrong looks
 * exactly like a hit rate that is right.
 */

import { pointName } from './goban.ts';
import { serialize } from './sgf-writer.ts';
import { describe, type Game } from './game.ts';
import { countPrompts, score, type Guess, type Score, type Session } from './session.ts';
import {
  BEAT_MARGIN,
  BLUNDER_LOSS,
  aiResult,
  comparisonOf,
  describeEngine,
  beatPlayed,
  isMisleading,
  lossOf,
  verdictFor,
  type AiResult,
  type EngineIncident,
  type Analysis,
  type Comparison,
  type MoveVerdict,
  type Verdict,
} from './analysis.ts';
import { BLACK, toRowCol, type Color, type Position } from './rules.ts';

export type Phase = 'opening' | 'middle' | 'endgame';

export const PHASES: readonly Phase[] = ['opening', 'middle', 'endgame'];

/**
 * Phase boundaries in move numbers, tuned for 19x19 and scaled by board area
 * so a 9x9 game is not reported as one long opening. Deliberately crude: the
 * PRD asks for simple thresholds, and any real phase detection would need to
 * read the position rather than the move number.
 */
const OPENING_END_19 = 50;
const MIDDLE_END_19 = 150;
const AREA_19 = 19 * 19;

function phaseBounds(game: Game): [number, number] {
  const scale: number = (game.cols * game.rows) / AREA_19;
  return [Math.round(OPENING_END_19 * scale), Math.round(MIDDLE_END_19 * scale)];
}

export function phaseOf(game: Game, moveNumber: number): Phase {
  const [openingEnd, middleEnd] = phaseBounds(game);
  if (moveNumber <= openingEnd) return 'opening';
  if (moveNumber <= middleEnd) return 'middle';
  return 'endgame';
}

export interface PhaseResult {
  readonly phase: Phase;
  readonly guessed: number;
  readonly hits: number;
  /** Hits over guesses in this phase, in [0, 1]. Zero when nothing was guessed. */
  readonly rate: number;
  /**
   * What this phase cost, against what the game's own moves cost over the same
   * moves. Null with no engine, and null in a phase where no prediction has
   * both sides quotable.
   *
   * The same comparison `ai.against` makes, over a slice: with an engine, the
   * question "which phase is weakest" is better answered in points than in
   * exact matches, and the grouping is the one already on screen.
   */
  readonly cost: Comparison | null;
}

/**
 * How far a move can sit from the opponent's last one and still count as an
 * answer to it, measured as a Chebyshev distance so a diagonal counts the same
 * as a straight line.
 */
export const TENUKI_RADIUS = 6;

/** Whether `to` is far enough from `from` to count as playing elsewhere. */
function isAway(pos: Position, from: number, to: number): boolean {
  const [fromRow, fromCol] = toRowCol(pos, from);
  const [toRow, toCol] = toRowCol(pos, to);
  return Math.max(Math.abs(fromRow - toRow), Math.abs(fromCol - toCol)) > TENUKI_RADIUS;
}

/**
 * The point a move is measured against: whatever was played immediately
 * before it. Null at the first move of a record, and after a pass — there is
 * no stone to be near, so nothing can be called local or away.
 */
function referencePoint(game: Game, moveNumber: number): number | null {
  return game.moves[moveNumber - 2]?.index ?? null;
}

export interface SummaryRow {
  readonly moveNumber: number;
  readonly phase: Phase;
  /** Coordinates, e.g. "Q16". */
  readonly guess: string;
  readonly actual: string;
  readonly hit: boolean;
  /** Did the played move go elsewhere? Null when there was nothing to answer. */
  readonly actualAway: boolean | null;
  /** Did your guess go elsewhere? Null on the same terms. */
  readonly guessAway: boolean | null;
  /** How long this one took, or null if it was never measured. */
  readonly elapsedMs: number | null;
  /**
   * What the guess cost, in points, or null with no engine — and also null
   * where the engine looked at the move too briefly for the number to be worth
   * quoting. The two cases are deliberately not distinguished here: a figure
   * that cannot be shown is a figure that cannot be shown.
   */
  readonly loss: number | null;
  /** What the move actually played cost, on the same terms. */
  readonly playedLoss: number | null;
  /** Whether the guess beat the played move by more than the noise floor. */
  readonly beat: boolean;
  /** Whether this position's most natural-looking move was a trap. */
  readonly misleading: boolean;
}

/**
 * Your instinct against the player's, on the one axis where a near-miss still
 * says something: whether to answer locally or leave. Missing the exact point
 * is expected; consistently staying home when the player left is a habit.
 */
export interface Tenuki {
  /** The player left, and so did you. */
  readonly bothAway: number;
  /** The player left; you answered locally. */
  readonly stayedHome: number;
  /** The player answered locally, and so did you. */
  readonly bothLocal: number;
  /** The player answered locally; you left. */
  readonly leftEarly: number;
  /** Predictions with no preceding move to measure against. */
  readonly unscored: number;
  /**
   * Of `bothAway`, how many landed within TENUKI_RADIUS of each other. Both
   * agreeing to leave says little if you left for opposite corners, and the
   * decision matrix alone cannot tell those apart.
   */
  readonly sameArea: number;
}

/**
 * Shortest run of correct predictions worth naming. Two in a row happens by
 * accident often enough that reporting it would bury the runs that don't.
 */
export const STREAK_MIN = 3;

/** A run of consecutive correct predictions, at least STREAK_MIN long. */
export interface Streak {
  /** Index into `rows` of the run's first prediction. */
  readonly start: number;
  readonly length: number;
  /** Move numbers at either end of the run, for display. */
  readonly firstMove: number;
  readonly lastMove: number;
}

/**
 * How long the predictions took.
 *
 * The median leads rather than the mean, and that is not a stylistic
 * preference. Nothing stops the clock when the user looks away, so a single
 * answer given after lunch is an hour long and drags a mean past uselessness.
 * The median survives it; `slowestMs` is where that guess shows up, which is
 * the honest place for it.
 */
export interface Timing {
  /** Predictions that were actually measured. */
  readonly timed: number;
  readonly totalMs: number;
  readonly medianMs: number;
  readonly fastestMs: number;
  readonly slowestMs: number;
}

export interface Summary {
  readonly game: string;
  readonly color: Color;
  readonly score: Score;
  readonly phases: readonly PhaseResult[];
  readonly tenuki: Tenuki;
  readonly rows: readonly SummaryRow[];
  /** Runs of consecutive hits, in the order they were played. */
  readonly streaks: readonly Streak[];
  /** How long it took, or null when nothing was measured. */
  readonly timing: Timing | null;
  /** True when the user stopped before the record ran out. */
  readonly abandoned: boolean;
  /**
   * What the engine made of the session, or null when there was no engine.
   *
   * Subordinate to `score` by design, not by accident: a hit rate is a number
   * the user can check by eye and an engine estimate is not, so exact match
   * stays the headline (`docs/prd-ai-scoring.md` §5).
   */
  readonly ai: AiResult | null;
  /**
   * The verdicts behind `ai`, in move order, or null with no engine.
   *
   * Kept alongside the derived figures rather than instead of them: the
   * figures are what a reader wants, and these are what lets a saved result be
   * recomputed and checked (`docs/design-ai-scoring.md` §9.4).
   */
  readonly verdicts: readonly Verdict[] | null;
  /**
   * The board the session was played on, empty of everything but its shape and
   * any setup stones.
   *
   * Carried so a summary can serialize itself. Every point in this structure is
   * either already a name or an index needing one, and reaching back through
   * `sgf` to re-parse a record for the sake of a few coordinates would be a
   * silly way to render an export.
   */
  readonly board: Position;
  /**
   * The record the session was played on, serialized back to SGF.
   *
   * Carried so an exported result stands on its own. Every other field is a
   * number or a point name, and none of them can draw a board: without the
   * record, a result can be read but not looked at. The JSON export is the
   * only consumer today; anything that reopens a past session will want it.
   */
  readonly sgf: string;
}

function rateOf(hits: number, guessed: number): number {
  return guessed > 0 ? hits / guessed : 0;
}

/**
 * Pair each prediction's local-or-away decision with the player's. The counts
 * are a 2x2: agreement on the diagonal, and the two ways of disagreeing off
 * it. Rates alone would lose the pairing, which is the whole point — matching
 * their tenuki frequency while never choosing the same moments is not
 * agreement.
 */
function tenukiResult(board: Position, game: Game, guesses: readonly Guess[]): Tenuki {
  const counts = {
    bothAway: 0,
    stayedHome: 0,
    bothLocal: 0,
    leftEarly: 0,
    unscored: 0,
    sameArea: 0,
  };

  for (const made of guesses) {
    const from: number | null = referencePoint(game, made.moveNumber);
    // A pass is nowhere on the board, so "did they play away from the last
    // move?" has no answer for it — on either side of the pairing.
    if (from === null || made.actual === null || made.guess === null) {
      counts.unscored++;
      continue;
    }

    const playerLeft: boolean = isAway(board, from, made.actual);
    const youLeft: boolean = isAway(board, from, made.guess);

    if (playerLeft && youLeft) {
      counts.bothAway++;
      if (!isAway(board, made.actual, made.guess)) counts.sameArea++;
    } else if (playerLeft) counts.stayedHome++;
    else if (youLeft) counts.leftEarly++;
    else counts.bothLocal++;
  }

  return counts;
}

/** Predictions where you and the player made the same local-or-away call. */
export function tenukiAgreement(tenuki: Tenuki): { agreed: number; scored: number } {
  const agreed: number = tenuki.bothAway + tenuki.bothLocal;
  return { agreed, scored: agreed + tenuki.stayedHome + tenuki.leftEarly };
}

/**
 * Runs of consecutive hits. Consecutive means consecutive *prompts*, not
 * consecutive move numbers: the opponent's reply always sits between two of
 * them, so the gap is the normal case rather than a break in the run.
 */
function streaksOf(rows: readonly SummaryRow[]): Streak[] {
  const streaks: Streak[] = [];
  let start = 0;

  // One past the end, with a miss implied there, so a run reaching the last
  // prediction is closed by the same code that closes every other one.
  for (let i = 0; i <= rows.length; i++) {
    if (rows[i]?.hit) continue;
    const length: number = i - start;
    if (length >= STREAK_MIN) {
      streaks.push({
        start,
        length,
        firstMove: rows[start].moveNumber,
        lastMove: rows[i - 1].moveNumber,
      });
    }
    start = i + 1;
  }
  return streaks;
}

/**
 * How a prediction compares with the move the game actually played.
 *
 * The axis the review is read on once there is an engine. Hit and miss answer
 * a question the engine has made less interesting: a miss that costs nothing
 * and a miss that costs nine points are the same colour on a hit/miss strip,
 * and they are not the same event. What a reader wants to see down a session
 * is where they did better than the player and where they did worse.
 *
 * `even` is not equality but agreement within `BEAT_MARGIN`, the same half
 * point that governs whether the summary is willing to say you beat the game.
 * A hit lands here by construction — the same move cannot cost two different
 * amounts — which is why exact matches are marked separately rather than given
 * a band of their own.
 *
 * `unscored` covers both "no engine" and "the engine looked too briefly to
 * quote a number", deliberately together: a comparison that cannot be made is
 * a comparison that cannot be made, and either way it must not be drawn as
 * agreement.
 */
export type CostBand = 'better' | 'even' | 'worse' | 'blunder' | 'unscored';

/**
 * What the prediction cost against what the game's move cost, in points.
 *
 * Negative is the good direction — you gave up less than they did — which is
 * the sign convention a point *loss* already carries, kept rather than flipped
 * so the two numbers can be read side by side without a mental negation.
 *
 * Null when either side is missing. Both losses have to be quotable:
 * comparing a searched guess against an unsearched played move would
 * manufacture a verdict out of the engine's silence, which is the same reason
 * `beatPlayed` insists on both.
 */
/**
 * What zero means, on every chart and every per-move figure the summary draws.
 *
 * It was decided per widget before this existed, and never stated: the strip
 * and the board's ghost stones measured from the move the game played, while
 * `medianLoss` and the findings measured from the engine's best — both on
 * screen at once, with nothing saying so. One choice, made by the reader.
 */
export type Baseline = 'played' | 'engine';

/**
 * What a prediction cost against the chosen baseline. Positive is worse, as
 * every loss in this codebase is.
 *
 * Against the engine that is simply the loss. Against the played move it is
 * the difference, which can be negative — you can beat the move the game made,
 * and cannot beat the engine's own.
 *
 * Null when the figure it needs is missing. Against the played move BOTH
 * losses have to be quotable: comparing a searched guess with an unsearched
 * played move would manufacture a verdict out of the engine's silence, which
 * is the same reason `beatPlayed` insists on both.
 */
export function costAgainst(row: SummaryRow, baseline: Baseline): number | null {
  if (row.loss === null) return null;
  if (baseline === 'engine') return row.loss;
  return row.playedLoss === null ? null : row.loss - row.playedLoss;
}

/**
 * Points a prediction, for each side, over the moves both could be scored on.
 *
 * The MEAN, and the medians beside it in `Comparison` are not usable for this.
 * On a hit your move *is* the played move, so with half the predictions
 * matching, both medians are computed mostly over the same entries with the
 * same cost: their difference is damped toward zero by construction, and what
 * is left measures the tail badly. The mean is the statistic where a shared
 * move contributes exactly zero to the difference and a miss carries its full
 * weight. (The median of the differences is 0.00 outright, for the same
 * reason — see `Comparison`.)
 */
export function perPrediction(
  cost: Comparison | null,
): { readonly yours: number; readonly played: number } | null {
  if (cost === null || cost.moves === 0) return null;
  return { yours: cost.yourLoss / cost.moves, played: cost.playedLoss / cost.moves };
}

/**
 * Which band a row falls in.
 *
 * There is no `better` against the engine: its move is the best one by
 * definition, so a negative there is search noise and belongs in `even`.
 */
export function costBand(row: SummaryRow, baseline: Baseline): CostBand {
  const delta: number | null = costAgainst(row, baseline);
  if (delta === null) return 'unscored';

  if (delta <= -BEAT_MARGIN) return baseline === 'played' ? 'better' : 'even';
  if (delta < BEAT_MARGIN) return 'even';
  return delta >= BLUNDER_LOSS ? 'blunder' : 'worse';
}

/** The best run, or null if nothing reached STREAK_MIN. Ties go to the earliest. */
export function longestStreak(summary: Summary): Streak | null {
  let best: Streak | null = null;
  for (const streak of summary.streaks) {
    if (!best || streak.length > best.length) best = streak;
  }
  return best;
}

/**
 * Timings over the predictions that carry one. Null when none do — a session
 * from before timing existed reports nothing rather than a row of zeros,
 * which would read as "instant" instead of "unknown".
 */
function timingOf(guesses: readonly Guess[]): Timing | null {
  const times: number[] = guesses
    .map((made) => made.elapsedMs)
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b);

  if (times.length === 0) return null;

  const middle: number = Math.floor(times.length / 2);
  const medianMs: number =
    times.length % 2 === 0 ? Math.round((times[middle - 1] + times[middle]) / 2) : times[middle];

  return {
    timed: times.length,
    totalMs: times.reduce((sum, ms) => sum + ms, 0),
    medianMs,
    fastestMs: times[0],
    slowestMs: times[times.length - 1],
  };
}

/**
 * A duration for reading, not for arithmetic. Sub-minute times keep one
 * decimal, because the difference between 1.4s and 2.1s is the interesting
 * part of this measurement and rounding to whole seconds erases it.
 */
export function duration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;

  const total: number = Math.round(ms / 1000);
  const minutes: number = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;

  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function phaseResults(game: Game, rows: readonly SummaryRow[]): PhaseResult[] {
  return PHASES.map((phase) => {
    const inPhase: readonly SummaryRow[] = rows.filter((row) => row.phase === phase);
    const hits: number = inPhase.filter((row) => row.hit).length;

    /*
     * Only the predictions where both sides can be quoted, the insistence
     * `Comparison` records: measuring a searched guess against an unsearched
     * played move would manufacture a verdict out of the engine's silence.
     * With no engine every loss is null, so this falls out as null on its own.
     */
    const yours: number[] = [];
    const played: number[] = [];
    for (const row of inPhase) {
      if (row.loss === null || row.playedLoss === null) continue;
      yours.push(row.loss);
      played.push(row.playedLoss);
    }

    return {
      phase,
      guessed: inPhase.length,
      hits,
      rate: rateOf(hits, inPhase.length),
      cost: comparisonOf(yours, played),
    };
  });
}

/**
 * Everything the summary knows about one session.
 *
 * `analysis` is optional and absent by default, so a session that never had an
 * engine — the common case, since AI scoring is off by default — produces
 * exactly the summary it produced before this existed. Every AI field is null
 * or zero rather than missing, so consumers branch once on `summary.ai` instead
 * of on every figure.
 */
export function summarize(session: Session, analysis?: Analysis): Summary {
  const { game, color } = session;
  // Any position serves for naming points; they all share the board's shape.
  const board: Position = game.initial;

  const rows: SummaryRow[] = session.guesses.map((made: Guess) => {
    const from: number | null = referencePoint(game, made.moveNumber);
    const verdict: Verdict | null = analysis ? verdictFor(analysis, made.moveNumber) : null;
    return {
      moveNumber: made.moveNumber,
      phase: phaseOf(game, made.moveNumber),
      guess: pointName(board, made.guess),
      actual: pointName(board, made.actual),
      hit: made.hit,
      actualAway: from === null || made.actual === null
        ? null
        : isAway(board, from, made.actual),
      guessAway: from === null || made.guess === null
        ? null
        : isAway(board, from, made.guess),
      elapsedMs: made.elapsedMs,
      loss: verdict ? lossOf(verdict.guessed) : null,
      playedLoss: verdict ? lossOf(verdict.played) : null,
      beat: verdict ? beatPlayed(verdict) : false,
      misleading: verdict ? isMisleading(verdict) : false,
    };
  });

  return {
    game: describe(game),
    color,
    score: score(session),
    phases: phaseResults(game, rows),
    tenuki: tenukiResult(board, game, session.guesses),
    rows,
    streaks: streaksOf(rows),
    timing: timingOf(session.guesses),
    abandoned: session.guesses.length < countPrompts(game, color),
    ai: analysis ? aiResult(analysis, session.guesses, board) : null,
    verdicts: analysis
      ? session.guesses
          .map((made: Guess) => verdictFor(analysis, made.moveNumber))
          .filter((verdict): verdict is Verdict => verdict !== null)
      : null,
    board,
    sgf: serialize([game.source]),
  };
}

function colorName(color: Color): string {
  return color === BLACK ? 'Black' : 'White';
}

/**
 * Points from the guessing player's side: positive is good, negative is lost.
 *
 * The convention `experiments/katago/review.ts` settled on against a reader:
 * `+0.4` is four tenths of a point to the good, `-3.1` is three points thrown
 * away. "Lost 3.1" in prose is unambiguous and unreadable in a column of thirty.
 *
 * The `+ 0` is not decoration. Negating a loss of exactly zero gives negative
 * zero, which `toFixed` faithfully renders as `-0.0` — so every move the engine
 * thought was perfect would be printed as though it had lost something. The
 * sign is decided at the printed precision for the same reason: a figure that
 * rounds to zero should not be handed a minus sign it does not show.
 *
 * `digits` is for figures that live at a finer scale than one move's loss. A
 * median over a phase is tenths of a point, and at one decimal a whole column
 * of them reads "+0.0".
 */
export function signed(loss: number, digits = 1): string {
  const value: number = -loss + 0;
  return `${value < -0.5 * 10 ** -digits ? '-' : '+'}${Math.abs(value).toFixed(digits)}`;
}

/** A percentage for display. Rounded to whole numbers; nobody needs decimals. */
export function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/**
 * A `Comparison` at export precision: totals to a tenth, medians to a
 * hundredth, as everywhere else a point loss is written down. One function
 * because the session-wide comparison and the per-phase ones are the same
 * shape and must round the same way.
 */
function comparison(against: Comparison | null): object | null {
  if (against === null) return null;
  return {
    moves: against.moves,
    yourLoss: Number(against.yourLoss.toFixed(1)),
    playedLoss: Number(against.playedLoss.toFixed(1)),
    yourMedian: Number(against.yourMedian.toFixed(2)),
    playedMedian: Number(against.playedMedian.toFixed(2)),
  };
}

/**
 * One move verdict as the export writes it. Points named, numbers rounded.
 *
 * Losses round to the same two decimals the derived figures above use, and that
 * is load-bearing rather than tidy. Round the verdict finer than the figure
 * derived from it and a restored result rounds twice — 0.5249 becomes 0.525
 * becomes 0.53, where the original said 0.52 — so the round trip drifts by a
 * hundredth on a handful of moves and the fixture check starts crying wolf.
 * Rounding once, at one precision, makes the trip exact by construction.
 */
function exportMove(verdict: MoveVerdict | null, board: Position): object | null {
  return verdict === null
    ? null
    : {
        point: pointName(board, verdict.point),
        loss: Number(verdict.loss.toFixed(2)),
        visits: verdict.visits,
        forced: verdict.forced,
        pv: verdict.pv.map((point: number) => pointName(board, point)),
      };
}

function exportVerdict(verdict: Verdict, board: Position): object {
  return {
    move: verdict.moveNumber,
    rootScoreLead: Number(verdict.rootScoreLead.toFixed(3)),
    rootVisits: verdict.rootVisits,
    best: {
      point: pointName(board, verdict.best.point),
      scoreLead: Number(verdict.best.scoreLead.toFixed(3)),
      pv: verdict.best.pv.map((point) => pointName(board, point)),
    },
    played: exportMove(verdict.played, board),
    guessed: exportMove(verdict.guessed, board),
    natural:
      verdict.natural === null
        ? null
        : {
            point: pointName(board, verdict.natural.point),
            prior: Number(verdict.natural.prior.toFixed(4)),
            loss: Number(verdict.natural.loss.toFixed(3)),
          },
  };
}

/**
 * What went wrong with the engine, in one sentence, or null if nothing did.
 *
 * Shared by the text export and the summary view so the two cannot describe the
 * same broken session differently. A fatal incident is quoted with its move
 * because that is the fact a reader needs — everything after it is missing for
 * one reason — while scattered refusals are reported as a count, since eight of
 * them at eight positions is one story, not eight.
 */
export function failureNote(ai: AiResult): string | null {
  const stopped: EngineIncident | undefined = ai.incidents.find(
    (incident: EngineIncident) => incident.fatal,
  );
  if (stopped) {
    return (
      `Scoring stopped${stopped.move === null ? '' : ` at move ${stopped.move}`}: ` +
      stopped.reason
    );
  }
  if (ai.failures === 0) return null;
  return (
    `${ai.failures} prediction${ai.failures === 1 ? '' : 's'} could not be scored: ` +
    ai.incidents[0].reason
  );
}

export function toJSON(summary: Summary): string {
  return JSON.stringify(
    {
      game: summary.game,
      color: colorName(summary.color),
      predicted: summary.score.guessed,
      hits: summary.score.hits,
      prompts: summary.score.total,
      rate: Number(summary.score.rate.toFixed(4)),
      abandoned: summary.abandoned,
      tenuki: {
        bothAway: summary.tenuki.bothAway,
        stayedHome: summary.tenuki.stayedHome,
        bothLocal: summary.tenuki.bothLocal,
        leftEarly: summary.tenuki.leftEarly,
        sameArea: summary.tenuki.sameArea,
        unscored: summary.tenuki.unscored,
      },
      timing:
        summary.timing === null
          ? null
          : {
              timed: summary.timing.timed,
              totalMs: summary.timing.totalMs,
              medianMs: summary.timing.medianMs,
              fastestMs: summary.timing.fastestMs,
              slowestMs: summary.timing.slowestMs,
            },
      streaks: summary.streaks.map((streak) => ({
        length: streak.length,
        firstMove: streak.firstMove,
        lastMove: streak.lastMove,
      })),
      phases: summary.phases.map((result) => ({
        phase: result.phase,
        predicted: result.guessed,
        hits: result.hits,
        rate: Number(result.rate.toFixed(4)),
        cost: comparison(result.cost),
      })),
      // Null throughout when no engine ran, rather than absent: a reader
      // diffing two exports should see the same keys either way.
      engine:
        summary.ai === null
          ? null
          : {
              network: summary.ai.config.network,
              visits: summary.ai.config.visits,
              backend: summary.ai.config.backend,
              device: summary.ai.config.device,
              // What the engine failed to answer, so a run that lost its GPU
              // reads as a broken run rather than an unfinished one. `failures`
              // can exceed the list, which is capped (`INCIDENT_LIMIT`).
              failures: summary.ai.failures,
              incidents: summary.ai.incidents.map((incident: EngineIncident) => ({
                move: incident.move,
                reason: incident.reason,
                fatal: incident.fatal,
              })),
            },
      ai:
        summary.ai === null
          ? null
          : {
              graded: summary.ai.graded,
              answered: summary.ai.answered,
              medianLoss: Number(summary.ai.medianLoss.toFixed(2)),
              totalLoss: Number(summary.ai.totalLoss.toFixed(1)),
              beat: summary.ai.beat,
              blunders: summary.ai.blunders,
              misleading: summary.ai.misleading,
              misleadingHits: summary.ai.misleadingHits,
              against: comparison(summary.ai.against),
              runs: summary.ai.runs.map((run) => ({
                point: run.name,
                length: run.length,
                firstMove: run.firstMove,
                lastMove: run.lastMove,
                everGuessed: run.everGuessed,
              })),
            },
      moves: summary.rows.map((row) => ({
        move: row.moveNumber,
        phase: row.phase,
        guess: row.guess,
        actual: row.actual,
        hit: row.hit,
        playedAway: row.actualAway,
        youPlayedAway: row.guessAway,
        ms: row.elapsedMs,
        loss: row.loss === null ? null : Number(row.loss.toFixed(2)),
        playedLoss: row.playedLoss === null ? null : Number(row.playedLoss.toFixed(2)),
        beat: row.beat,
        misleading: row.misleading,
      })),
      /*
       * The verdicts themselves, not just the figures derived from them.
       *
       * Everything in `ai` above can be recomputed from this, which is what
       * makes a saved result a regression test for every engine number on the
       * summary screen rather than only for the ones that happened to be
       * exported. `dev.ts` reads it back and recomputes
       * (`docs/design-ai-scoring.md` §9.4).
       *
       * Points are names, as everywhere else in this export, so the file can be
       * read without a board in hand.
       */
      verdicts:
        summary.verdicts === null
          ? null
          : summary.verdicts.map((verdict) => exportVerdict(verdict, summary.board)),
      // Last, and much the largest field: the record itself, so the result is
      // self-contained. Everything a reader wants is above it.
      sgf: summary.sgf,
    },
    null,
    2,
  );
}

/** A plain-text form meant for pasting into notes. */
export function toText(summary: Summary): string {
  const { score: result } = summary;
  const lines: string[] = [
    `lituus — ${summary.game}`,
    `Played as ${colorName(summary.color)}`,
    '',
    `${result.hits} / ${result.guessed} matched (${percent(result.rate)})`,
  ];

  if (summary.abandoned) {
    lines.push(`Ended early: ${result.guessed} of ${result.total} moves predicted.`);
  }

  const { timing } = summary;
  if (timing) {
    lines.push(
      `Time: ${duration(timing.totalMs)} over ${timing.timed} moves, ` +
        `median ${duration(timing.medianMs)} ` +
        `(fastest ${duration(timing.fastestMs)}, slowest ${duration(timing.slowestMs)})`,
    );
  }

  const best: Streak | null = longestStreak(summary);
  if (best) {
    lines.push(
      `Longest run of matches: ${best.length} (moves ${best.firstMove}–${best.lastMove})`,
    );
  }

  lines.push('', 'By phase:');
  for (const phase of summary.phases) {
    const detail: string =
      phase.guessed > 0
        ? `${phase.hits} / ${phase.guessed} (${percent(phase.rate)})`
        : 'not reached';
    /*
     * The points clause is appended rather than substituted: the exact-match
     * rate stays the headline (PRD §5), and a text export is read where a bar
     * cannot be, so both numbers fit on the line.
     *
     * Both sides and then the edge between them, at two decimals: a phase
     * figure is tenths of a point and one decimal rounds a column of them to
     * zero. Means rather than medians, for the reason `perPrediction` gives.
     */
    const per = perPrediction(phase.cost);
    const cost: string =
      per === null || phase.cost === null
        ? ''
        : `you ${signed(per.yours, 2)}, game ${signed(per.played, 2)} per prediction ` +
          `(${signed(per.yours - per.played, 2)}, across ${phase.cost.moves})`;
    lines.push(`  ${phase.phase.padEnd(8)} ${detail.padEnd(18)}${cost}`.trimEnd());
  }

  const { tenuki } = summary;
  const { agreed, scored } = tenukiAgreement(tenuki);

  if (scored > 0) {
    lines.push('', `Local or away: agreed on ${agreed} of ${scored} (${percent(agreed / scored)})`);
    lines.push(`  they played away, so did you   ${tenuki.bothAway}`);
    if (tenuki.bothAway > 0) {
      lines.push(`    ...to the same area          ${tenuki.sameArea}`);
    }
    lines.push(`  they played away, you stayed   ${tenuki.stayedHome}`);
    lines.push(`  they answered, so did you      ${tenuki.bothLocal}`);
    lines.push(`  they answered, you left        ${tenuki.leftEarly}`);
  }

  const { ai } = summary;
  // Failures count as something to report: an engine that died before its first
  // verdict has nothing to say about the session and everything to say about
  // itself, and silence there reads as scoring having never been asked for.
  if (ai && (ai.answered > 0 || ai.failures > 0)) {
    lines.push('', `Engine: ${describeEngine(ai.config)}`);
    if (ai.graded > 0) {
      lines.push(
        `Your guesses vs the engine's best: ${signed(ai.totalLoss, 1)} across ` +
          `${ai.graded} of them, median ${signed(ai.medianLoss, 2)}`,
      );
    }
    if (ai.against !== null) {
      // Both averages, because they disagree in a way worth seeing: the mean
      // carries the swings, which are part of the game and part of the score,
      // and the median says what an ordinary move was worth.
      const { against } = ai;
      // Signed, like every figure a reader sees (design §6.1). Raw losses put
      // a minus on the side that did *better*, which is how "them -6.8 points"
      // came to mean the opposite of how it read.
      const mean = (total: number): string => signed(total / against.moves, 2);
      const total = (loss: number): string => signed(loss, 1).padStart(7);
      lines.push(
        `Vs the engine's best, across ${against.moves}:`,
        `  you   ${total(against.yourLoss)}, ` +
          `median ${signed(against.yourMedian, 2)}, mean ${mean(against.yourLoss)}`,
        `  them  ${total(against.playedLoss)}, ` +
          `median ${signed(against.playedMedian, 2)}, mean ${mean(against.playedLoss)}`,
        `  net   ${total(against.yourLoss - against.playedLoss)} to you`,
      );
    }
    if (ai.beat > 0) {
      // The most motivating thing the tool can say, so it gets its own line
      // rather than being folded into a table.
      lines.push(`Your guess beat the game's move ${ai.beat} times.`);
    }
    if (ai.blunders > 0) {
      lines.push(`Guesses that cost ${BLUNDER_LOSS} points or more: ${ai.blunders}`);
    }
    if (ai.misleading > 0) {
      lines.push(
        `Positions where the natural move was a trap: ${ai.misleading} ` +
          `(you found ${ai.misleadingHits})`,
      );
    }
    // Before the counts, not after: it changes what they mean.
    const trouble: string | null = failureNote(ai);
    if (trouble !== null) lines.push(trouble);
    if (ai.answered < summary.rows.length) {
      // Said plainly rather than omitted: a median over half the game is not
      // the same number as a median over the game.
      lines.push(`Analysed ${ai.answered} of ${summary.rows.length} predictions.`);
    }

    for (const run of ai.runs) {
      lines.push(
        `Neither of you played ${run.name} in ${run.length} straight chances ` +
          `(moves ${run.firstMove}–${run.lastMove})` +
          (run.everGuessed ? ' — though you found it at least once.' : '.'),
      );
    }
  }

  lines.push('', 'Moves:');
  for (const row of summary.rows) {
    const mark: string = row.hit ? 'hit ' : 'miss';
    const cost: string = row.loss === null ? '' : `  ${signed(row.loss).padStart(6)}`;
    const beat: string = row.beat ? '  beat the game' : '';
    lines.push(
      `  ${String(row.moveNumber).padStart(4)}  ${mark}  ${row.guess} / ${row.actual}${cost}${beat}`,
    );
  }

  return lines.join('\n');
}
