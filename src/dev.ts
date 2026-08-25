/**
 * Dev harness: render a summary screen from a result exported earlier.
 *
 * Reaching the summary the honest way means predicting a whole game, which is
 * a slow way to look at a change to the summary screen. This takes the JSON
 * from "Copy as JSON", rebuilds the session it came from, and shows the real
 * summary view — not a mock of it. The record travels inside the JSON, so one
 * pasted blob is enough.
 *
 * Two things follow from rebuilding a *session* rather than a Summary. The
 * numbers are recomputed by `summarize` rather than read back, so the screen
 * is exactly what a live session would produce; and the recomputed export can
 * be diffed against the pasted one, which turns a saved result into a
 * regression test for every number on the page.
 *
 * Dev-only. `main.ts` reaches this module solely under `import.meta.env.DEV`,
 * so the production build drops it. It is self-contained on purpose: deleting
 * this file and its two call sites removes the feature.
 */

import { pointFromName } from './goban.ts';
import { parse } from './sgf-parser.ts';
import { readGame, type Game, type GameMove } from './game.ts';
import { finalPosition, type Guess, type Session } from './session.ts';
import { summarize, toJSON, type Summary } from './summary.ts';
import { renderSummary } from './views.ts';
import { BLACK, WHITE, type Color } from './rules.ts';

/** Raised when the pasted text is not a result this can rebuild. */
export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreError';
  }
}

// ── Reading the export ───────────────────────────────────────────────────────

/*
 * Pasted text is arbitrary input, so every field is checked before it is used.
 * `unknown` is unavoidable here — JSON.parse is typed `any`, and taking the
 * result as `unknown` is what forces the narrowing below to happen at all.
 */

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RestoreError(`Expected ${what} to be an object.`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new RestoreError(`Expected ${what} to be a string.`);
  return value;
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RestoreError(`Expected ${what} to be a number.`);
  }
  return value;
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new RestoreError(`Expected ${what} to be an array.`);
  return value;
}

function asColor(value: unknown): Color {
  const name: string = asString(value, '"color"');
  if (name === 'Black') return BLACK;
  if (name === 'White') return WHITE;
  throw new RestoreError(`"color" should be "Black" or "White", not ${JSON.stringify(name)}.`);
}

/**
 * Rebuild one guess from its exported row.
 *
 * `hit` is recomputed from the two points rather than trusted. The exported
 * flag is then checked against it, because a disagreement means either the
 * export or this reader is wrong, and a dev harness that quietly papers over
 * that is worse than no harness.
 */
function restoreGuess(game: Game, color: Color, entry: unknown, at: number): Guess {
  const row: Record<string, unknown> = asRecord(entry, `moves[${at}]`);
  const moveNumber: number = asNumber(row.move, `moves[${at}].move`);
  const move: GameMove | undefined = game.moves[moveNumber - 1];

  if (!move || move.index === null) {
    throw new RestoreError(`The record has no move ${moveNumber} to predict.`);
  }
  if (move.color !== color) {
    throw new RestoreError(`Move ${moveNumber} does not belong to the color you played.`);
  }

  const name: string = asString(row.guess, `moves[${at}].guess`);
  const guess: number | null = pointFromName(game.initial, name);
  if (guess === null) {
    throw new RestoreError(`"${name}" is not a point on a ${game.cols}x${game.rows} board.`);
  }

  const hit: boolean = guess === move.index;
  if (typeof row.hit === 'boolean' && row.hit !== hit) {
    throw new RestoreError(
      `Move ${moveNumber} is exported as a ${row.hit ? 'hit' : 'miss'}, ` +
        `but replaying it gives a ${hit ? 'hit' : 'miss'}.`,
    );
  }

  // Absent in exports from before timing, and null is the honest answer for
  // those — not zero, which would read as an instant guess.
  const elapsedMs: number | null = typeof row.ms === 'number' ? row.ms : null;

  return { moveNumber, actual: move.index, guess, hit, elapsedMs };
}

/**
 * Rebuild the finished session an exported result came from.
 *
 * `cursor` is set past the end and the phase to `done`, which is the state
 * `endSession` would have left behind. Nothing downstream of a summary reads
 * further into a session than its guesses and its game.
 */
export function restoreSession(text: string): Session {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new RestoreError('That is not valid JSON. Paste the output of "Copy as JSON".');
  }

  const result: Record<string, unknown> = asRecord(parsed, 'the result');
  if (result.sgf === undefined) {
    throw new RestoreError(
      'This result has no "sgf" field, so there is no game to draw. ' +
        'It was probably exported by an older build.',
    );
  }

  const game: Game = readGame(parse(asString(result.sgf, '"sgf"')));
  const color: Color = asColor(result.color);
  const rows: unknown[] = asArray(result.moves, '"moves"');

  return {
    game,
    color,
    phase: 'done',
    position: finalPosition(game),
    move: null,
    lastGuess: null,
    guesses: rows.map((entry, at) => restoreGuess(game, color, entry, at)),
    cursor: game.moves.length,
  };
}

// ── Checking the export against a fresh one ──────────────────────────────────

/**
 * Array indices collapsed, so `moves[0].playedAway` and `moves[73].playedAway`
 * are recognized as the same field rather than as 100 separate findings.
 */
function generalize(path: string): string {
  return path.replace(/\[\d+\]/g, '[]');
}

