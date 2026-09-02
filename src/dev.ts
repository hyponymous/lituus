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
 * It also *scores* what the result cannot. Any prediction with no verdict is
 * put to the real engine and the summary fills in as the searches land, which
 * is what makes the dogfood exports — played before there was an in-browser
 * engine, their numbers joined to KataGo offline — worth looking at on a
 * screen. See `beginScoring`.
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
import { refreshSummaryAnalysis, renderSummary } from './views.ts';
import { BLACK, WHITE, type Color, type Position } from './rules.ts';
import {
  emptyAnalysis,
  sameEngine,
  verdictFor,
  withVerdict,
  type Analysis,
  type MoveVerdict,
  type NaturalMove,
  type Verdict,
} from './analysis.ts';
import {
  engineConfig,
  startEngine,
  unscorableReason,
  type EngineHandle,
  type EngineStatus,
} from './engine-client.ts';
import { createQueue, type Prompt, type Queue } from './evaluator.ts';

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

  if (!move) {
    throw new RestoreError(`The record has no move ${moveNumber} to predict.`);
  }
  if (move.color !== color) {
    throw new RestoreError(`Move ${moveNumber} does not belong to the color you played.`);
  }

  /*
   * "pass" is a guess, not a bad point name. `pointName` writes exactly that
   * word for one and `pointFromName` refuses it along with every other string
   * that is not a point, so the two cases are told apart here rather than by
   * null-ness — otherwise a restored pass would read as a corrupt export.
   */
  const name: string = asString(row.guess, `moves[${at}].guess`);
  const guess: number | null = name === 'pass' ? null : pointFromName(game.initial, name);
  if (guess === null && name !== 'pass') {
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

/** A move verdict from its exported row, or null where the export has none. */
function restoreMove(board: Position, value: unknown, what: string): MoveVerdict | null {
  if (value === null || value === undefined) return null;
  const row: Record<string, unknown> = asRecord(value, what);

  const name: string = asString(row.point, `${what}.point`);
  const point: number | null = pointOrPass(board, name);
  if (point === null) throw new RestoreError(`"${name}" is not a point on this board.`);

  return {
    point,
    loss: asNumber(row.loss, `${what}.loss`),
    visits: asNumber(row.visits, `${what}.visits`),
    forced: row.forced === true,
    pv: restoreLine(board, row.pv),
  };
}

/**
 * A point, or the pass that sits just past the last intersection.
 *
 * A pass is never a guess or a played move — prompts skip them — but it can be
 * the move the *engine* would make, and a result carrying one has to read back
 * or the harness rejects a perfectly good file. Lines are a separate question:
 * `restoreLine` stops at a pass rather than carrying it, which is what the
 * evaluators do too.
 */
function pointOrPass(board: Position, name: string): number | null {
  if (name === 'pass') return board.rows * board.cols;
  return pointFromName(board, name);
}

/** A principal variation, stopping at anything this board does not name. */
function restoreLine(board: Position, value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const points: number[] = [];
  for (const entry of value) {
    const point: number | null =
      typeof entry === 'string' ? pointFromName(board, entry) : null;
    if (point === null) break;
    points.push(point);
  }
  return points;
}

/**
 * Rebuild the engine's verdicts from an exported result.
 *
 * Returns null for a result exported without an engine, or by a build that
 * predates the field — which is the ordinary case and not an error. The
 * summary then computes exactly as it did before AI scoring existed.
 *
 * This is the half that makes a saved result a regression test for the engine
 * figures: the aggregates in the export are ignored and recomputed from these,
 * so a change to how a median or a run is derived shows up as drift rather than
 * being read back unchallenged.
 */
export function restoreAnalysis(text: string, game: Game): Analysis | null {
  const result: Record<string, unknown> = asRecord(JSON.parse(text) as unknown, 'the result');
  const engine: unknown = result.engine;
  const rows: unknown = result.verdicts;
  if (engine === null || engine === undefined || !Array.isArray(rows)) return null;

  const config: Record<string, unknown> = asRecord(engine, '"engine"');
  const board: Position = game.initial;

  let analysis: Analysis = emptyAnalysis({
    network: asString(config.network, '"engine".network'),
    visits: asNumber(config.visits, '"engine".visits'),
    backend: asString(config.backend, '"engine".backend'),
  });

  for (const [at, entry] of rows.entries()) {
    const row: Record<string, unknown> = asRecord(entry, `verdicts[${at}]`);
    const best: Record<string, unknown> = asRecord(row.best, `verdicts[${at}].best`);
    const bestName: string = asString(best.point, `verdicts[${at}].best.point`);
    const bestPoint: number | null = pointOrPass(board, bestName);
    if (bestPoint === null) {
      throw new RestoreError(`"${bestName}" is not a point on this board.`);
    }

    const natural: unknown = row.natural;
    analysis = withVerdict(analysis, {
      moveNumber: asNumber(row.move, `verdicts[${at}].move`),
      rootScoreLead: asNumber(row.rootScoreLead, `verdicts[${at}].rootScoreLead`),
      rootVisits: asNumber(row.rootVisits, `verdicts[${at}].rootVisits`),
      best: {
        point: bestPoint,
        scoreLead: asNumber(best.scoreLead, `verdicts[${at}].best.scoreLead`),
        pv: restoreLine(board, best.pv),
      },
      played: restoreMove(board, row.played, `verdicts[${at}].played`),
      guessed: restoreMove(board, row.guessed, `verdicts[${at}].guessed`),
      natural: restoreNatural(board, natural, `verdicts[${at}].natural`),
    });
  }
  return analysis;
}

function restoreNatural(board: Position, value: unknown, what: string): NaturalMove | null {
  if (value === null || value === undefined) return null;
  const row: Record<string, unknown> = asRecord(value, what);
  const name: string = asString(row.point, `${what}.point`);
  // The policy's own favourite can be a pass, same as the engine's (see
  // `pointOrPass`), and dropping the signal would show up as drift.
  const point: number | null = pointOrPass(board, name);
  if (point === null) return null;
  return {
    point,
    prior: asNumber(row.prior, `${what}.prior`),
    loss: asNumber(row.loss, `${what}.loss`),
  };
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

// ── Scoring a restored result ────────────────────────────────────────────────

/**
 * Score a restored session with the real engine, filling in what the export
 * does not carry.
 *
 * The exports that most need looking at are the ones made before there was an
 * engine — `experiments/out/dogfood/*-play.json` has `ai: null` and no
 * verdicts at all, and its numbers were joined to KataGo's offline, in a
 * spreadsheet nobody can see on a summary screen. Rebuilding the session and
 * asking the browser engine the same questions puts them there.
 *
 * Only the gaps are asked about. A result that already carries verdicts keeps
 * them and pays for nothing, which is the same rule `main.ts` uses during a
 * session and the reason the store is keyed by position (design §3).
 *
 * Everything lands through `refreshSummaryAnalysis`, so a search finishing
 * repaints two lines and the strip's cells and touches nothing else. Rendering
 * the screen again would throw the reader back to the final position, which is
 * the bug design §5.4 exists to record.
 */
interface Scoring {
  /** Stop the worker and the queue. Safe to call twice. */
  readonly stop: () => void;
}

interface ScoringHandlers {
  /** One line about what the engine is doing, for the banner. */
  readonly onStatus: (line: string) => void;
}

function beginScoring(
  session: Session,
  restored: Analysis | null,
  handlers: ScoringHandlers,
): Scoring {
  const unscorable: string | null = unscorableReason(session.game);
  if (unscorable !== null) {
    handlers.onStatus(`Not scoring: ${unscorable}`);
    return { stop: () => {} };
  }

  /*
   * Recorded verdicts from a *different* engine are left alone rather than
   * topped up. Mixing two configurations inside one set of point losses is
   * exactly what PRD §9 forbids, and it would be invisible afterwards: the
   * summary carries one engine line, and it would name whichever store won.
   */
  const config = engineConfig();
  if (restored !== null && !sameEngine(restored.config, config)) {
    handlers.onStatus(
      `Not scoring: this result carries verdicts from a different engine, ` +
        `and mixing two into one point loss is worse than leaving the gaps.`,
    );
    return { stop: () => {} };
  }

  let analysis: Analysis = restored ?? emptyAnalysis(config);
  let status: EngineStatus = { state: 'idle' };

  const line = (): string => {
    switch (status.state) {
      case 'idle':
        return 'Scoring: starting up.';
      case 'downloading': {
        if (status.total === null) {
          return `Scoring: downloading the engine, ${(status.received / 1_000_000).toFixed(0)} MB.`;
        }
        const percent: number = Math.min(100, Math.round((status.received / status.total) * 100));
        return `Scoring: downloading the engine, ${percent}%.`;
      }
      case 'warming':
        return 'Scoring: starting the engine.';
      case 'ready': {
        const waiting: number = queue?.pending() ?? 0;
        const done: number = session.guesses.length - waiting;
        return waiting === 0
          ? `Scoring: done, ${done} of ${session.guesses.length} predictions.`
          : `Scoring: ${done} of ${session.guesses.length}, ${waiting} to go.`;
      }
      case 'failed':
        return `Scoring failed, so the summary shows what it had. ${status.reason}`;
    }
  };

  const engine: EngineHandle = startEngine(session.game, {
    onStatus: (next: EngineStatus): void => {
      status = next;
      handlers.onStatus(line());
    },
  });

  const queue: Queue = createQueue(engine.evaluator, {
    onVerdict: (verdict: Verdict): void => {
      analysis = withVerdict(analysis, verdict);
      refreshSummaryAnalysis(summarize(session, analysis));
      handlers.onStatus(line());
    },
    // One prompt failing is not fatal, exactly as in a live session.
    onError: (): void => handlers.onStatus(line()),
  });

  let asked = 0;
  for (const made of session.guesses) {
    const known: Verdict | null = verdictFor(analysis, made.moveNumber);
    if (known && known.guessed?.point === made.guess) continue;

    const move: GameMove | undefined = session.game.moves[made.moveNumber - 1];
    if (!move) continue;

    const prompt: Prompt = {
      moveNumber: made.moveNumber,
      position: move.before,
      color: move.color,
      played: made.actual,
      guess: made.guess,
    };
    queue.submit(prompt);
    asked++;
  }

  if (asked === 0) {
    engine.stop();
    queue.stop();
    handlers.onStatus('Every prediction in this result already has a verdict.');
    return { stop: () => {} };
  }

  handlers.onStatus(line());
  return {
    stop: (): void => {
      queue.stop();
      engine.stop();
    },
  };
}

// ── The screen ───────────────────────────────────────────────────────────────

export interface DevProps {
  readonly onBack: () => void;
  /** Start a real session on a restored record — the summary view offers it. */
  readonly onReplay: (game: Game, color: Color) => void;
  /** A record as a link, so the harness offers what the real screen does. */
  readonly challengeLink: (game: Game) => Promise<string>;
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
  /*
   * One engine at a time, and it does not outlive the summary it was started
   * for. Every route off this screen goes through `showForm` or a callback in
   * `props`, so stopping here is enough to guarantee that a worker is never
   * left holding the GPU behind a screen nobody is looking at.
   */
  let scoring: Scoring | null = null;
  const stopScoring = (): void => {
    scoring?.stop();
    scoring = null;
  };

  const showForm = (error?: string): void => {
    stopScoring();
    const area: HTMLTextAreaElement = document.createElement('textarea');
    area.className = 'sgf-input';
    area.rows = 12;
    area.spellcheck = false;
    area.placeholder =
      'Paste the JSON from "Copy as JSON", or drop a .json file on the page — ' +
      'experiments/out/dogfood/*-play.json included.';

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
          'screen, then reports any field a fresh export no longer agrees on. ' +
          'Any prediction the result has no verdict for is put to the engine, ' +
          'so a result exported before there was one still gets its point losses.',
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

  /** Whether the harness's own engine should run; the summary's toggle owns it. */
  let scoringWanted = true;

  const accept = (text: string): void => {
    if (text.trim() === '') {
      showForm('Paste a result first.');
      return;
    }

    let session: Session;
    let summary: Summary;
    let restored: Analysis | null = null;
    try {
      session = restoreSession(text);
      // Recomputed from the restored verdicts, never read back from the
      // export's own `ai` block: reading the figures back would make the diff
      // below compare a file with itself.
      restored = restoreAnalysis(text, session.game);
      summary = summarize(session, scoringWanted ? (restored ?? undefined) : undefined);
    } catch (error: unknown) {
      const detail: string = error instanceof Error ? error.message : String(error);
      showForm(detail);
      return;
    }

    // Started before the render, as `copyButton` expects.
    const link: Promise<string> = props.challengeLink(session.game);
    renderSummary(root, {
      summary,
      session,
      onReplay: (color: Color): void => {
        stopScoring();
        props.onReplay(session.game, color);
      },
      onRestart: () => showForm(),
      challengeLink: (): Promise<string> => link,
      // The harness has its own engine, so the toggle drives that one: off
      // stops the searches and re-renders without them, on starts the whole
      // pass again from the pasted result.
      ai: scoringWanted,
      aiUnavailable: null,
      onToggleAi: (on: boolean): void => {
        scoringWanted = on;
        stopScoring();
        accept(text);
      },
    });

    /*
     * The drift report is measured against the export as it was pasted, before
     * any scoring, and stays that way: a healed result legitimately no longer
     * matches the file it came from, and reporting that as drift would bury
     * the differences the report exists to catch.
     */
    const status: HTMLElement = element('p', 'note', '');
    root.prepend(driftBanner(driftFrom(text, summary)), status);

    stopScoring();
    if (!scoringWanted) return;
    scoring = beginScoring(session, restored, {
      onStatus: (line: string): void => {
        status.textContent = line;
      },
    });
  };

  // A dropped file arrives as `initial` and skips the form entirely; anything
  // wrong with it lands back on the form with the reason.
  if (initial === undefined) showForm();
  else accept(initial);
}
