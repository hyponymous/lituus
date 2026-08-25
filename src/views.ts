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
import { describe, type Game, type GameMeta, type GameMove } from './game.ts';
import {
  canGuess,
  countPrompts,
  finalPosition,
  lastPlayed,
  score,
  type Guess,
  type Score,
  type Session,
} from './session.ts';
import {
  duration,
  longestStreak,
  percent,
  tenukiAgreement,
  toJSON,
  toText,
  type Streak,
  type Summary,
} from './summary.ts';
import { annotatedFilename, annotatedSgf } from './annotate.ts';
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

/**
 * Metadata rows worth showing, skipping whatever the record omitted.
 *
 * `Result` is deliberately absent. Knowing who won colors every prediction
 * that follows — a losing player's moves read as mistakes before they are
 * seen. The summary shows it once the guessing is over.
 */
function metaRows(meta: GameMeta): [string, string][] {
  const fields: [string, string | number | undefined][] = [
    ['Event', meta.event],
    ['Date', meta.date],
    ['Place', meta.place],
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

  if (session.phase !== 'reveal' || !made) {
    // Waiting on a guess: show where the opponent just replied, the way a real
    // board shows it by the stone you watched them place. Without it the user
    // has to diff the position against the one they saw a moment ago.
    const previous: GameMove | null = lastPlayed(session);
    return previous?.index != null ? [{ index: previous.index, kind: 'last' }] : [];
  }

  return made.hit
    ? [{ index: made.actual, kind: 'hit' }]
    : [
        { index: made.actual, kind: 'actual' },
        { index: made.guess, kind: 'guess' },
      ];
}

/** The stone that just appeared, so the renderer can animate it in. */
function sessionAnimate(session: Session): number[] {
  const played: GameMove | null = lastPlayed(session);
  return played?.index != null ? [played.index] : [];
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

/**
 * How far through the game you are. The move number alone does not answer
 * "another ten of these, or another hundred?", and a 19x19 record asks enough
 * questions that the answer changes how a user paces themselves.
 */
function progressBar(session: Session): HTMLElement {
  const { guessed, total }: Score = score(session);
  // The prompt on screen counts as reached, not answered. Without it the bar
  // sits at zero while the user is already looking at the first question.
  const reached: number = Math.min(guessed + (session.phase === 'prompt' ? 1 : 0), total);
  const label = `${reached} of ${total}`;

  return el(
    'div',
    {
      class: 'progress',
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': String(total),
      'aria-valuenow': String(reached),
      'aria-label': `Move ${label}`,
    },
    [
      el('div', { class: 'progress-track' }, [
        el('div', {
          class: 'progress-fill',
          style: `width:${total > 0 ? (reached / total) * 100 : 0}%`,
        }),
      ]),
      el('span', { class: 'progress-count' }, [label]),
    ],
  );
}

export function renderSession(root: HTMLElement, props: SessionProps): void {
  const { session } = props;
  const board: HTMLElement = el('div', { class: 'board' });
  const revealing: boolean = session.phase === 'reveal';

  const missed: boolean = revealing && session.lastGuess?.hit === false;

  renderGoban(session.position, board, {
    markers: sessionMarkers(session),
    animate: sessionAnimate(session),
    // On a miss the played stone waits with its marker, so the user reads
    // their own guess before the answer lands somewhere else on the board.
    animateLate: missed,
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
    progressBar(session),
    el('p', { class: 'readout' }, [sessionStatus(session)]),
    el('div', { class: 'actions' }, controls),
  );
}

// ── Summary ──────────────────────────────────────────────────────────────────

export interface SummaryProps {
  readonly summary: Summary;
  /** The session the summary came from, for the annotated export and replays. */
  readonly session: Session;
  /** Play the same record again, as either color. */
  readonly onReplay: (color: Color) => void;
  readonly onRestart: () => void;
}

/**
 * Hand the user a file. Revoking on the next frame rather than immediately
 * gives the browser time to start the download; revoking too early cancels it.
 */
function download(name: string, text: string, type: string): void {
  const url: string = URL.createObjectURL(new Blob([text], { type }));
  const link = el('a', { href: url, download: name, style: 'display:none' }) as HTMLAnchorElement;

  // The link goes into the document before it is clicked. A detached anchor
  // works in some browsers and silently does nothing in others, and a download
  // that fails without an error is the worst version of this bug.
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Your local-or-away calls against the player's, laid out as the 2x2 they
 * actually form rather than as four rows.
 *
 * Agreement is the diagonal, and seeing it as a diagonal is the whole point: a
 * list makes the reader rebuild the shape before they can read it, and the
 * off-diagonal cells are two different habits, not two more numbers.
 */
function tenukiMatrix(summary: Summary): HTMLElement {
  const { tenuki } = summary;
  const { agreed, scored } = tenukiAgreement(tenuki);

  const cell = (count: number, agrees: boolean, note?: string): HTMLElement =>
    el('td', { class: agrees ? 'agree' : '' }, [
      el('span', { class: 'count' }, [String(count)]),
      ...(note === undefined ? [] : [el('span', { class: 'cell-note' }, [note])]),
    ]);

  // Both leaving says little if you left for opposite corners, so the cell
  // that claims the most agreement is the one that has to qualify itself.
  const sameArea: string | undefined =
    tenuki.bothAway > 0 ? `${tenuki.sameArea} to the same area` : undefined;

  return el('section', {}, [
    el('h3', {}, ['Local or away']),
    el('p', { class: 'muted' }, [
      `You made the same call as the player on ${agreed} of ${scored} moves ` +
        `(${percent(scored > 0 ? agreed / scored : 0)}).`,
    ]),
    el('table', { class: 'matrix' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('td', {}, []),
          el('th', { scope: 'col' }, ['You answered']),
          el('th', { scope: 'col' }, ['You left']),
        ]),
      ]),
      el('tbody', {}, [
        el('tr', {}, [
          el('th', { scope: 'row' }, ['They answered']),
          cell(tenuki.bothLocal, true),
          cell(tenuki.leftEarly, false),
        ]),
        el('tr', {}, [
          el('th', { scope: 'row' }, ['They left']),
          cell(tenuki.stayedHome, false),
          cell(tenuki.bothAway, true, sameArea),
        ]),
      ]),
    ]),
  ]);
}

