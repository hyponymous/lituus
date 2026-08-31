/**
 * Application entry point: holds which screen is showing and re-renders on
 * every change. The views are pure functions of their props, so there is no
 * incremental update path to get wrong — a state change redraws the screen.
 */

import { parse, type GameTree } from './sgf-parser.ts';
import { serialize } from './sgf-writer.ts';
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
import { SPIKE_HASH } from './engine/spike-hash.ts';
import { decode, encode } from './share.ts';
import type { Color } from './rules.ts';

type Screen =
  | {
      readonly name: 'landing';
      readonly error?: string;
      /** Set when the error is a link that would not open, so it can be shown. */
      readonly failedLink?: string;
    }
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

/**
 * When the prompt now on screen was drawn, and which one it is.
 *
 * `performance.now()` rather than `Date.now()`: it is monotonic, so a clock
 * adjustment mid-session cannot produce a negative time. The cursor is kept
 * alongside it because a redraw of the same prompt must not restart the
 * clock — only moving to a new question does.
 *
 * Nothing stops this while the tab is hidden or the user walks away, so a
 * single guess can be arbitrarily long. That is why the summary leads with a
 * median rather than a mean.
 */
let promptedAt: number | null = null;
let promptedCursor: number | null = null;

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
function loadGame(sgf: string): boolean {
  if (sgf.trim() === '') {
    show({ name: 'landing', error: 'Paste a game record first, or drop an .sgf file.' });
    return false;
  }

  if (looksLikeResult(sgf)) {
    // Saying "expected '(' at line 1" to someone holding an exported result is
    // technically true and no help at all.
    show({
      name: 'landing',
      error: 'That looks like an exported result, not a game record. Load the .sgf it was played on.',
    });
    return false;
  }

  try {
    const trees: GameTree[] = parse(sgf);
    const game: Game = readGame(trees);
    useGame(game);
    show({ name: 'setup', game });
    return true;
  } catch (error: unknown) {
    const detail: string = error instanceof Error ? error.message : String(error);
    const prefix: string =
      error instanceof GameError ? '' : "That doesn't look like a valid SGF file. ";
    show({ name: 'landing', error: `${prefix}${detail}` });
    return false;
  }
}

/**
 * The loaded record as a link someone else can open.
 *
 * Started when a game is taken up rather than when the button is pressed, so
 * the compression is long finished by click time and the clipboard write
 * still counts as part of the user's gesture. The plain record is encoded,
 * never the annotated export — a challenge that arrived carrying the answers
 * would not be one.
 */
function linkFor(game: Game): Promise<string> {
  const link: Promise<string> = encode(serialize([game.source])).then(
    (fragment: string): string => `${location.origin}${location.pathname}#${fragment}`,
  );
  // The button attaches its own handler and reports failure on itself. This
  // only keeps a link nobody copies from logging an unhandled rejection.
  link.catch((): void => {});
  return link;
}

let challenge: Promise<string> = Promise.reject(new Error('no game loaded'));
challenge.catch((): void => {});

function useGame(game: Game): void {
  challenge = linkFor(game);
}

/**
 * Drop the fragment without touching the page.
 *
 * `replaceState` rather than assigning to `location.hash`: it fires no
 * `hashchange`, so clearing cannot feed back into the listener that reads the
 * fragment, and it leaves no history entry to walk back through.
 */
function clearHash(): void {
  if (location.hash !== '') history.replaceState(null, '', location.pathname + location.search);
}

/** Back to the landing screen with no game, and no stale link in the bar. */
function restart(): void {
  clearHash();
  show({ name: 'landing' });
}

/**
 * The dev screen's callbacks. It renders the real summary view, so it has to
 * be able to do everything that view offers — starting a session included.
 */
function devProps(): DevProps {
  return {
    onBack: (): void => restart(),
    onReplay: (game: Game, color: Color): void => show(startAt(game, color)),
    challengeLink: linkFor,
  };
}

/** A saved result rather than a game record — the exports are JSON objects. */
function looksLikeResult(text: string): boolean {
  return text.trimStart().startsWith('{');
}

/**
 * Begin a session, with the prompt clock reset.
 *
 * The reset is the point of this existing. A fresh session can land on the
 * same cursor the previous one ended on — a replay of the same color usually
 * does — and without clearing it, the first guess of the new run would be
 * timed from a prompt the user answered minutes ago.
 */
