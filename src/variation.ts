/**
 * A principal variation, replayed to the position it ends in.
 *
 * The review board is a comparison — three candidates for one empty point —
 * and a line is a sequence, so only one line fits on a board at a time
 * (`docs/design-ai-scoring.md` §6.2). This is the core of the mode that shows
 * one: position plus line in, one position with numbered stones and a
 * footnote or two out. Nothing here draws or knows a screen; it walks ply by
 * ply because that is the only way a capture is noticed, and returns the end
 * position because that is the only version that can show one.
 *
 * The plies are played through `playRecorded`, the tolerant path SGF moves
 * take: KataGo's rules are not quite `rules.ts`'s on suicide and ko, and a
 * line that trips over the difference should lose its tail rather than throw.
 * Two refusals cannot be tolerated, because the board could not honestly draw
 * them — a point off the board and a point already occupied, which
 * `playRecorded` would silently overwrite — so the walk stops there. Suicide
 * and a ko retake are played out: replaying what the search read is more
 * faithful than truncating a line over a ruleset our own records already
 * disagree with.
 */

import { pointName } from './goban.ts';
import type { Marker } from './goban.ts';
import {
  EMPTY,
  moveError,
  playRecorded,
  stoneAt,
  type Color,
  type MoveError,
  type MoveResult,
  type Position,
} from './rules.ts';

/**
 * How many plies of a line are worth putting on a board today.
 *
 * Depth is bought with visits, and every line the app can currently reach was
 * searched at 50 of them (PRD §5): the recorded rows and the live engine share
 * one budget, so there is one answer rather than the recorded-versus-live split
 * §6.2 describes. Two or three plies is what that budget paid for, and the
 * tail of a fifteen-ply line from `search.ts` is simply where the search did
 * not go.
 *
 * This becomes a per-line question the moment a deeper search reaches the app
 * — the line's own visit counts against the same floor a point loss uses — and
 * not before.
 */
export const SHOWN_PLIES = 3;

/**
 * A ply the end position cannot name, and where it went.
 *
 * Two causes, one shape. Either a later ply took the same point — a snapback
 * or any recapture — and that ply's number is what the board shows there
 * (`at`), or the ply's stone was captured and nothing replaced it (`at` null).
 * Both are the printed diagram's problem and take its answer, a note under the
 * board.
 */
export interface Footnote {
  /** The ply that cannot be seen, numbered from the start of the line. */
  readonly ply: number;
  /** Where it was played. */
  readonly point: number;
  /** The ply now marked on that point, or null if the point ended empty. */
  readonly at: number | null;
}

export interface Variation {
  /** The position at the end of the line, with every ply played out. */
  readonly position: Position;
  /** One per ply still visible, labelled with its number from 1. */
  readonly markers: readonly Marker[];
  /** The plies the end position cannot name, in order. */
  readonly footnotes: readonly Footnote[];
  /** How many plies were played, which is the line's length unless it stopped. */
  readonly plies: number;
  /**
   * Why the walk ended before the line did, or null if it played out whole.
   * `pass` is a line running into a pass, which says nothing a reader can use.
   */
  readonly stopped: 'pass' | 'off-board' | 'occupied' | null;
}

/**
 * Replay `line` from `before`, with `first` to play.
 *
 * The line is numbered from 1 rather than continuing the record's numbering:
 * three-digit numbers inside every stone, to remove an ambiguity the caption
 * removes anyway. Depth is the caller's to decide — a recorded line is trusted
 * at the length it was recorded, a live one is cut by its own visit counts
 * (PRD §5) — so whatever arrives here is walked to its end.
 */
export function variationFrom(
  before: Position,
  line: readonly number[],
  first: Color,
): Variation {
  /** Which ply's stone stands on a point now. Line stones only, and only live ones. */
  const owner = new Map<number, number>();
  const played: { readonly ply: number; readonly point: number }[] = [];

  let position: Position = before;
  let stopped: Variation['stopped'] = null;

  for (const [index, point] of line.entries()) {
    const ply: number = index + 1;
    const color: Color = ply % 2 === 1 ? first : ((-first) as Color);

    // A pass is numbered past the last intersection. `MoveVerdict.pv` promises
    // it is already truncated at one, so this is a guard rather than a case.
    if (point >= position.rows * position.cols) {
      stopped = 'pass';
      break;
    }

    const refused: MoveError | null = moveError(position, point, color);
    if (refused === 'off-board' || refused === 'occupied') {
      stopped = refused;
      break;
    }

    const result: MoveResult = playRecorded(position, point, color);
    position = result.position;
    owner.set(point, ply);
    /*
     * Ownership is re-read from the board rather than tracked from the move's
     * captures: a suicide takes its own group off without reporting a capture
     * at all, and a marker for a stone that is not there is the one thing this
     * whole walk exists to avoid.
     */
    for (const [cell] of owner) if (stoneAt(position, cell) === EMPTY) owner.delete(cell);
    played.push({ ply, point });
  }

  const markers: Marker[] = [];
  const footnotes: Footnote[] = [];
  for (const { ply, point } of played) {
    if (owner.get(point) === ply) markers.push({ index: point, kind: 'line', label: String(ply) });
    else footnotes.push({ ply, point, at: owner.get(point) ?? null });
  }

  return { position, markers, footnotes, plies: played.length, stopped };
}

/**
 * The note under the board, or the empty string when the position says it all.
 *
 * "5 at 1" is the form Go books have used for a century, and it is written
 * with the same plain numerals the stones carry rather than the circled ones
 * of print: the footnote's whole job is to send the eye to a number on the
 * board, and a glyph the board does not use would send it looking for one that
 * is not there.
 *
 * Every note ends in its point's name, in parentheses and in the same slot
 * whichever kind it is. On paper that is redundant with the number it names —
 * but a note is about the one thing on this board with no mark to point at,
 * and naming the coordinate is what lets a reader find it without one. It is
 * also the hook a hover highlight needs later: one point per note, in a fixed
 * place, which `Footnote.point` carries for anything building spans rather
 * than a string.
 */
export function footnoteLine(variation: Variation): string {
  return variation.footnotes
    .map((note) => {
      const where = `(${pointName(variation.position, note.point)})`;
      return note.at === null
        ? `${note.ply} captured ${where}`
        : `${note.ply} at ${note.at} ${where}`;
    })
    .join(' · ');
}
