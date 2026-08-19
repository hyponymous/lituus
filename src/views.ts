/**
 * The four screens and their controls.
 *
 * Each view renders itself into a container from props and reports user intent
 * through callbacks; none of them owns application state or decides what comes
 * next. That belongs to main.ts, which holds the current screen and re-renders
 * on every change. Views are therefore free to be torn down and rebuilt, which
 * is why they replace their container's contents rather than patching.
 */

import { renderGoban, type Marker } from './goban.ts';
import { describe, type Game, type GameMeta } from './game.ts';
import { canGuess, countPrompts, score, type Score, type Session } from './session.ts';
import { percent, toJSON, toText, type Summary } from './summary.ts';
import { BLACK, WHITE, type Color } from './rules.ts';

type Attrs = Record<string, string>;
type Child = Node | string;

/** Terse element builder. The views are mostly structure, so this earns itself. */
function el(tag: string, attrs: Attrs = {}, children: readonly Child[] = []): HTMLElement {
  const node: HTMLElement = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'class') node.className = value;
    else node.setAttribute(name, value);
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function button(label: string, onClick: () => void, attrs: Attrs = {}): HTMLElement {
  const node: HTMLElement = el('button', { type: 'button', ...attrs }, [label]);
  node.addEventListener('click', onClick);
  return node;
}

function replace(root: HTMLElement, ...children: readonly Child[]): void {
  root.replaceChildren(...children);
}

function colorName(color: Color): string {
  return color === BLACK ? 'Black' : 'White';
}

// ── Landing ──────────────────────────────────────────────────────────────────

export interface LandingProps {
  readonly error?: string;
  readonly onLoad: (sgf: string) => void;
}

export function renderLanding(root: HTMLElement, props: LandingProps): void {
  const area = el('textarea', {
    class: 'sgf-input',
    rows: '10',
    spellcheck: 'false',
    placeholder: 'Paste SGF text here, or drop a .sgf file anywhere on the page.',
  }) as HTMLTextAreaElement;

  const load = (): void => props.onLoad(area.value);

  const parts: Child[] = [
    el('h2', {}, ['Load a game']),
    el('p', { class: 'muted' }, [
      'Paste a game record, or drop an .sgf file onto the page. ' +
        'Nothing is uploaded; the whole session runs in this tab.',
    ]),
    area,
    el('div', { class: 'actions' }, [button('Load game', load, { class: 'primary' })]),
  ];

  if (props.error) {
    parts.push(el('p', { class: 'error', role: 'alert' }, [props.error]));
  }

  replace(root, ...parts);
  area.focus();
}

/**
 * Accept a dropped .sgf anywhere on the page. Registered once, for the life of
 * the app, because a drop target that only exists on one screen is a target
 * users will miss.
 */
export function acceptDroppedFiles(target: HTMLElement, onLoad: (sgf: string) => void): void {
  target.addEventListener('dragover', (event: DragEvent): void => {
    event.preventDefault();
    target.classList.add('dropping');
  });
  target.addEventListener('dragleave', (): void => target.classList.remove('dropping'));
  target.addEventListener('drop', (event: DragEvent): void => {
    event.preventDefault();
    target.classList.remove('dropping');
    const file: File | undefined = event.dataTransfer?.files[0];
    if (file) void file.text().then(onLoad);
  });
}

// ── Setup ────────────────────────────────────────────────────────────────────

export interface SetupProps {
  readonly game: Game;
  readonly onStart: (color: Color) => void;
  readonly onBack: () => void;
}

/** Metadata rows worth showing, skipping whatever the record omitted. */
function metaRows(meta: GameMeta): [string, string][] {
  const fields: [string, string | number | undefined][] = [
    ['Event', meta.event],
    ['Date', meta.date],
    ['Place', meta.place],
    ['Result', meta.result],
    ['Komi', meta.komi],
    ['Handicap', meta.handicap],
    ['Ruleset', meta.ruleset],
  ];
  return fields
    .filter(([, value]) => value !== undefined)
    .map(([label, value]) => [label, String(value)]);
}

export function renderSetup(root: HTMLElement, props: SetupProps): void {
  const { game } = props;
  const rows: [string, string][] = metaRows(game.meta);

  const table: HTMLElement = el(
    'dl',
    { class: 'meta' },
    rows.flatMap(([label, value]) => [el('dt', {}, [label]), el('dd', {}, [value])]),
  );

  const notes: Child[] = game.notes.map((note) => el('p', { class: 'note' }, [note]));

  const choices: HTMLElement = el('div', { class: 'actions' }, [
    button(`Play as Black (${countPrompts(game, BLACK)} moves)`, () => props.onStart(BLACK), {
      class: 'primary',
    }),
    button(`Play as White (${countPrompts(game, WHITE)} moves)`, () => props.onStart(WHITE), {
      class: 'primary',
    }),
  ]);

  replace(
    root,
    el('h2', {}, [describe(game)]),
    el('p', { class: 'muted' }, [`${game.cols}×${game.rows} board, ${game.moves.length} moves`]),
    ...(rows.length > 0 ? [table] : []),
    ...notes,
    el('p', {}, ['Which side do you want to predict?']),
    choices,
    el('div', { class: 'actions' }, [button('Load a different game', props.onBack)]),
  );
}

