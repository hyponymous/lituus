/**
 * The evaluator interface, and the queue that drains it.
 *
 * An evaluator is asked about one prompted position and answers with a
 * `Verdict`. That is the whole contract, and it is deliberately narrow: a local
 * in-browser engine, a file of recorded verdicts, and a remote endpoint are
 * three implementations of it, and nothing above this line can tell which it
 * has (`docs/katago-feasibility.md` §1).
 *
 * What is *not* in the interface is as important as what is. Callers do not say
 * how many searches to run, or whether the guess needs forcing with a
 * restricted query: that is the engine's decision, made from what its own
 * search visited, and hoisting it up here would put a policy that depends on
 * visit counts in a module that cannot see them.
 *
 * Nothing here imports an engine. The queue is exercised in tests against a
 * hand-written evaluator, which is the point of the split.
 */

import type { EngineConfig, Verdict } from './analysis.ts';
import type { Color, Position } from './rules.ts';

/** One position to have an opinion about. */
export interface Prompt {
  /** Move number in the record, which is also the verdict's key. */
  readonly moveNumber: number;
  /** The position as the guesser saw it — `GameMove.before`. */
  readonly position: Position;
  /** Whose turn it is. */
  readonly color: Color;
  /** Where the game actually played, as a board index, or null for a pass. */
  readonly played: number | null;
  /**
   * Where the user guessed, or null for a pass. Equal to `played` on a hit.
   *
   * A pass is `null` here, as it is everywhere above the engine line; the
   * engine numbers one past the last intersection, and `evaluate.ts` is where
   * the two meet.
   */
  readonly guess: number | null;
}

export interface Evaluator {
  readonly config: EngineConfig;
  evaluate(prompt: Prompt): Promise<Verdict>;
}

/** Raised when an evaluator cannot answer about a prompt it was given. */
export class EvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationError';
  }
}

export interface QueueHandlers {
  readonly onVerdict: (verdict: Verdict) => void;
  /**
   * A prompt that could not be evaluated. Optional because a failure is not
   * fatal: the session continues and the summary reports what it has, which is
   * the same degradation a failed download produces.
   */
  readonly onError?: (prompt: Prompt, error: unknown) => void;
}

export interface Queue {
  /** Ask about a position. Ignored if that move has already been submitted. */
  readonly submit: (prompt: Prompt) => void;
  /** How many prompts are waiting or in flight. */
  readonly pending: () => number;
  /**
   * The move being evaluated right now, or null between searches.
   *
   * Exposed so that a failure arriving on the engine rather than on a prompt —
   * a lost device — can still be recorded against a position in the game.
   */
  readonly current: () => number | null;
  /** Stop after the search in flight. Nothing further is started or reported. */
  readonly stop: () => void;
}

/**
 * A queue that runs one evaluation at a time, in submission order.
 *
 * One at a time on purpose. Half a second per prompt against a user thinking
 * for tens of seconds drains continuously, and a single search keeps the GPU
 * work predictable — the mobile ceiling is a memory high-water mark, and
 * running searches concurrently is the fastest way to find it
 * (`docs/katago-feasibility.md` §7).
 *
 * It never blocks anything. The reveal is driven by `session`, which has no
 * reference to an evaluator, so there is no code path by which a slow search
 * can delay one.
 */
export function createQueue(evaluator: Evaluator, handlers: QueueHandlers): Queue {
  const waiting: Prompt[] = [];
  // Every move number ever submitted, not just those still waiting. A prompt
  // whose verdict has already landed must not be re-run when a replay of the
  // same game and colour asks about the same position again.
  const seen = new Set<number>();
  let running = false;
  let stopped = false;
  let inFlight: number | null = null;

  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    while (!stopped) {
      const prompt: Prompt | undefined = waiting.shift();
      if (!prompt) break;
      inFlight = prompt.moveNumber;
      try {
        const verdict: Verdict = await evaluator.evaluate(prompt);
        if (!stopped) handlers.onVerdict(verdict);
      } catch (error: unknown) {
        // The move stays in `seen`. A failure that is going to repeat should
        // not be retried behind every later prompt in the session.
        if (!stopped) handlers.onError?.(prompt, error);
      } finally {
        inFlight = null;
      }
    }
    running = false;
  }

  return {
    submit: (prompt: Prompt): void => {
      if (stopped || seen.has(prompt.moveNumber)) return;
      seen.add(prompt.moveNumber);
      waiting.push(prompt);
      void drain();
    },
    pending: (): number => waiting.length + (running ? 1 : 0),
    current: (): number | null => inFlight,
    stop: (): void => {
      stopped = true;
      waiting.length = 0;
    },
  };
}
