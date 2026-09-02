/**
 * Analysis: what an engine thought of the positions a session asked about.
 *
 * This module is the *record*, not the engine. It holds verdicts, says which of
 * them are worth believing, and knows what configuration produced them. It
 * imports nothing that needs a GPU, a worker, or a network, which is what lets
 * every figure built on top of it be unit-tested with no engine present.
 *
 * It is deliberately a value held *beside* a `Session` rather than inside one.
 * A session is immutable and its transitions are pure, so that replaying the
 * same guesses produces the same session — the same reasoning that keeps
 * `elapsedMs` measured by the caller instead of read from a clock inside
 * `guess()`. A verdict that arrives four seconds after the guess, or never,
 * would break that outright. The two are joined only when a summary is
 * computed. See `docs/design-ai-scoring.md` §3.
 */

import { pointName } from './goban.ts';
import type { Position } from './rules.ts';

/**
 * Which engine produced a set of verdicts.
 *
 * Carried because a score has to carry its engine: a hit rate is comparable
 * across sessions, and a point-loss figure is comparable only against the same
 * network at the same visit count. Any view putting two results side by side
 * must refuse to compare figures from different configurations
 * (`docs/prd-ai-scoring.md` §9).
 */
export interface EngineConfig {
  /** Network label, e.g. `b15c192`. */
  readonly network: string;
  /** Visits per search. */
  readonly visits: number;
  /** How it ran — `webgpu`, or `replay` for recorded verdicts. */
  readonly backend: string;
}

/**
 * Below this many visits a move's score lead is barely searched — at one visit
 * it is the raw network evaluation — so it arrives wearing the same confidence
 * as a properly read number while being worth much less.
 *
 * Not a guess. Measured during the rank survey's backfill: a one-visit estimate
 * was out by ten points on a position where moves with 50+ visits agreed with a
 * forced search to within 0.2. That is why the condition for asking the engine
 * again is "no verdict *worth having*" rather than "no verdict", and why
 * `visits` is carried on every move verdict rather than discarded once a number
 * exists.
 */
export const MIN_TRUSTED_VISITS = 10;

/** What the engine made of one specific move. */
export interface MoveVerdict {
  /** Board index of the move. */
  readonly point: number;
  /**
   * Points given up, as the root estimate minus this move's estimate.
   *
   * Computed across both queries when the move was forced, never inside the
   * restricted one: a search restricted to a single move treats that move as
   * the best available and reports no loss for it, however bad it is
   * (`docs/prd-ai-scoring.md` §5).
   *
   * Slightly negative values are ordinary search noise near zero, not a move
   * that beat perfect play.
   */
  readonly loss: number;
  /** Visits behind this estimate. Below `MIN_TRUSTED_VISITS` it is not worth quoting. */
  readonly visits: number;
  /** Whether the engine was made to look at this move rather than choosing to. */
  readonly forced: boolean;
  /**
   * How the search expects play to continue, as board indices.
   *
   * Truncated at a pass: a line running through one says nothing a reader can
   * use. The view truncates further still — two or three plies — because at 50
   * visits the tail of a variation is barely searched and showing it would
   * imply a confidence the search does not have.
   */
  readonly pv: readonly number[];
}

/**
 * The engine's own choice.
 *
 * Narrower than a `MoveVerdict` because it needs less and because the recorded
 * data does not carry more: its loss is zero by construction, and no consumer
 * asks how many visits the best move got. What it is for is the continuation
 * (`pv`), and being able to say that neither player found it — which is a
 * group-by over this point across a game (`docs/prd-ai-scoring.md` §6.4).
 */
export interface BestMove {
  readonly point: number;
  readonly scoreLead: number;
  readonly pv: readonly number[];
}

/**
 * The move the network proposed before any reading, and what reading made of it.
 *
 * This is the difficulty signal, and it is a property of the position rather
 * than of the player: where the most natural-looking move turns out to lose,
 * the position punishes intuition, and amateurs fall in. It predicts human
 * error strongly and asymmetrically — "looks obvious but is bad" predicts error
 * far better than "good but hard to find" (`docs/katago-feasibility.md` §8).
 *
 * Not to be confused with policy *concentration*, which measures the engine's
 * certainty and is not a difficulty measure at all.
 */
