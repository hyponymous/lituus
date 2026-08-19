/**
 * Application entry point: holds which screen is showing and re-renders on
 * every change. The views are pure functions of their props, so there is no
 * incremental update path to get wrong — a state change redraws the screen.
 */

import { parse, type GameTree } from './sgf-parser.ts';
import { GameError, readGame, type Game } from './game.ts';
import {
  advance,
  endSession,
  guess,
  startSession,
  type Session,
} from './session.ts';
import { summarize } from './summary.ts';
import {
  acceptDroppedFiles,
  renderLanding,
  renderSession,
  renderSetup,
  renderSummary,
} from './views.ts';
import type { Color } from './rules.ts';

type Screen =
  | { readonly name: 'landing'; readonly error?: string }
  | { readonly name: 'setup'; readonly game: Game }
  | { readonly name: 'session'; readonly session: Session };

/**
 * How long a reveal stays up before the session advances itself.
 *
 * A miss gets longer because there are two points to find and compare, while a
 * hit only has to be registered. Both are short enough that a click to advance
 * early still feels like the faster path — the timer is a floor on reading
 * time, not a pace the user has to wait out. Tuned by feel; adjust here.
 */
const REVEAL_MS = { hit: 650, miss: 1500 } as const;

let screen: Screen = { name: 'landing' };
let root: HTMLElement;

/** A scheduled auto-advance, cleared on any state change so it cannot fire late. */
let pending: ReturnType<typeof setTimeout> | null = null;

function show(next: Screen): void {
  // Every transition cancels a pending advance. Without this, ending a session
  // during a reveal would leave a timer that advances a session already over.
  if (pending !== null) {
    clearTimeout(pending);
    pending = null;
  }
  screen = next;
  draw();
}

/**
 * Turn SGF text into a game, or into a message the user can act on. Parse
 * errors carry line and column from the parser; game errors explain what about
 * the record cannot be studied. Either way the user stays on the landing view.
 */
function loadGame(sgf: string): void {
  if (sgf.trim() === '') {
    show({ name: 'landing', error: 'Paste a game record first, or drop an .sgf file.' });
    return;
  }

  try {
    const trees: GameTree[] = parse(sgf);
    show({ name: 'setup', game: readGame(trees) });
  } catch (error: unknown) {
    const detail: string = error instanceof Error ? error.message : String(error);
    const prefix: string =
      error instanceof GameError ? '' : "That doesn't look like a valid SGF file. ";
    show({ name: 'landing', error: `${prefix}${detail}` });
  }
}

function drawSession(session: Session): void {
  // A finished session goes straight to its summary; nothing further to play.
  if (session.phase === 'done') {
    renderSummary(root, { summary: summarize(session), onRestart: () => show({ name: 'landing' }) });
    return;
  }

  const next = (): void => show({ name: 'session', session: advance(session) });

  renderSession(root, {
    session,
    onGuess: (index: number): void => show({ name: 'session', session: guess(session, index) }),
    onAdvance: next,
    onEnd: (): void => show({ name: 'session', session: endSession(session) }),
  });

  if (session.phase === 'reveal' && session.lastGuess) {
    pending = setTimeout(next, session.lastGuess.hit ? REVEAL_MS.hit : REVEAL_MS.miss);
  }
}

function draw(): void {
  switch (screen.name) {
    case 'landing':
      renderLanding(root, { error: screen.error, onLoad: loadGame });
      return;
    case 'setup': {
      const { game } = screen;
      renderSetup(root, {
        game,
        onStart: (color: Color): void =>
          show({ name: 'session', session: startSession(game, color) }),
        onBack: (): void => show({ name: 'landing' }),
      });
      return;
    }
    case 'session':
      drawSession(screen.session);
      return;
  }
}

function main(): void {
  const app: HTMLElement | null = document.getElementById('app');
  if (!app) throw new Error('missing #app container');

  root = app;
  acceptDroppedFiles(document.body, loadGame);
  draw();
}

main();
