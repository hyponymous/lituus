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
import { BLACK, type Color, type Position } from './rules.ts';

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

export interface SummaryRow {
  readonly moveNumber: number;
  readonly phase: Phase;
  /** Coordinates, e.g. "Q16". */
  readonly guess: string;
  readonly actual: string;
  readonly hit: boolean;
}

export interface Summary {
  readonly game: string;
  readonly color: Color;
  readonly score: Score;
  readonly phases: readonly PhaseResult[];
  readonly rows: readonly SummaryRow[];
  /** True when the user stopped before the record ran out. */
  readonly abandoned: boolean;
}

function rateOf(hits: number, guessed: number): number {
  return guessed > 0 ? hits / guessed : 0;
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

  const rows: SummaryRow[] = session.guesses.map((made: Guess) => ({
    moveNumber: made.moveNumber,
    phase: phaseOf(game, made.moveNumber),
    guess: pointName(board, made.guess),
    actual: pointName(board, made.actual),
    hit: made.hit,
  }));

  return {
    game: describe(game),
    color,
    score: score(session),
    phases: phaseResults(game, rows),
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

  lines.push('', 'Moves:');
  for (const row of summary.rows) {
    const mark: string = row.hit ? 'hit ' : 'miss';
    lines.push(`  ${String(row.moveNumber).padStart(4)}  ${mark}  ${row.guess} / ${row.actual}`);
  }

  return lines.join('\n');
}