// ── Session ──────────────────────────────────────────────────────────────────

export interface SessionProps {
  readonly session: Session;
  readonly onGuess: (index: number) => void;
  readonly onAdvance: () => void;
  readonly onEnd: () => void;
}

function sessionMarkers(session: Session): Marker[] {
  const made = session.lastGuess;
  if (session.phase !== 'reveal' || !made) return [];
  return made.hit
    ? [{ index: made.actual, kind: 'hit' }]
    : [
        { index: made.actual, kind: 'actual' },
        { index: made.guess, kind: 'guess' },
      ];
}

function sessionStatus(session: Session): string {
  const result: Score = score(session);
  const running = `${result.hits}/${result.guessed} correct`;

  if (session.phase === 'reveal' && session.lastGuess) {
    const verdict: string = session.lastGuess.hit
      ? 'Correct.'
      : 'Not this time — the played move is circled.';
    return `${verdict} ${running}.`;
  }
  if (session.move) {
    return `Move ${session.move.number}. Where does ${colorName(session.color)} play? (${running})`;
  }
  return running;
}

export function renderSession(root: HTMLElement, props: SessionProps): void {
  const { session } = props;
  const board: HTMLElement = el('div', { class: 'board' });
  const revealing: boolean = session.phase === 'reveal';

  renderGoban(session.position, board, {
    markers: sessionMarkers(session),
    showCoordinates: true,
    onPoint: (index: number): void => {
      // During a reveal any click advances, which keeps the whole loop on the
      // mouse and within the board the user is already looking at.
      if (revealing) props.onAdvance();
      else if (canGuess(session, index)) props.onGuess(index);
    },
  });

  // The reveal advances on its own; Skip is for readers faster than the timer.
  const controls: Child[] = [
    ...(revealing ? [button('Skip', props.onAdvance)] : []),
    button('End session', props.onEnd),
  ];

  replace(
    root,
    el('h2', {}, [describe(session.game)]),
    board,
    el('p', { class: 'readout' }, [sessionStatus(session)]),
    el('div', { class: 'actions' }, controls),
  );
}

// ── Summary ──────────────────────────────────────────────────────────────────

export interface SummaryProps {
  readonly summary: Summary;
  readonly onRestart: () => void;
}

function phaseTable(summary: Summary): HTMLElement {
  const body: HTMLElement[] = summary.phases.map((phase) =>
    el('tr', {}, [
      el('td', {}, [phase.phase]),
      el('td', {}, [phase.guessed > 0 ? `${phase.hits} / ${phase.guessed}` : '—']),
      el('td', {}, [phase.guessed > 0 ? percent(phase.rate) : '—']),
    ]),
  );

  return el('table', { class: 'stats' }, [
    el('thead', {}, [
      el('tr', {}, [el('th', {}, ['Phase']), el('th', {}, ['Hits']), el('th', {}, ['Rate'])]),
    ]),
    el('tbody', {}, body),
  ]);
}

function moveTable(summary: Summary): HTMLElement {
  const body: HTMLElement[] = summary.rows.map((row) =>
    el('tr', { class: row.hit ? 'hit' : 'miss' }, [
      el('td', {}, [String(row.moveNumber)]),
      el('td', {}, [row.guess]),
      el('td', {}, [row.actual]),
      el('td', {}, [row.hit ? 'hit' : 'miss']),
    ]),
  );

  return el('table', { class: 'moves' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', {}, ['Move']),
        el('th', {}, ['You']),
        el('th', {}, ['Played']),
        el('th', {}, ['']),
      ]),
    ]),
    el('tbody', {}, body),
  ]);
}

/** Copy to the clipboard, reporting on the button itself so there is no dialog. */
function copyButton(label: string, text: () => string): HTMLElement {
  const node: HTMLElement = el('button', { type: 'button' }, [label]);

  const flash = (message: string): void => {
    node.textContent = message;
    setTimeout(() => (node.textContent = label), 1200);
  };

  node.addEventListener('click', (): void => {
    void navigator.clipboard.writeText(text()).then(
      () => flash('Copied'),
      () => flash('Copy failed'),
    );
  });
  return node;
}

export function renderSummary(root: HTMLElement, props: SummaryProps): void {
  const { summary } = props;
  const result: Score = summary.score;

  const headline: string =
    result.guessed > 0
      ? `${result.hits} of ${result.guessed} correct — ${percent(result.rate)}`
      : 'No moves predicted.';

  const parts: Child[] = [
    el('h2', {}, ['Session summary']),
    el('p', { class: 'muted' }, [`${summary.game} · played as ${colorName(summary.color)}`]),
    el('p', { class: 'headline' }, [headline]),
  ];

  if (summary.abandoned) {
    parts.push(
      el('p', { class: 'note' }, [
        `Ended early: ${result.guessed} of ${result.total} moves predicted.`,
      ]),
    );
  }

  if (result.guessed > 0) {
    parts.push(phaseTable(summary), el('div', { class: 'scroll' }, [moveTable(summary)]));
  }

  parts.push(
    el('div', { class: 'actions' }, [
      copyButton('Copy as text', () => toText(summary)),
      copyButton('Copy as JSON', () => toJSON(summary)),
      button('Study another game', props.onRestart, { class: 'primary' }),
    ]),
  );

  replace(root, ...parts);
}