export interface NaturalMove {
  readonly point: number;
  /** The policy's prior on it, before search. */
  readonly prior: number;
  /** What it turned out to cost. A large value is a position that misleads. */
  readonly loss: number;
}

/** Everything one prompted position's searches produced. */
export interface Verdict {
  /** Move number in the record, matching `Guess.moveNumber`. */
  readonly moveNumber: number;
  /**
   * The unrestricted search's estimate of the position, before any move.
   *
   * Carried for provenance rather than for display. Every `loss` below is a
   * difference between two leads measured the same way, which makes losses
   * free of any perspective question; this figure is not, so prefer a loss
   * wherever one will do.
   */
  readonly rootScoreLead: number;
  readonly rootVisits: number;
  readonly best: BestMove;
  /**
   * The move the game actually played.
   *
   * Null when the engine produced no estimate worth having for it. Not a
   * failure — the position still carries a best move and a difficulty signal,
   * and those are what §6.4 and the difficulty breakdown are built from.
   */
  readonly played: MoveVerdict | null;
  /**
   * The user's guess. Equal to `played` on a hit, rather than null — a hit is
   * still a move the engine has an opinion about, and consumers should not have
   * to special-case it.
   *
   * Null only when no evaluation could be produced at all.
   */
  readonly guessed: MoveVerdict | null;
  /** The difficulty signal, where the engine reported one. */
  readonly natural: NaturalMove | null;
}

/**
 * Verdicts for one session, keyed by move number.
 *
 * Keyed by *position*, not by guess. A replay of the same game and colour asks
 * about the same positions, so the expensive root searches are reused and only
 * a changed guess costs anything — which is what makes PRD §5's "Same again"
 * nearly free.
 */
export interface Analysis {
  readonly config: EngineConfig;
  readonly verdicts: ReadonlyMap<number, Verdict>;
}

export function emptyAnalysis(config: EngineConfig): Analysis {
  return { config, verdicts: new Map() };
}

/**
 * Points, at the precision this product is willing to claim.
 *
 * A loss is the difference between two fifty-visit estimates. Two decimals is
 * already past what that supports, and the extra digits are not free: they sit
 * either side of every threshold in this file. A difference of 0.500001 against
 * `BEAT_MARGIN` decides whether the summary tells someone they beat the game,
 * and whether it still says so after the result has been exported and read back
 * depends on how the file was rounded. Fixing the precision here, at the one
 * door into the store, makes a stored verdict and a restored one the same
 * value — so the thresholds cannot disagree with themselves.
 */
const LOSS_DECIMALS = 2;

function roundLoss(loss: number): number {
  return Number(loss.toFixed(LOSS_DECIMALS));
}

function normalizeMove(verdict: MoveVerdict | null): MoveVerdict | null {
  return verdict === null ? null : { ...verdict, loss: roundLoss(verdict.loss) };
}

/**
 * A new analysis with this verdict added, replacing any verdict for that move.
 *
 * Losses are normalized on the way in, so every evaluator — recorded, in
 * browser, or anything later — stores the same value for the same search, and
 * nothing downstream has to remember to round.
 */
export function withVerdict(analysis: Analysis, verdict: Verdict): Analysis {
  const verdicts = new Map(analysis.verdicts);
  verdicts.set(verdict.moveNumber, {
    ...verdict,
    played: normalizeMove(verdict.played),
    guessed: normalizeMove(verdict.guessed),
    natural:
      verdict.natural === null
        ? null
        : { ...verdict.natural, loss: roundLoss(verdict.natural.loss) },
  });
  return { config: analysis.config, verdicts };
}

export function verdictFor(analysis: Analysis, moveNumber: number): Verdict | null {
  return analysis.verdicts.get(moveNumber) ?? null;
}