/**
 * The best run, with up to two more behind it. Subordinate to the rate on
 * purpose: a streak is the memorable part of a session, but it is a smaller
 * claim than the overall number and must not read as the score.
 */
function streakNote(summary: Summary): string {
  const best: Streak | null = longestStreak(summary);
  if (!best) return '';

  const others: Streak[] = summary.streaks
    .filter((streak) => streak !== best)
    .sort((a, b) => b.length - a.length || a.start - b.start)
    .slice(0, 2);

  const rest: string =
    others.length > 0
      ? `, then ${others.map((streak) => `${streak.length} at ${streak.firstMove}`).join(' and ')}`
      : '';
  return ` · longest run ${best.length} (moves ${best.firstMove}–${best.lastMove})${rest}`;
}

/**
 * How long it took, as a median.
 *
 * The median and not the total: the total is mostly a statement about how
 * long you sat there, while the median says how long a move took to answer,
 * which is the thing that changes as you get better. The rest is in the
 * exports for anyone who wants it.
 */
function timingNote(summary: Summary): string {
  const { timing } = summary;
  return timing === null ? '' : ` · ${duration(timing.medianMs)} a move`;
}

/**
 * Phase rates as bars. Three numbers are exactly the case where a table makes
 * the reader do the comparing: the point is which phase is weakest, and a bar
 * answers that before the labels are read. The counts stay, since a rate over
 * four guesses and one over forty are not the same claim.
 */