function startAt(game: Game, color: Color): Screen {
  promptedCursor = null;
  // Every session starts here, the dev harness's replays included, so this is
  // where the challenge link is guaranteed to be the game actually in play.
  useGame(game);
  return { name: 'session', session: startSession(game, color) };
}

/** Milliseconds the current prompt has been up, or null if it was not timed. */
function elapsed(): number | null {
  return promptedAt === null ? null : Math.round(performance.now() - promptedAt);
}

function drawSession(session: Session): void {
  // A finished session goes straight to its summary; nothing further to play.
  if (session.phase === 'done') {
    renderSummary(root, {
      summary: summarize(session),
      session,
      onReplay: (color: Color): void => show(startAt(session.game, color)),
      onRestart: (): void => restart(),
      challengeLink: (): Promise<string> => challenge,
    });
    return;
  }

  const next = (): void => show({ name: 'session', session: advance(session) });

  if (session.phase === 'prompt' && session.cursor !== promptedCursor) {
    promptedCursor = session.cursor;
    promptedAt = performance.now();
  }

  renderSession(root, {
    session,
    onGuess: (index: number): void =>
      show({ name: 'session', session: guess(session, index, elapsed()) }),
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
      renderLanding(root, {
        error: screen.error,
        failedLink: screen.failedLink,
        onLoad: loadGame,
      });
      return;
    case 'setup': {
      const { game } = screen;
      renderSetup(root, {
        game,
        onStart: (color: Color): void => show(startAt(game, color)),
        onBack: (): void => restart(),
        challengeLink: (): Promise<string> => challenge,
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

  // The engine spike, unlike the dev harness, ships. It exists to test the
  // built, deployed, base-pathed site, which is the one place it cannot be
  // allowed to be absent. Imported dynamically so an ordinary visit pays
  // nothing for it, and reachable only by typing the fragment.
  if (location.hash === SPIKE_HASH) void openSpike();
  window.addEventListener('hashchange', (): void => {
    if (location.hash === SPIKE_HASH) void openSpike();
  });

  // A second link pasted into the same tab only changes the fragment, which
  // is a same-document navigation: nothing reloads and the old game would
  // stay on screen. Handing someone a set of links makes that the normal way
  // to arrive at the second one.
  window.addEventListener('hashchange', (): void => void loadFromHash());

  draw();
  void loadFromHash();
}

/**
 * Hand the page over to the spike.
 *
 * The screen name is set after the import, not before: bootstrap calls `draw()`
 * while this is still awaiting, and `draw()` writes the same attribute. Setting
 * it first would simply be overwritten a tick later.
 */
async function openSpike(): Promise<void> {
  const { renderSpike } = await import('./spike.ts');
  document.body.dataset.screen = 'spike';
  await renderSpike(root);
}

/**
 * A game carried in the URL fragment, as `share.ts` encodes it.
 *
 * The fragment is an inbox, not a mirror of what the page is doing. A link
 * hands the app a record once and the fragment is then cleared, so the URL
 * never claims to describe a session it cannot restore — a game is only one
 * part of the state on screen, and the rest of it (which side, how far in,
 * every answer so far) has no business being silently rewritten by whatever
 * is in the bar.
 *
 * Clearing only happens once a record has actually loaded. A link that
 * arrives damaged is left in place: a reload retries it, and it is still the
 * link the user was sent.
 *
 * Deliberately after `draw()` rather than awaited before it. Decoding is
 * asynchronous, so blocking the first paint on it would show nothing at all
 * while a link opens — and nothing at all is what a broken link would leave
 * on screen. The landing view paints first and the game replaces it.
 *
 * The dev and spike fragments are checked before this and are fixed short
 * strings, so neither can be mistaken for encoded game data.
 */
async function loadFromHash(): Promise<void> {
  const fragment: string = location.hash.slice(1);
  if (fragment === '' || location.hash === SPIKE_HASH) return;
  if (import.meta.env.DEV && location.hash === DEV_HASH) return;
  const link: string = `${location.origin}${location.pathname}#${fragment}`;
  try {
    loadGame(await decode(fragment));
  } catch (error: unknown) {
    const detail: string = error instanceof Error ? error.message : String(error);
    // The banner carries the link, which is why clearing it here is safe: the
    // only copy the user has moves from the address bar onto the screen,
    // where there is a button to take it away with.
    show({ name: 'landing', error: detail, failedLink: link });
  }
  clearHash();
}

main();