export function verdictCount(analysis: Analysis): number {
  return analysis.verdicts.size;
}

/** Whether a number from this move verdict is worth showing a user. */
export function isTrusted(verdict: MoveVerdict): boolean {
  return verdict.visits >= MIN_TRUSTED_VISITS;
}

/**
 * Whether two sets of verdicts may have their point losses compared.
 *
 * The desktop/mobile split is the case this exists for: the same user studying
 * the same game, on two devices, gets numbers that must not be put side by side.
 */
export function sameEngine(a: EngineConfig, b: EngineConfig): boolean {
  return a.network === b.network && a.visits === b.visits;
}

/** A configuration as one short string, for an export or a footnote. */
export function describeEngine(config: EngineConfig): string {
  return `${config.network} @ ${config.visits} visits (${config.backend})`;
}

// ── Derived statistics ───────────────────────────────────────────────────────
//
// Everything below is a pure function of verdicts plus the game they belong to.
// None of it needs an engine, a session, or a DOM, which is what lets the whole
// AI half of the summary be tested from hand-built verdicts.

/**
 * How much better a guess must be than the played move before we say so.
 *
 * Differences below roughly half a point are search noise, and "you beat the
 * professional" is a claim worth being sure of — it is the single most
 * motivating thing the tool can say, which is exactly why it must not be said
 * on a rounding error (`docs/prd-ai-scoring.md` §5).
 */
export const BEAT_MARGIN = 0.5;

/**
 * Points at or above which a move is a blunder.
 *
 * Eight, matching the threshold every accuracy figure in
 * `docs/katago-feasibility.md` §5 was measured against. Moving it would not
 * merely change a label — it would detach the word from the recall and
 * precision numbers that justify using it at all.
 */
export const BLUNDER_LOSS = 8;

/**
 * Points the most natural-looking move must cost before a position counts as
 * one that misleads.
 *
 * Three, the bucket measured in `docs/katago-feasibility.md` §8: restricted to
 * these positions, human blunder rates rose from 3.6% to 44%. The lift over
 * baseline holds at 3-7x across every rank band, which is why one threshold
 * survives — but what it *means* varies, from about three times in four for a
 * 5k to under three in ten for a 7d, so the confidence attached to it belongs
 * in the copy rather than in this number (`docs/prd-ai-scoring.md` §8b).
 */
export const MISLEADING_LOSS = 3;

/** A move verdict's loss, or null when there is nothing worth quoting. */
export function lossOf(verdict: MoveVerdict | null | undefined): number | null {
  if (!verdict || !isTrusted(verdict)) return null;
  return verdict.loss;
}

/**
 * Whether the guess was better than the move actually played.
 *
 * Both sides have to be trusted. Comparing a properly searched guess against a
 * one-visit estimate of the played move would manufacture these.
 */
export function beatPlayed(verdict: Verdict): boolean {
  const guess: number | null = lossOf(verdict.guessed);
  const played: number | null = lossOf(verdict.played);
  if (guess === null || played === null) return false;
  return played - guess > BEAT_MARGIN;
}

/**
 * Whether this position punishes intuition — the difficulty signal.
 *
 * A property of the position, computed from the engine's own policy without
 * reference to what anybody played, which is what keeps it from being circular.
 */
export function isMisleading(verdict: Verdict): boolean {
  return verdict.natural !== null && verdict.natural.loss >= MISLEADING_LOSS;
}

/**
 * A stretch of consecutive prompts where the engine kept naming the same best
 * move and neither player ever played it.
 *
 * Reported once rather than as thirty separate verdicts that all say the same
 * thing. "Neither of you played Q4 in 26 straight chances" is a sentence a
 * reader can act on; thirty large point losses with one cause is not
 * (`docs/prd-ai-scoring.md` §6.4).
 */