function phaseBars(summary: Summary): HTMLElement {
  const rows: HTMLElement[] = summary.phases.map((phase) =>
    el('div', { class: 'bar-row' }, [
      el('span', { class: 'bar-label' }, [phase.phase]),
      el('div', { class: 'bar-track' }, [
        el('div', { class: 'bar-fill', style: `width:${phase.rate * 100}%` }),
      ]),
      el('span', { class: 'bar-value' }, [
        phase.guessed > 0 ? `${percent(phase.rate)} (${phase.hits}/${phase.guessed})` : 'not reached',
      ]),
    ]),
  );

  return el('section', {}, [el('h3', {}, ['By phase']), el('div', { class: 'bars' }, rows)]);
}

/**
 * Where the review is looking: a prediction by index, or `null` for the final
 * position. Null is the slot *after* the last prediction rather than a
 * separate mode — that is what lets "last" mean the end of the game, which is
 * where the review opens and where the session itself left off.
 */
type Cursor = number | null;

/**
 * Where a control would go from here, or `undefined` for nowhere.
 *
 * The two have to be distinguishable, and `null` is already spoken for: it is
 * the final position, a real destination. Collapsing them would leave "no
 * earlier miss" and "go to the end of the game" as the same answer, and the
 * buttons could not tell which of them to disable.
 */
type Target = Cursor | undefined;

/** The nearest miss in `step`'s direction, or undefined if there is none. */
function missFrom(summary: Summary, at: Cursor, step: number): Target {
  const from: number = at === null ? summary.rows.length : at;
  for (let i = from + step; i >= 0 && i < summary.rows.length; i += step) {
    if (!summary.rows[i].hit) return i;
  }
  return undefined;
}

interface NavButton {
  /** Marks the shortcut this button shares, so a key press can reuse it. */
  readonly key: 'first' | 'prevMiss' | 'prev' | 'next' | 'nextMiss' | 'last';
  readonly label: string;
  readonly title: string;
  readonly target: (at: Cursor) => Target;
}

/**
 * The ways through a finished session, in the order they sit on screen: the
 * ends outermost, the misses just inside them, single steps in the middle.
 *
 * Each is a pure "where would this go from here?", which is what lets the
 * panel act on a control and decide whether to disable it from one definition
 * rather than two that can disagree.
 */
function navButtons(summary: Summary): NavButton[] {
  const last: number = summary.rows.length - 1;
  const empty: boolean = summary.rows.length === 0;

  return [
    {
      key: 'first',
      label: '⏮',
      title: 'First prediction (Ctrl+Left)',
      target: (at) => (empty || at === 0 ? undefined : 0),
    },
    {
      key: 'prevMiss',
      label: '◀◀',
      title: 'Previous miss (Shift+Left)',
      target: (at) => missFrom(summary, at, -1),
    },
    {
      key: 'prev',
      label: '◀',
      title: 'Previous (Left)',
      target: (at) => {
        if (at === null) return empty ? undefined : last;
        return at === 0 ? undefined : at - 1;
      },
    },
    {
      key: 'next',
      label: '▶',
      title: 'Next (Right)',
      target: (at) => (at === null ? undefined : at === last ? null : at + 1),
    },
    {
      key: 'nextMiss',
      label: '▶▶',
      title: 'Next miss (Shift+Right)',
      target: (at) => missFrom(summary, at, 1),
    },
    {
      key: 'last',
      label: '⏭',
      title: 'Final position (Ctrl+Right)',
      target: (at) => (at === null ? undefined : null),
    },
  ];
}

/** Which control an arrow key stands for, or undefined if it is not one. */
function shortcutFor(event: KeyboardEvent): NavButton['key'] | undefined {
  if (event.altKey || event.metaKey) return undefined;

  const back: boolean = event.key === 'ArrowLeft';
  if (!back && event.key !== 'ArrowRight') return undefined;

  if (event.ctrlKey) return back ? 'first' : 'last';
  if (event.shiftKey) return back ? 'prevMiss' : 'nextMiss';
  return back ? 'prev' : 'next';
}