/**
 * Every field where the pasted result and a freshly computed one disagree,
 * as `path: was X, now Y` lines.
 *
 * This is the part that makes a saved result worth keeping. Restoring proves
 * the screen renders; the diff proves the numbers behind it have not moved.
 *
 * A field the saved result simply does not carry is reported once by name
 * rather than once per occurrence. An export predating a new field is an old
 * file, not a hundred regressions, and letting it spell that out leaf by leaf
 * buries the one line that might be a real change.
 *
 * `sgf` is skipped throughout: it is the input, not a result, and a serializer
 * that reformats whitespace would drown out everything worth seeing.
 */
export function driftFrom(exported: string, summary: Summary): string[] {
  const changed: string[] = [];
  /** Computed now, absent from the saved result — it predates the field. */
  const added = new Set<string>();
  /** Present in the saved result and no longer computed at all. */
  const dropped = new Set<string>();

  let before: unknown;
  try {
    before = JSON.parse(exported) as unknown;
  } catch {
    return changed;
  }

  const compare = (was: unknown, now: unknown, path: string): void => {
    if (generalize(path) === 'sgf') return;

    // JSON has no undefined, so this only ever means a missing key.
    if (was === undefined && now !== undefined) {
      added.add(generalize(path));
      return;
    }
    if (now === undefined && was !== undefined) {
      dropped.add(generalize(path));
      return;
    }

    if (Array.isArray(was) && Array.isArray(now)) {
      if (was.length !== now.length) {
        changed.push(`${path}: was ${was.length} entries, now ${now.length}`);
        return;
      }
      was.forEach((item, i) => compare(item, now[i], `${path}[${i}]`));
      return;
    }

    const bothObjects: boolean =
      typeof was === 'object' && was !== null && typeof now === 'object' && now !== null;

    if (bothObjects) {
      const wasFields = was as Record<string, unknown>;
      const nowFields = now as Record<string, unknown>;
      for (const key of new Set([...Object.keys(wasFields), ...Object.keys(nowFields)])) {
        compare(wasFields[key], nowFields[key], path ? `${path}.${key}` : key);
      }
      return;
    }

    if (was !== now) {
      changed.push(`${path}: was ${JSON.stringify(was)}, now ${JSON.stringify(now)}`);
    }
  };

  compare(before, JSON.parse(toJSON(summary)) as unknown, '');

  const lines: string[] = [...changed];
  if (added.size > 0) {
    lines.push(`not in the saved result: ${[...added].sort().join(', ')}`);
  }
  if (dropped.size > 0) {
    lines.push(`in the saved result but no longer exported: ${[...dropped].sort().join(', ')}`);
  }
  return lines;
}

// ── The screen ───────────────────────────────────────────────────────────────

export interface DevProps {
  readonly onBack: () => void;
  /** Start a real session on a restored record — the summary view offers it. */
  readonly onReplay: (game: Game, color: Color) => void;
}

/** The URL fragment that opens this screen. */
export const DEV_HASH = '#dev';

function element(tag: string, className: string, text?: string): HTMLElement {
  const node: HTMLElement = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The drift report, or nothing when a fresh export matches the pasted one. */
function driftBanner(drift: readonly string[]): HTMLElement {
  if (drift.length === 0) {
    return element('p', 'note', 'Dev: rebuilt from a saved result. A fresh export matches it.');
  }

  const banner: HTMLElement = element('div', 'error');
  banner.append(
    element('p', '', `Dev: ${drift.length} difference(s) from the saved result.`),
    element('pre', 'drift', drift.join('\n')),
  );
  return banner;
}

/**
 * Render the dev screen: a box to paste a result into, and on success the real
 * summary view with a banner above it. Which of the two is showing is local
 * state, held here rather than in main.ts — no other screen can reach it, and
 * it should not outlive the page.
 */
export function renderDev(root: HTMLElement, props: DevProps, initial?: string): void {
  const showForm = (error?: string): void => {
    const area: HTMLTextAreaElement = document.createElement('textarea');
    area.className = 'sgf-input';
    area.rows = 12;
    area.spellcheck = false;
    area.placeholder = 'Paste the JSON from "Copy as JSON", or drop a .json file on the page.';

    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'primary';
    load.textContent = 'Render summary';
    load.addEventListener('click', () => accept(area.value));

    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = 'Back to lituus';
    back.addEventListener('click', props.onBack);

    const actions: HTMLElement = element('div', 'actions');
    actions.append(load, back);

    root.replaceChildren(
      element('h2', '', 'Dev: render a saved result'),
      element(
        'p',
        'muted',
        'Rebuilds the session the result came from and renders the real summary ' +
          'screen, then reports any field a fresh export no longer agrees on.',
      ),
      area,
      actions,
    );

    if (error) {
      const message: HTMLElement = element('p', 'error', error);
      message.setAttribute('role', 'alert');
      root.append(message);
    }
    area.focus();
  };

  const accept = (text: string): void => {
    if (text.trim() === '') {
      showForm('Paste a result first.');
      return;
    }

    let session: Session;
    let summary: Summary;
    try {
      session = restoreSession(text);
      summary = summarize(session);
    } catch (error: unknown) {
      const detail: string = error instanceof Error ? error.message : String(error);
      showForm(detail);
      return;
    }

    renderSummary(root, {
      summary,
      session,
      onReplay: (color: Color): void => props.onReplay(session.game, color),
      onRestart: () => showForm(),
    });
    root.prepend(driftBanner(driftFrom(text, summary)));
  };

  // A dropped file arrives as `initial` and skips the form entirely; anything
  // wrong with it lands back on the form with the reason.
  if (initial === undefined) showForm();
  else accept(initial);
}
