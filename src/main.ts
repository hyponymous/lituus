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
import { DEV_HASH, renderDev, type DevProps } from './dev.ts';
import type { Color } from './rules.ts';

type Screen =
  | { readonly name: 'landing'; readonly error?: string }
  | { readonly name: 'setup'; readonly game: Game }
  | { readonly name: 'session'; readonly session: Session }
  /**
   * The dev harness. Only ever reached under `import.meta.env.DEV`. `result`
   * is a saved result to render straight away, as a drop supplies.
   */
  | { readonly name: 'dev'; readonly result?: string };

/**
 * Reveal timing, all of it, in one place.
 *
 * The asymmetry is deliberate. A hit resolves fast and with a bounce, so
 * getting it right feels like a reward. A miss holds: first a beat where only
 * the user's own guess is marked, then the answer arrives, then time to
 * compare two points that may be across the board from each other.
 *
 * `beat` is why a miss cannot simply be shortened. It is dead time before the
 * answer is even visible, so `miss` has to leave reading time on top of it —
 * see the assertion below.
 */
const REVEAL_MS = { hit: 450, miss: 1900, beat: 550 } as const;

/** Time the user actually gets to look at the answer on a miss. */
const READING_MS: number = REVEAL_MS.miss - REVEAL_MS.beat;

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

  if (looksLikeResult(sgf)) {
    // Saying "expected '(' at line 1" to someone holding an exported result is
    // technically true and no help at all.
    show({
      name: 'landing',
      error: 'That looks like an exported result, not a game record. Load the .sgf it was played on.',
    });
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

/**
 * The dev screen's callbacks. It renders the real summary view, so it has to
 * be able to do everything that view offers — starting a session included.
 */
function devProps(): DevProps {
  return {
    onBack: (): void => show({ name: 'landing' }),
    onReplay: (game: Game, color: Color): void =>
      show({ name: 'session', session: startSession(game, color) }),
  };
}

/** A saved result rather than a game record — the exports are JSON objects. */
function looksLikeResult(text: string): boolean {
  return text.trimStart().startsWith('{');
}

function drawSession(session: Session): void {
  // A finished session goes straight to its summary; nothing further to play.
  if (session.phase === 'done') {
    renderSummary(root, {
      summary: summarize(session),
      session,
      onReplay: (color: Color): void =>
        show({ name: 'session', session: startSession(session.game, color) }),
      onRestart: () => show({ name: 'landing' }),
    });
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
  // The masthead lives outside #app and is not a view's to redraw, so the
  // screen name goes on the body and the stylesheet does the rest: the tagline
  // introduces the tool on the landing screen and gets out of the way after.
  document.body.dataset.screen = screen.name;

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
    case 'dev': {
      // Guarded rather than merely unreachable: this is what lets the bundler
      // drop dev.ts and everything it pulls in from the production build.
      const { result } = screen;
      if (import.meta.env.DEV) renderDev(root, devProps(), result);
      return;
    }
  }
}

/**
 * Route a dropped file by what is in it, rather than by which screen happens
 * to be showing. A record opens with '(' and a saved result with '{', so there
 * is nothing to disambiguate.
 *
 * Routing on the screen instead was wrong in the way that matters: dropping a
 * result anywhere but #dev fed it to the SGF parser, and the user got a
 * complaint about column 1 instead of the screen they asked for.
 */
function loadDropped(text: string): void {
  if (import.meta.env.DEV && looksLikeResult(text)) {
    show({ name: 'dev', result: text });
    return;
  }
  loadGame(text);
}

function main(): void {
  const app: HTMLElement | null = document.getElementById('app');
  if (!app) throw new Error('missing #app container');

  if (READING_MS < 600) {
    // Not a style rule. If the beat eats the reveal, the answer flashes and is
    // gone, and the tool silently stops teaching anything on a miss.
    throw new Error(`reveal beat leaves only ${READING_MS}ms to read the answer`);
  }

  // The stylesheet times the beat; this keeps it from drifting away from the
  // auto-advance that has to outlast it.
  document.documentElement.style.setProperty('--reveal-beat', `${REVEAL_MS.beat}ms`);

  root = app;
  acceptDroppedFiles(document.body, loadDropped);

  if (import.meta.env.DEV) {
    // Typing the fragment is the whole entry point — no link in the UI, so
    // nothing about the dev harness has to be hidden on the way to production.
    if (location.hash === DEV_HASH) screen = { name: 'dev' };
    window.addEventListener('hashchange', (): void => {
      if (location.hash === DEV_HASH) show({ name: 'dev' });
    });
  }

  draw();
}

main();