/**
 * The summary's board, its caption, its navigation, and the hit/miss strip —
 * one component, because all four read and write the same cursor.
 *
 * The board opens on the final position: the session ends mid-reveal, and a
 * board that simply vanishes takes the game with it. From there the session is
 * walkable by clicking a cell, by the buttons, or by the arrow keys. Walking
 * it by keyboard is the point — reading a run of misses one at a time is the
 * thing the summary is for, and hunting for small cells with a mouse is not.
 *
 * This is the one place a view keeps state of its own. Where the review is
 * looking is not application state — nothing outside this section can observe
 * it, and it should not survive a re-render — so it stays a closure here
 * rather than becoming a screen main.ts has to hold.
 */
function reviewPanel(session: Session, summary: Summary): HTMLElement {
  const board: HTMLElement = el('div', { class: 'board' });
  const caption: HTMLElement = el('p', { class: 'caption muted' });
  const nav: HTMLElement = el('div', { class: 'nav' });
  const strip: HTMLElement = el('div', { class: 'strip' });
  const panel: HTMLElement = el('div', { class: 'review' }, [board, caption, nav, strip]);

  let at: Cursor = null;

  const cells: HTMLElement[] = summary.rows.map((row, index) => {
    const label = `Move ${row.moveNumber}: you ${row.guess}, played ${row.actual}`;
    const cell: HTMLElement = el('button', {
      type: 'button',
      class: `cell ${row.hit ? 'hit' : 'miss'}`,
      title: label,
      'aria-label': label,
    });
    // Clicking the cell already showing steps back out to the final position,
    // so the strip is a toggle and there is no dead end to click out of.
    cell.addEventListener('click', () => go(at === index ? null : index));
    return cell;
  });
  strip.append(...cells);

  const controls: readonly { readonly node: HTMLElement; readonly spec: NavButton }[] =
    navButtons(summary).map((spec) => {
      const node: HTMLElement = el(
        'button',
        { type: 'button', class: 'nav-button', title: spec.title, 'aria-label': spec.title },
        [spec.label],
      );
      node.addEventListener('click', () => follow(spec));
      return { node, spec };
    });
  nav.append(...controls.map((control) => control.node));

  const follow = (spec: NavButton): void => {
    const target: Target = spec.target(at);
    if (target !== undefined) go(target);
  };

  const drawBoard = (): void => {
    if (at === null) {
      renderGoban(finalPosition(session.game), board, { showCoordinates: true });
      const { result } = session.game.meta;
      caption.textContent = result
        ? `Final position — ${result}`
        : 'Final position — the record does not give a result.';
      return;
    }

    const row = summary.rows[at];
    const made: Guess = session.guesses[at];
    const move: GameMove = session.game.moves[row.moveNumber - 1];

    renderGoban(move.after, board, {
      showCoordinates: true,
      markers: made.hit
        ? [{ index: made.actual, kind: 'hit' }]
        : [
            { index: made.actual, kind: 'actual' },
            { index: made.guess, kind: 'guess' },
          ],
    });

    const took: string = row.elapsedMs === null ? '' : ` (${duration(row.elapsedMs)})`;
    const where = `Move ${row.moveNumber} (${at + 1} of ${summary.rows.length})${took}`;
    caption.textContent = made.hit
      ? `${where} — you played ${row.actual}, and so did they.`
      : `${where} — you played ${row.guess}; ${colorName(summary.color)} played ${row.actual}.`;
  };

  const go = (next: Cursor): void => {
    at = next;
    drawBoard();

    cells.forEach((cell, index) => cell.classList.toggle('selected', index === at));
    for (const { node, spec } of controls) {
      node.toggleAttribute('disabled', spec.target(at) === undefined);
    }
  };

  /*
   * Arrow keys are bound on the document rather than on the panel, because a
   * panel you must click before the keys work is a panel whose keys nobody
   * finds. The handler removes itself once its panel is off the page, which
   * happens on the next key press after a re-render — cheap, and it cannot
   * outlive the document the way a forgotten listener would.
   */
  const onKey = (event: KeyboardEvent): void => {
    if (!panel.isConnected) {
      document.removeEventListener('keydown', onKey);
      return;
    }

    const target: EventTarget | null = event.target;
    const typing: boolean =
      target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(target.tagName);
    if (typing) return;

    const key: NavButton['key'] | undefined = shortcutFor(event);
    if (!key) return;

    const spec: NavButton | undefined = controls.find((c) => c.spec.key === key)?.spec;
    if (!spec) return;

    // Only once it is going to act, so an arrow key the review cannot use
    // still scrolls the page.
    if (spec.target(at) === undefined) return;
    event.preventDefault();
    follow(spec);
  };
  document.addEventListener('keydown', onKey);

  go(null);
  return panel;
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

/**
 * What to do next, with the other color first.
 *
 * Playing the opposite side is the interesting replay: every one of those
 * moves has already gone past as an answer, and none of them was ever a
 * question. The same side again is mostly a memory test, so it is offered but
 * not led with.
 *
 * Both labels lead with how the run relates to the one just finished, because
 * that is the actual choice — two buttons reading "Replay as Black" and
 * "Replay as White" make the reader recall which side they just played before
 * they can tell the options apart.
 */
function replayActions(props: SummaryProps): HTMLElement {
  const other: Color = props.summary.color === BLACK ? WHITE : BLACK;

  const replay = (label: string, color: Color, primary: boolean): HTMLElement =>
    button(`${label} — play as ${colorName(color)}`, () => props.onReplay(color), {
      ...(primary ? { class: 'primary' } : {}),
    });

  return el('div', {}, [
    el('div', { class: 'actions' }, [
      replay('Switch sides', other, true),
      replay('Same again', props.summary.color, false),
      button('Study another game', props.onRestart),
    ]),
    // Said once, quietly. Nothing stores scores yet, so there is no number to
    // put an asterisk on — but the second run is a different task either way.
    el('p', { class: 'note' }, [
      'A replay is not comparable to a first run: you have seen the answers.',
    ]),
  ]);
}

/** Taking the result away. The rarer path, so it sits below the replays. */
function exportActions(props: SummaryProps): HTMLElement {
  const { summary } = props;

  return el('div', { class: 'actions' }, [
    button('Download annotated SGF', () =>
      download(
        annotatedFilename(summary),
        annotatedSgf(props.session, summary),
        'application/x-go-sgf',
      ),
    ),
    copyButton('Copy as text', () => toText(summary)),
    copyButton('Copy as JSON', () => toJSON(summary)),
  ]);
}

export function renderSummary(root: HTMLElement, props: SummaryProps): void {
  const { summary } = props;
  const result: Score = summary.score;

  const parts: Child[] = [
    el('h2', {}, ['Session summary']),
    el('p', { class: 'muted' }, [`${summary.game} · played as ${colorName(summary.color)}`]),
  ];

  if (result.guessed > 0) {
    // The rate leads; the raw counts and the best run hang off it. Getting one
    // in five is the headline number, and "of how many" is the qualifier.
    parts.push(
      el('p', { class: 'headline' }, [percent(result.rate)]),
      el('p', { class: 'subhead' }, [
        `${result.hits} of ${result.guessed} correct`,
        streakNote(summary),
        timingNote(summary),
      ]),
    );
  } else {
    parts.push(el('p', { class: 'headline' }, ['No moves predicted.']));
  }

  if (summary.abandoned) {
    parts.push(
      el('p', { class: 'note' }, [
        `Ended early: ${result.guessed} of ${result.total} moves predicted.`,
      ]),
    );
  }

  parts.push(reviewPanel(props.session, summary));

  if (result.guessed > 0) {
    parts.push(phaseBars(summary));
    if (tenukiAgreement(summary.tenuki).scored > 0) parts.push(tenukiMatrix(summary));
  }

  parts.push(replayActions(props), exportActions(props));

  replace(root, ...parts);
}
