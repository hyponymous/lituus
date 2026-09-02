/**
 * Session: the prediction loop over one game, for one color.
 *
 * A session is an immutable value and every transition returns a new one, so
 * the views can render from a single object and never hold stale derived
 * state. Navigation is strictly forward by construction: the cursor only
 * increases, and no transition reveals a move that has already been scored.
 *
 * The opponent's moves need no playing out here. The game model already
 * carries the position before every move, so the position before the user's
 * next prompt is the position with all intervening moves applied.
 */

import { promptableMoves, type Game, type GameMove } from './game.ts';
import { isLegal, type Color, type Position } from './rules.ts';

/**
 * `prompt` — waiting for a guess. `reveal` — the answer is showing, waiting to
 * advance. `done` — the game ran out, or the user ended the session.
 */
export type Phase = 'prompt' | 'reveal' | 'done';

export interface Guess {
  /** Move number in the game record, 1-based, as shown to the user. */
  readonly moveNumber: number;
  /** Where the move was actually played, or null if the game passed. */
  readonly actual: number | null;
  /** Where the user guessed, or null if the user passed. */
  readonly guess: number | null;
  readonly hit: boolean;
  /**
   * How long the prompt was on screen before the click, in milliseconds, or
   * null when nothing measured it — a test, or a session restored from an
   * export that predates timing.
   *
   * Measured by the caller rather than here. A session is a value and every
   * transition is pure; reading a clock inside one would make replaying the
   * same guesses produce different sessions.
   */
  readonly elapsedMs: number | null;
}

export interface Session {
  readonly game: Game;
  readonly color: Color;
  readonly phase: Phase;
  /** The position to display: before the move in `prompt`, after it in `reveal`. */
  readonly position: Position;
  /** The move being predicted, or just revealed. Null once done. */
  readonly move: GameMove | null;
  /** The guess just made, for the reveal. Null in any other phase. */
  readonly lastGuess: Guess | null;
  readonly guesses: readonly Guess[];
  /** Index into `game.moves` of `move`, or the record's length once done. */
  readonly cursor: number;
}

/** Raised when a transition is asked for that the current phase does not allow. */
export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

/** The next move of this color that can be predicted. Passes are prompts too. */
function nextPrompt(game: Game, color: Color, from: number): number {
  for (let i = from; i < game.moves.length; i++) {
    if (game.moves[i].color === color) return i;
  }
  return game.moves.length;
}

/** The position once the record is exhausted: the board as the game left it. */
export function finalPosition(game: Game): Position {
  return game.moves.at(-1)?.after ?? game.initial;
}

/** Settle a session onto the prompt at `cursor`, or onto `done` if there is none. */
function at(session: Omit<Session, 'phase' | 'position' | 'move' | 'lastGuess'>): Session {
  const { game, cursor } = session;
  const move: GameMove | undefined = game.moves[cursor];

  return move
    ? { ...session, phase: 'prompt', position: move.before, move, lastGuess: null }
    : { ...session, phase: 'done', position: finalPosition(game), move: null, lastGuess: null };
}

/**
 * Begin a session. Starts at the first move of `color` worth predicting, which
 * in a handicap game is the first move after the placed stones.
 */
export function startSession(game: Game, color: Color): Session {
  return at({
    game,
    color,
    guesses: [],
    cursor: nextPrompt(game, color, 0),
  });
}

/**
 * The move whose stone is the newest on the board right now — the opponent's
 * reply while a prompt waits, the revealed move during a reveal. Null before
 * anything has been played.
 */
export function lastPlayed(session: Session): GameMove | null {
  const at: number = session.phase === 'reveal' ? session.cursor : session.cursor - 1;
  return session.game.moves[at] ?? null;
}

/** Whether the user may click this point — the reveal must not be pre-empted. */
export function canGuess(session: Session, index: number): boolean {
  return session.phase === 'prompt' && isLegal(session.position, index, session.color);
}

/** Settle a committed answer into the reveal. The one place a guess is scored. */
function reveal(session: Session, move: GameMove, made: Guess): Session {
  return {
    ...session,
    phase: 'reveal',
    position: move.after,
    lastGuess: made,
    guesses: [...session.guesses, made],
  };
}

/** The move under the prompt, or a `SessionError` naming why there is none. */
function prompted(session: Session): GameMove {
  if (session.phase !== 'prompt' || !session.move) {
    throw new SessionError(`Cannot guess while ${session.phase}.`);
  }
  return session.move;
}

/**
 * Commit a guess and reveal the answer. There is no confirmation step: the
 * click is the answer, and it is scored on exact match against the played move.
 *
 * `elapsedMs` is how long the user had the prompt in front of them. It is
 * passed in because only the caller drawing the screen knows when the prompt
 * appeared, and because a pure transition cannot read a clock.
 */
export function guess(session: Session, index: number, elapsedMs: number | null = null): Session {
  const move: GameMove = prompted(session);
  if (!canGuess(session, index)) {
    throw new SessionError('That point is not a legal move.');
  }

  return reveal(session, move, {
    moveNumber: move.number,
    actual: move.index,
    // A point is never a pass, so a prompt the game passed is a miss here.
    guess: index,
    hit: index === move.index,
    elapsedMs,
  });
}

/**
 * Predict a pass. The board offers no point to click for it, so this is the
 * one answer that arrives from a control rather than from the goban.
 *
 * It is a guess and not a way out: it is recorded, it counts against the rate
 * like any other, and it is a hit only where the game passed too. Under PRD
 * §4.5 a session is one honest pass through the game, and a free skip would
 * let the rate be taken over moves the user chose to answer.
 */
export function passGuess(session: Session, elapsedMs: number | null = null): Session {
  const move: GameMove = prompted(session);

  return reveal(session, move, {
    moveNumber: move.number,
    actual: move.index,
    guess: null,
    hit: move.index === null,
    elapsedMs,
  });
}

/** Move past the revealed answer to the next prompt, or to the end of the game. */
export function advance(session: Session): Session {
  if (session.phase !== 'reveal') {
    throw new SessionError(`Cannot advance while ${session.phase}.`);
  }
  return at({
    game: session.game,
    color: session.color,
    guesses: session.guesses,
    cursor: nextPrompt(session.game, session.color, session.cursor + 1),
  });
}

/**
 * End the session early. The guesses made so far stand — the user abandoned
 * the game, they did not get those moves wrong.
 */
export function endSession(session: Session): Session {
  return {
    ...session,
    phase: 'done',
    position: session.position,
    move: null,
    lastGuess: null,
  };
}

export interface Score {
  readonly hits: number;
  readonly guessed: number;
  /** Prompts in the whole game, so a session ended early reads as incomplete. */
  readonly total: number;
  /** Hits over guesses made, in [0, 1]. Zero when nothing has been guessed. */
  readonly rate: number;
}

export function score(session: Session): Score {
  const hits: number = session.guesses.filter((made) => made.hit).length;
  const guessed: number = session.guesses.length;

  return {
    hits,
    guessed,
    total: countPrompts(session.game, session.color),
    rate: guessed > 0 ? hits / guessed : 0,
  };
}

/** How many moves a session for this color will ask about, all told. */
export function countPrompts(game: Game, color: Color): number {
  return promptableMoves(game, color).length;
}
