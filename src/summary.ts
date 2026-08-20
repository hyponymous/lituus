/**
 * Session summary: what the user gets at the end of a run.
 *
 * Pure. Takes a finished (or abandoned) session and produces a plain data
 * structure plus its two export forms. Kept out of the views so the numbers
 * can be tested without a DOM, since a hit rate that is quietly wrong looks
 * exactly like a hit rate that is right.
 */

import { pointName } from './goban.ts';
import { describe, type Game } from './game.ts';
import { countPrompts, score, type Guess, type Score, type Session } from './session.ts';
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
}

/**
 * How far a move can sit from the opponent's last one and still count as an
 * answer to it, measured as a Chebyshev distance so a diagonal counts the same
 * as a straight line.
 */
const TENUKI_RADIUS = 6;

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

export interface Summary {
  readonly game: string;
  readonly color: Color;
  readonly score: Score;
  readonly phases: readonly PhaseResult[];
  readonly tenuki: Tenuki;
  readonly rows: readonly SummaryRow[];
  /** True when the user stopped before the record ran out. */
  readonly abandoned: boolean;
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
    if (from === null) {
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

function phaseResults(game: Game, rows: readonly SummaryRow[]): PhaseResult[] {
  return PHASES.map((phase) => {
    const inPhase: readonly SummaryRow[] = rows.filter((row) => row.phase === phase);
    const hits: number = inPhase.filter((row) => row.hit).length;
    return { phase, guessed: inPhase.length, hits, rate: rateOf(hits, inPhase.length) };
  });
}

export function summarize(session: Session): Summary {
  const { game, color } = session;
  // Any position serves for naming points; they all share the board's shape.
  const board: Position = game.initial;

  const rows: SummaryRow[] = session.guesses.map((made: Guess) => {
    const from: number | null = referencePoint(game, made.moveNumber);
    return {
      moveNumber: made.moveNumber,
      phase: phaseOf(game, made.moveNumber),
      guess: pointName(board, made.guess),
      actual: pointName(board, made.actual),
      hit: made.hit,
      actualAway: from === null ? null : isAway(board, from, made.actual),
      guessAway: from === null ? null : isAway(board, from, made.guess),
    };
  });

  return {
    game: describe(game),
    color,
    score: score(session),
    phases: phaseResults(game, rows),
    tenuki: tenukiResult(board, game, session.guesses),
    rows,
    abandoned: session.guesses.length < countPrompts(game, color),
  };
}

function colorName(color: Color): string {
  return color === BLACK ? 'Black' : 'White';
}

/** A percentage for display. Rounded to whole numbers; nobody needs decimals. */
export function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
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
      phases: summary.phases.map((result) => ({
        phase: result.phase,
        predicted: result.guessed,
        hits: result.hits,
        rate: Number(result.rate.toFixed(4)),
      })),
      moves: summary.rows.map((row) => ({
        move: row.moveNumber,
        phase: row.phase,
        guess: row.guess,
        actual: row.actual,
        hit: row.hit,
        playedAway: row.actualAway,
        youPlayedAway: row.guessAway,
      })),
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
    `${result.hits} / ${result.guessed} correct (${percent(result.rate)})`,
  ];

  if (summary.abandoned) {
    lines.push(`Ended early: ${result.guessed} of ${result.total} moves predicted.`);
  }

  lines.push('', 'By phase:');
  for (const phase of summary.phases) {
    const detail: string =
      phase.guessed > 0
        ? `${phase.hits} / ${phase.guessed} (${percent(phase.rate)})`
        : 'not reached';
    lines.push(`  ${phase.phase.padEnd(8)} ${detail}`);
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

  lines.push('', 'Moves:');
  for (const row of summary.rows) {
    const mark: string = row.hit ? 'hit ' : 'miss';
    lines.push(`  ${String(row.moveNumber).padStart(4)}  ${mark}  ${row.guess} / ${row.actual}`);
  }

  return lines.join('\n');
}
