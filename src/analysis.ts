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

/** A new analysis with this verdict added, replacing any verdict for that move. */
export function withVerdict(analysis: Analysis, verdict: Verdict): Analysis {
  const verdicts = new Map(analysis.verdicts);
  verdicts.set(verdict.moveNumber, verdict);
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