export interface MissedRun {
  /** The move both of you kept not playing, as a board index — the view draws it. */
  readonly point: number;
  /** The same point named, e.g. "Q4", so the exports need no board to read it. */
  readonly name: string;
  /** Consecutive prompts it went unplayed. */
  readonly length: number;
  readonly firstMove: number;
  readonly lastMove: number;
  /** Whether the user ever guessed it during the run. */
  readonly everGuessed: boolean;
}

/**
 * Shortest run worth naming.
 *
 * Calibrated, not guessed. Run lengths across the six dogfood games — 252 runs
 * in all — fall off sharply:
 *
 *     length  1    2   3  4  5  6  7  8  11  23
 *     count   198  32  7  5  2  2  3  1   1   1
 *
 * Almost everything is one or two prompts long, which is just the engine
 * changing its mind; four is where the tail begins. Three would add seven more
 * runs and no more meaning.
 *
 * It also reproduces the effect §6.4 predicts: the longest run per game falls
 * with playing strength — 23 prompts against a 6k, 5 against a 4d, 2 against a
 * 7d — so this fires hardest for the players it helps most. Like
 * `TENUKI_RADIUS`, six games is enough to place the threshold and not enough to
 * settle it.
 */
export const MISSED_RUN_MIN = 4;

/**
 * Find the runs, over the prompts of one session, in move order.
 *
 * Runs are per colour by construction here: a session prompts one colour, so
 * every verdict in the store belongs to the same player. That is the property
 * §6.4 insists on — the two players miss different moves, sometimes in
 * overlapping stretches, and pooling them finds neither.
 */
export function missedRuns(
  analysis: Analysis,
  prompts: readonly {
    readonly moveNumber: number;
    readonly actual: number | null;
    readonly guess: number | null;
  }[],
  board: Position,
): MissedRun[] {
  const area: number = board.rows * board.cols;
  const runs: MissedRun[] = [];
  let point: number | null = null;
  let start = 0;
  let guessedInRun = false;

  const close = (end: number): void => {
    const length: number = end - start;
    if (point !== null && length >= MISSED_RUN_MIN) {
      runs.push({
        point,
        name: pointName(board, point),
        length,
        firstMove: prompts[start].moveNumber,
        lastMove: prompts[end - 1].moveNumber,
        everGuessed: guessedInRun,
      });
    }
  };

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    const verdict: Verdict | null = verdictFor(analysis, prompt.moveNumber);
    // A prompt with no verdict breaks the run rather than being skipped over.
    // Bridging a gap would claim the engine kept naming a move across positions
    // where nothing asked it.
    /*
     * A best move that is a pass cannot start a run. The engine numbers one
     * past the last intersection, so it would be reported under `pointName`'s
     * name for it — a run called "pass", which names no point to go and look
     * at, and which is not the lesson this is built to find.
     */
    const bestPoint: number | undefined = verdict?.best.point;
    const best: number | null =
      bestPoint !== undefined && bestPoint < area ? bestPoint : null;
    const unplayed: boolean = best !== null && prompt.actual !== best;

    if (unplayed && best === point) {
      guessedInRun ||= prompt.guess === best;
      continue;
    }

    close(i);
    if (unplayed) {
      point = best;
      start = i;
      guessedInRun = prompt.guess === best;
    } else {
      point = null;
      start = i + 1;
      guessedInRun = false;
    }
  }
  close(prompts.length);

  return runs;
}

/** What the engine made of a session, in aggregate. */
export interface AiResult {
  readonly config: EngineConfig;
  /** Predictions with a point loss worth quoting. */
  readonly graded: number;
  /** Prompts asked about, whether or not a number came back. */
  readonly answered: number;
  /**
   * Median points given up per guess.
   *
   * The median rather than the mean, for the same reason the existing summary
   * reports a median time: one catastrophe should not swallow the figure.
   */
  readonly medianLoss: number;
  /** Total points given up, the quantity a player recognizes from AI review. */
  readonly totalLoss: number;
  /** Guesses that beat the move actually played, by more than the noise floor. */
  readonly beat: number;
  /** Guesses at or past the blunder threshold. */
  readonly blunders: number;
  /** Positions where the most natural-looking move was a trap. */
  readonly misleading: number;
  /** Of those, how many the user got right. */
  readonly misleadingHits: number;
  /** Stretches where neither of you played the engine's move. */
  readonly runs: readonly MissedRun[];
  /**
   * How the session compared with the moves actually played. Null when no
   * prompt has both sides quotable, which is the only case where the
   * comparison would have to be invented.
   */
  readonly against: Comparison | null;
}

/**
 * Your predictions against the moves the game played, over the prompts where
 * both have a quotable loss.
 *
 * The same insistence `costDelta` makes, for the same reason: comparing a
 * searched guess with an unsearched played move manufactures a verdict out of
 * the engine's silence. So this carries its own `moves` count rather than
 * borrowing `graded`, and both totals are over that one set.
 *
 * Both the totals and the medians, because they answer different questions and
 * a reader deserves both. The totals are the game's own currency and the more
 * motivating number — a session is ahead or behind by so many points — but
 * they are volatile: across the two scored dogfood games, five moves out of a
 * hundred supply 42% and 59% of the difference. The medians say what a typical
 * move was worth and barely move when one dragon dies. The median of the
 * *difference* is not offered, since it is 0.00 by construction: an exact
 * match's difference is exactly zero and the even band is `BEAT_MARGIN` wide,
 * so the middle of the distribution is always a tie.
 */
export interface Comparison {
  /** Prompts where both sides could be quoted. */
  readonly moves: number;
  /** Points your predictions gave up over those moves. */
  readonly yourLoss: number;
  /** Points the moves actually played gave up over the same moves. */
  readonly playedLoss: number;
  readonly yourMedian: number;
  readonly playedMedian: number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted: number[] = [...values].sort((a, b) => a - b);
  const middle: number = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Aggregate a session's verdicts.
 *
 * `prompts` is the session's guesses in move order — everything this needs to
 * know about the session, passed in rather than imported, so that this module
 * stays independent of the session layer.
 */
export function aiResult(
  analysis: Analysis,
  prompts: readonly {
    readonly moveNumber: number;
    readonly actual: number | null;
    readonly guess: number | null;
    readonly hit: boolean;
  }[],
  board: Position,
): AiResult {
  const losses: number[] = [];
  // The compared pair, gathered side by side so the two sums and the two
  // medians are always over the same set of moves.
  const yours: number[] = [];
  const played: number[] = [];
  let answered = 0;
  let beat = 0;
  let blunders = 0;
  let misleading = 0;
  let misleadingHits = 0;

  for (const prompt of prompts) {
    const verdict: Verdict | null = verdictFor(analysis, prompt.moveNumber);
    if (!verdict) continue;
    answered++;

    const loss: number | null = lossOf(verdict.guessed);
    if (loss !== null) {
      losses.push(loss);
      if (loss >= BLUNDER_LOSS) blunders++;
    }
    const playedLoss: number | null = lossOf(verdict.played);
    if (loss !== null && playedLoss !== null) {
      yours.push(loss);
      played.push(playedLoss);
    }

    if (beatPlayed(verdict)) beat++;
    if (isMisleading(verdict)) {
      misleading++;
      if (prompt.hit) misleadingHits++;
    }
  }

  return {
    config: analysis.config,
    graded: losses.length,
    answered,
    medianLoss: median(losses),
    // Negative losses are search noise around zero, not points won back, so
    // they are kept in the sum rather than clamped: clamping would bias the
    // total upward by exactly the noise it was trying to hide.
    totalLoss: losses.reduce((sum, loss) => sum + loss, 0),
    beat,
    blunders,
    misleading,
    misleadingHits,
    runs: missedRuns(analysis, prompts, board),
    against:
      yours.length === 0
        ? null
        : {
            moves: yours.length,
            yourLoss: yours.reduce((sum, loss) => sum + loss, 0),
            playedLoss: played.reduce((sum, loss) => sum + loss, 0),
            yourMedian: median(yours),
            playedMedian: median(played),
          },
  };
}
