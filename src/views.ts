/**
 * The four screens and their controls.
 *
 * Each view renders itself into a container from props and reports user intent
 * through callbacks; none of them owns application state or decides what comes
 * next. That belongs to main.ts, which holds the current screen and re-renders
 * on every change. Views are therefore free to be torn down and rebuilt, which
 * is why they replace their container's contents rather than patching.
 */

import { pointName, renderGoban, type Marker } from './goban.ts';
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
  costAgainst,
  costBand,
  duration,
  longestStreak,
  percent,
  perPrediction,
  signed,
  tenukiAgreement,
  toJSON,
  toText,
  type Baseline,
  type CostBand,
  type PhaseResult,
  type Streak,
  type Summary,
  type SummaryRow,
} from './summary.ts';
import {
  BEAT_MARGIN,
  BLUNDER_LOSS,
  describeEngine,
  type Comparison,
  type Verdict,
} from './analysis.ts';
import { annotatedFilename, annotatedSgf } from './annotate.ts';
import { baselineWanted, setBaselineWanted } from './settings.ts';
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
  /**
   * The fragment of a link that failed to open, if that is why there is an
   * error. It is cleared from the address bar on the way here, so this is the
   * only remaining copy of what the user was sent.
   */
  readonly failedLink?: string;
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
    const banner: Child[] = [el('p', {}, [props.error])];
    if (props.failedLink !== undefined) {
      banner.push(
        el('p', { class: 'muted' }, ['The link you opened:']),
        el('code', { class: 'failed-link' }, [props.failedLink]),
        el('div', { class: 'actions' }, [
          copyButton('Copy the link', () => props.failedLink ?? ''),
        ]),
      );
    }
    parts.push(el('div', { class: 'error', role: 'alert' }, banner));
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
  /** This record as a link, for handing the same game to someone else. */
  readonly challengeLink: () => Promise<string>;
  /** Whether AI scoring is switched on. Off by default (PRD §4). */
  readonly ai: boolean;
  readonly onToggleAi: (on: boolean) => void;
  /** Why this record cannot be scored, if it cannot. Disables the toggle. */
  readonly aiUnavailable: string | null;
  /** Roughly how large the one-time download is, in bytes. */
  readonly aiDownloadBytes: number;
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

/**
 * The AI scoring toggle, with the price on it.
 *
 * Off by default and stated in megabytes, because that is the decision the user
 * is actually making (PRD §4): a first visit should not silently pay for a
 * 37 MB download to step through a professional record. The size is named
 * before the download starts rather than discovered while it runs.
 *
 * When the record cannot be scored the toggle is disabled and the reason is
 * given in the same place. Offering a control that fails afterwards would be
 * worse than not offering it.
 */
function aiOption(props: SetupProps): HTMLElement {
  const box = el('input', { type: 'checkbox', id: 'ai-toggle' }) as HTMLInputElement;
  box.checked = props.ai && props.aiUnavailable === null;
  box.disabled = props.aiUnavailable !== null;
  box.addEventListener('change', () => props.onToggleAi(box.checked));

  const megabytes: number = Math.round(props.aiDownloadBytes / 1_000_000);
  const note: string =
    props.aiUnavailable ??
    `Adds a point-loss estimate to the review. One-time ${megabytes} MB download, ` +
      'cached afterwards; the session starts straight away and scoring catches up.';

  return el('div', { class: 'ai-option' }, [
    el('label', { for: 'ai-toggle' }, [box, el('span', {}, ['Score my guesses against KataGo'])]),
    el('p', { class: 'muted' }, [note]),
  ]);
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

  const aiToggle: HTMLElement = aiOption(props);

  replace(
    root,
    el('h2', {}, [describe(game)]),
    el('p', { class: 'muted' }, [`${game.cols}×${game.rows} board, ${game.moves.length} moves`]),
    ...(rows.length > 0 ? [table] : []),
    ...notes,
    aiToggle,
    el('p', {}, ['Which side do you want to predict?']),
    choices,
    el('div', { class: 'actions' }, [
      copyButton('Copy challenge link', props.challengeLink),
      button('Load a different game', props.onBack),
    ]),
  );
}

// ── Session ──────────────────────────────────────────────────────────────────

export interface SessionProps {
  readonly session: Session;
  readonly onGuess: (index: number) => void;
  /** Predict a pass. There is no point on the board to click for one. */
  readonly onPass: () => void;
  readonly onAdvance: () => void;
  readonly onEnd: () => void;
  /** One line about the engine, or null when scoring is off. */
  readonly engine?: string | null;
  /** True while the engine is still failing, so the line can be styled as such. */
  readonly engineFailed?: boolean;
}

/*
 * Live regions: the two places the engine writes, and the only places in this
 * file a caller may change without a re-render.
 *
 * Everything else here is a pure function of its props, redrawn wholesale on a
 * state change, which is what keeps the views free of an incremental update
 * path to get wrong. The engine is the one thing that does not fit that model:
 * it reports many times a second, on a network timer, with no relation to
 * anything the user did. Redrawing the screen for it was actively harmful —
 * `replaceChildren` destroys the board mid-animation, restarts the reveal, and
 * resets the review cursor a reader was using. So these two nodes are found by
 * id and written in place, and analysis never redraws a screen.
 */
const ENGINE_LINE_ID = 'engine-status';
const STRIP_ID = 'review-strip';

/**
 * The most recent summary the screen has been given, for the parts of it that
 * outlive a render.
 *
 * The summary screen is drawn once and then *updated in place* as late
 * verdicts land (design §5.4), so anything that reads its props at click time
 * rather than at render time is reading a value that has since moved on. The
 * exports were doing exactly that: a session whose searches finished after the
 * summary appeared exported the summary as it looked before they did — every
 * point loss null, no engine block — which is indistinguishable from a session
 * that never had an engine at all.
 *
 * Module-level because `refreshSummaryAnalysis` is a free function: it finds
 * its live regions by id and has no closure to write into. Set on every render
 * so it cannot outlive the screen it describes.
 */
let latestSummary: Summary | null = null;

/** The current summary, falling back to whatever this render was handed. */
function current(fallback: Summary): Summary {
  return latestSummary ?? fallback;
}

/**
 * Redraw the review's selected position, when a verdict for it arrives — or
 * unconditionally, when what the board is measuring from has changed.
 */
let refreshReview: ((force?: boolean) => void) | null = null;

/**
 * What the summary is measuring from, for the whole screen at once.
 *
 * Module-level for the same reason `latestSummary` is: the parts that read it
 * are repainted in place by free functions with no closure to reach into, and
 * the alternative — threading it through every render path — would make the
 * one thing the reader is switching the hardest thing in the file to follow.
 * Set from the stored preference on every render, so it cannot outlive a
 * screen with a stale value.
 */
let baseline: Baseline = 'played';

const FINDINGS_ID = 'engine-findings';
const PHASES_ID = 'summary-phases';
const SUBHEAD_ID = 'summary-subhead';
const HEADLINE_ID = 'summary-headline';

/** Update the session's engine line, if a session is on screen. */
export function updateEngineLine(text: string | null, failed: boolean): void {
  const node: HTMLElement | null = document.getElementById(ENGINE_LINE_ID);
  if (!node) return;
  node.textContent = text ?? '';
  node.className = failed ? 'note' : 'muted engine-line';
  node.hidden = text === null;
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

  /*
   * A pass is nowhere on the board, so it contributes no mark. Two passes
   * leave the board bare, which is the honest picture: the answer is the
   * readout's, and there is nothing to point at. A pass on one side alone
   * still marks the other, so the reader sees the move that does have a place.
   */
  if (made.hit) {
    return made.actual === null ? [] : [{ index: made.actual, kind: 'hit' }];
  }

  const marks: Marker[] = [];
  if (made.actual !== null) marks.push({ index: made.actual, kind: 'actual' });
  if (made.guess !== null) marks.push({ index: made.guess, kind: 'guess' });
  return marks;
}

/** The stone that just appeared, so the renderer can animate it in. */
function sessionAnimate(session: Session): number[] {
  const played: GameMove | null = lastPlayed(session);
  return played?.index != null ? [played.index] : [];
}

function sessionStatus(session: Session): string {
  const result: Score = score(session);
  const running = `${result.hits}/${result.guessed} matched`;

  if (session.phase === 'reveal' && session.lastGuess) {
    const made: Guess = session.lastGuess;
    /*
     * The played move is circled — except when it was a pass, which is nowhere
     * to circle. On those the sentence is the whole answer, so it says what
     * happened rather than pointing at the board.
     */
    const verdict: string = made.hit
      ? made.actual === null
        ? 'The same move — you both passed.'
        : 'The same move.'
      : made.actual === null
        ? 'Not this time — the game passed here.'
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
    // Your guesses are drawn as your own stones, whichever colour you play.
    ghosts: session.color,
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

  /*
   * The reveal advances on its own; Skip is for readers faster than the timer.
   *
   * Pass is an answer, not a way out, and it is placed with the controls
   * because the board has no point to click for one — every other answer is a
   * click on the goban. It is offered only while a prompt is waiting, for the
   * same reason a click on the board is: the reveal must not be pre-empted.
   */
  const controls: Child[] = [
    ...(revealing ? [button('Skip', props.onAdvance)] : [button('Pass', props.onPass)]),
    // Set apart from the two above it, which drive the loop. Leaving is not a
    // move, and it should not sit flush against the control that answers one.
    button('End session', props.onEnd, { class: 'leave' }),
  ];

  replace(
    root,
    el('h2', {}, [describe(session.game)]),
    board,
    progressBar(session),
    el('p', { class: 'readout' }, [sessionStatus(session)]),
    // Unobtrusive by construction: one muted line below the readout, never in
    // the path between the board and the answer (PRD §4).
    // Always present, so the engine has a node to write into without a
    // re-render; hidden until there is something to say.
    el(
      'p',
      {
        id: ENGINE_LINE_ID,
        class: props.engineFailed ? 'note' : 'muted engine-line',
        ...(props.engine ? {} : { hidden: 'hidden' }),
      },
      [props.engine ?? ''],
    ),
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
  /** This record as a link, for handing the same game to someone else. */
  readonly challengeLink: () => Promise<string>;
  readonly onRestart: () => void;
  /**
   * Whether scoring is on, and how to change it *from here*.
   *
   * The summary is where a reader finds out they wanted it: the session is
   * over, the verdicts are the interesting part, and being told to play the
   * game again to get them is the wrong answer. Turning it on asks about every
   * prediction that has no verdict and fills the screen in as they land.
   */
  readonly ai: boolean;
  readonly onToggleAi: (on: boolean) => void;
  /** Why this session cannot be scored, if it cannot. Disables the toggle. */
  readonly aiUnavailable: string | null;
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
 * The clauses under the headline.
 *
 * The exact-match count lives here whether or not an engine ran. Demoting it
 * from the headline is the whole of the de-emphasis PRD §5 asks for: it is
 * still the one number a reader can check by eye, and it should not have to be
 * hunted for.
 */
function subheadNotes(summary: Summary): Child[] {
  const clauses: string[] = [
    `${summary.score.hits} of ${summary.score.guessed} matched`,
    streakNote(summary),
    timingNote(summary),
  ];
  // Joined here rather than by each clause carrying its own separator, so that
  // dropping one does not leave a leading " · " behind.
  return [clauses.filter((clause) => clause !== '').join(' · ')];
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
  const where = `(moves ${best.firstMove}–${best.lastMove})`;
  return `longest run of ${best.length} matches ${where}${rest}`;
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
  return timing === null ? '' : `${duration(timing.medianMs)} a move`;
}

/**
 * The session in one comparison, and what it is a comparison *with*.
 *
 * A bare figure is not a finding. "52%" says nothing without knowing how often
 * the played move can be found at all, and "57.0 points" says nothing without
 * knowing what the game's own moves cost over the same predictions — so the
 * headline is a pair, each half the other's reference, with the unit and the
 * number of predictions written under it.
 *
 * Which half is emphasised is the baseline's to say. Against the engine both
 * sides are distances from perfect play and the pair leads. Against the played
 * move the player is zero by definition, so the difference leads and the pair
 * drops to the line beneath.
 *
 * With no engine the old headline comes back whole: the exact-match rate is
 * the only signal a session has, and it is still one a reader can check by eye
 * (`docs/prd-ai-scoring.md` §5).
 */
function headline(summary: Summary): Child[] {
  const { score, ai } = summary;
  if (score.guessed === 0) return [el('p', { class: 'headline' }, ['No moves predicted.'])];

  const against: Comparison | null = ai?.against ?? null;
  if (!ai || against === null) return [el('p', { class: 'headline' }, [percent(score.rate)])];

  const them: string = colorName(summary.color);
  const across = `across ${against.moves} ${against.moves === 1 ? 'prediction' : 'predictions'}`;
  // Negated, like every figure on this screen: these are losses, and a loss
  // reads negative to a reader (design §6.1).
  const pair: HTMLElement = el('div', { class: 'pair' }, [
    stat(signed(against.yourLoss, 1), 'you'),
    stat(signed(against.playedLoss, 1), them),
  ]);

  /*
   * "Points vs the engine's best" rather than "points given up": a total can
   * come out NEGATIVE — a strong player's moves beat a 50-visit search's own
   * best often enough to show, and the fixture's -6.8 is exactly that — and
   * "gave up -6.8 points" is a sentence that reads as a bug. Naming the
   * comparison instead of the direction is true whichever way the sign falls.
   */
  const versus = `points vs the engine's best`;
  if (baseline === 'engine') {
    return [pair, el('p', { class: 'pair-unit' }, [`${versus}, ${across}`])];
  }

  /*
   * Signed, and the words do not repeat the sign. "+86.5 points better than
   * Black played" says the same thing twice; the sign is the direction and
   * the phrase is the comparison. It also means a level session needs no
   * special case: "+0.4 points vs Black's play" claims nothing.
   */
  const net: number = against.playedLoss - against.yourLoss;
  return [
    el('p', { class: 'headline' }, [signed(-net, 1)]),
    el('p', { class: 'pair-unit' }, [`points vs ${them}'s play, ${across}`]),
    el('p', { class: 'pair-aside muted' }, [
      `${versus}: you ${signed(against.yourLoss, 1)}, ${them} ${signed(against.playedLoss, 1)}.`,
    ]),
  ];
}

/** One half of the headline pair: the figure, and who it belongs to. */
function stat(figure: string, who: string): HTMLElement {
  return el('div', { class: 'stat' }, [
    el('span', { class: 'figure' }, [figure]),
    el('span', { class: 'who' }, [who]),
  ]);
}

/**
 * The engine's findings, in the order a reader cares about them.
 *
 * Beating the game's own move leads, because for an amateur studying a real
 * game it is the single most motivating thing the tool can say, and because it
 * is the finding a bare hit rate actively hides — a "miss" that was the better
 * move reads as a failure until something says otherwise.
 *
 * The standing-missed-move runs come last and get a sentence each. Reported per
 * move they are thirty separate verdicts that all say the same thing; reported
 * once, one of them is usually the most useful line in the review.
 */
function engineFindings(summary: Summary): HTMLElement | null {
  const { ai } = summary;
  if (!ai || ai.answered === 0) return null;

  const notes: Child[] = [];
  const add = (text: string, kind: string): void => {
    notes.push(el('li', { class: `finding finding-${kind}` }, [text]));
  };

  if (ai.beat > 0) {
    add(
      ai.beat === 1
        ? 'Once, your guess was better than the move actually played.'
        : `${ai.beat} times, your guess was better than the move actually played.`,
      'good',
    );
  }
  if (ai.blunders > 0) {
    add(
      `${ai.blunders} ${ai.blunders === 1 ? 'guess' : 'guesses'} cost ${BLUNDER_LOSS} points or more.`,
      'bad',
    );
  }
  if (ai.misleading > 0) {
    // Phrased as a property of the positions rather than a verdict on the
    // player: these are the ones where the natural move is a trap, and the
    // engine can say that without knowing anything about who is guessing.
    add(
      `${ai.misleading} ${ai.misleading === 1 ? 'position' : 'positions'} where the ` +
        `natural-looking move was a trap — you found ${ai.misleadingHits}.`,
      'neutral',
    );
  }
  for (const run of ai.runs) {
    add(
      `Neither of you played ${run.name} in ${run.length} straight chances ` +
        `(moves ${run.firstMove}–${run.lastMove})` +
        (run.everGuessed ? ', though you found it at least once.' : '.'),
      run.everGuessed ? 'neutral' : 'bad',
    );
  }

  if (ai.answered < summary.rows.length) {
    // Said rather than hidden: a median over half a game is not the same claim
    // as a median over the game, and a reader cannot tell from the number.
    add(`Analysed ${ai.answered} of ${summary.rows.length} predictions.`, 'muted');
  }

  /*
   * The section stands even when there is nothing remarkable to say, because
   * the line under it is not a finding — it is the attribution, and it is the
   * only place on screen that says which engine produced the point loss the
   * subhead is quoting. PRD §9 requires a score to carry its engine, and a
   * clean game would otherwise show the figure with nothing behind it.
   *
   * Watching it happen live is what made this obvious: as the last verdicts
   * landed, `answered` reached the number of predictions, the "analysed n of m"
   * note dropped out, and the whole section vanished from under the reader.
   */
  const summarized: Child[] =
    notes.length > 0
      ? [el('ul', {}, notes)]
      : [el('p', { class: 'muted' }, ['Nothing stood out: no blunders, no missed runs.'])];

  return el('section', { class: 'findings' }, [
    el('h3', {}, ['What the engine saw']),
    ...summarized,
    el('p', { class: 'muted engine-note' }, [describeEngine(ai.config)]),
  ]);
}

/**
 * Fill in the summary's engine figures as late verdicts land (design §5.3).
 *
 * Every derived region, and no re-render: the headline, the subhead, the phase
 * bars, the findings section, and the strip's cells, which are repainted in
 * place. The
 * review's cursor is a closure over those cells, so a reader walking a run of
 * misses is not thrown back to the final position because a search finished.
 * Nothing else on the screen is touched.
 */
export function refreshSummaryAnalysis(summary: Summary, remeasured = false): void {
  latestSummary = summary;

  document.getElementById(SUBHEAD_ID)?.replaceChildren(...subheadNotes(summary));
  document.getElementById(HEADLINE_ID)?.replaceChildren(...headline(summary));

  /*
   * The cells are repainted in place rather than rebuilt. The review's cursor
   * is a closure over these nodes, so replacing them would throw a reader back
   * to the final position because a search happened to finish — the third of
   * the three bugs design §5.4 records.
   */
  const strip: HTMLElement | null = document.getElementById(STRIP_ID);
  if (strip) {
    const scored: boolean = summary.ai !== null;
    const found: Set<number> = engineMoves(summary);
    const cells: NodeListOf<HTMLElement> = strip.querySelectorAll('.cell');
    cells.forEach((cell, index) => {
      const row: SummaryRow | undefined = summary.rows[index];
      if (row) dressCell(cell, row, scored, found.has(row.moveNumber));
    });
  }

  // Only if the verdict that just landed is the one being looked at; see
  // `refreshReview`.
  refreshReview?.(remeasured);

  /*
   * The phase bars are rebuilt rather than repainted, which is safe where the
   * strip's cells were not: nothing holds a reference to them, and the section
   * keeps its shape across the update — an engine session draws points-shaped
   * rows from the first paint, filling in as verdicts land.
   */
  const phases: HTMLElement | null = document.getElementById(PHASES_ID);
  phases?.replaceChildren(...phaseSection(summary));

  const slot: HTMLElement | null = document.getElementById(FINDINGS_ID);
  if (!slot) return;
  const findings: HTMLElement | null = engineFindings(summary);
  slot.replaceChildren(...(findings ? [findings] : []));
}

/**
 * The widest figure the phase bars have to draw against.
 *
 * Self-scaled to the session rather than fixed, because there is no natural
 * ceiling here and the real numbers are small: a fixed scale would have to be
 * `BLUNDER_LOSS`, against which every phase would be a stub. So the bars
 * compare phases *within* a session, and the numbers beside them are what
 * compares one session with another.
 *
 * Floored at `BEAT_MARGIN`, so a session where every phase came out level does
 * not draw a full-width bar out of a tenth of a point — and does it with the
 * noise floor the rest of the summary already uses rather than a number
 * invented here.
 */
function phaseCeiling(summary: Summary): number {
  let widest: number = BEAT_MARGIN;
  for (const phase of summary.phases) {
    const per = perPrediction(phase.cost);
    if (per === null) continue;
    widest =
      baseline === 'engine'
        ? Math.max(widest, per.yours, per.played)
        : Math.max(widest, Math.abs(per.yours - per.played));
  }
  return widest;
}

/**
 * A phase's edge as a bar growing from the middle of the track: right when
 * your average was better than the game's own moves, left when it was worse.
 *
 * ALWAYS THE LENGTH THE NUMBER SAYS. The strip's rule — anything inside
 * `BEAT_MARGIN` is a stub on the axis, taking no side — was applied here first
 * and it made a liar of the chart: a phase reading "+0.28" beside a bar of no
 * length is not being cautious, it is showing a value it did not compute. That
 * rule belongs where it came from, on a single move's estimate, where half a
 * point really is the engine's noise floor. A phase average is a different
 * quantity and gets drawn as measured.
 */
function edgeBar(delta: number, ceiling: number): HTMLElement {
  const reach: number = (Math.abs(delta) / ceiling) * 50;
  const better: boolean = delta < 0;
  return el('div', {
    class: `bar-edge ${better ? 'better' : 'worse'}`,
    style: `${better ? 'left' : 'right'}:50%;width:${reach}%`,
  });
}

/**
 * Against the engine there is no edge to draw — nothing beats its own move —
 * so the phase becomes a pair of bars from zero, yours over the game's.
 *
 * The game's bar is what makes the reader's absolute scale legible. On its
 * own, points per prediction says mostly how expensive the phase is: endgame
 * moves are cheap, so a lone bar would report every reader as strongest in the
 * endgame. Beside the same phase's played moves, a short bar means something.
 */
function pairedBars(yours: number, played: number, ceiling: number): HTMLElement[] {
  const width = (points: number): number => Math.max(0, Math.min(1, points / ceiling)) * 100;
  return [
    el('div', { class: 'bar-pair mine', style: `width:${width(yours)}%` }),
    el('div', { class: 'bar-pair theirs', style: `width:${width(played)}%` }),
  ];
}

/**
 * What a phase row says in full, for the tooltip: both sides in the screen's
 * own convention, and the exact-match rate the bar gave its place up to.
 *
 * Not "you gave up 0.29, White -0.02": a verb that carries the direction and a
 * figure that also carries it make a double negative on the second half, where
 * White's *gain* would read as a loss (design §6.1).
 */
function phaseLabel(
  phase: PhaseResult,
  rate: string,
  per: { readonly yours: number; readonly played: number },
  them: string,
): string {
  const moves: number = phase.cost?.moves ?? 0;
  return (
    `${phase.phase}: ${rate}. Average points per prediction vs the engine's best: ` +
    `you ${signed(per.yours, 2)}, ${them} ${signed(per.played, 2)}, ` +
    `across the ${moves} both could be scored.`
  );
}

/**
 * One phase as a bar, in whichever unit the session has.
 *
 * The row keeps the same three slots however it is drawn — label, track, value
 * — so an engine session and a bare one are the same shape, and a phase whose
 * verdicts have not landed yet holds its place rather than appearing later.
 *
 * The figures are MEANS. Both medians are computed mostly over the same
 * entries — on a hit your move is the played move — so with half the
 * predictions matching, their difference is damped toward zero by
 * construction. `perPrediction` records the argument in full.
 */
function phaseBar(phase: PhaseResult, ceiling: number | null, color: Color): HTMLElement {
  const rate: string =
    phase.guessed > 0 ? `${percent(phase.rate)} (${phase.hits}/${phase.guessed})` : 'not reached';
  const per = perPrediction(phase.cost);

  const track: Child[] = [];
  let value: string;
  let label: string;

  if (ceiling === null) {
    value = rate;
    label = `${phase.phase}: ${rate}`;
    track.push(el('div', { class: 'bar-fill', style: `width:${phase.rate * 100}%` }));
  } else if (per === null || phase.cost === null) {
    value = 'not scored';
    label = `${phase.phase}: ${rate}, and nothing the engine could score on both sides`;
    if (baseline === 'played') track.push(el('div', { class: 'bar-axis' }));
  } else if (baseline === 'engine') {
    value = `${signed(per.yours, 2)} · ${signed(per.played, 2)}`;
    label = phaseLabel(phase, rate, per, colorName(color));
    track.push(...pairedBars(per.yours, per.played, ceiling));
  } else {
    /*
     * Two decimals, and not `asChange`: that function calls anything inside
     * `BEAT_MARGIN` noise, which is right for one move's estimate and wrong
     * for a figure derived from a whole phase. `signed` handles the sign, so
     * an edge in your favour reads "+0.43" like every other good number here.
     */
    const delta: number = per.yours - per.played;
    value = signed(delta, 2);
    label = phaseLabel(phase, rate, per, colorName(color));
    track.push(el('div', { class: 'bar-axis' }), edgeBar(delta, ceiling));
  }

  // The tooltip goes on the cells, not the row: `.bar-row` is `display:
  // contents`, so it generates no box of its own to carry one. It is where the
  // exact-match rate lives once the bar is drawn in points.
  const shape: string =
    ceiling === null ? '' : baseline === 'engine' ? ' paired' : ' diverging';
  return el('div', { class: 'bar-row' }, [
    el('span', { class: 'bar-label', title: label }, [phase.phase]),
    el('div', { class: `bar-track${shape}`, title: label }, track),
    el('span', { class: 'bar-value', title: label }, [value]),
  ]);
}

/**
 * Phase results as bars. Three numbers are exactly the case where a table makes
 * the reader do the comparing: the point is which phase is weakest, and a bar
 * answers that before the labels are read.
 *
 * What "weakest" means is the baseline's to decide, and the heading says which
 * question is being answered rather than labelling the axis. The exact-match
 * rate is not dropped, it moves to the row's tooltip, the text export and the
 * JSON — it stays the number a reader can check by eye, and it is not the
 * phase story.
 *
 * The unit is chosen by whether an engine ran, not by whether its numbers have
 * arrived: a section that switched units halfway through a read would be worse
 * than either version of it.
 */
function phaseSection(summary: Summary): Child[] {
  const ceiling: number | null = summary.ai === null ? null : phaseCeiling(summary);
  const rows: HTMLElement[] = summary.phases.map((phase) =>
    phaseBar(phase, ceiling, summary.color),
  );

  /*
   * What is being averaged, not what was done. "Your predictions against
   * Black's moves" describes an activity; the bar is the engine's score for
   * your move set against its score for Black's, averaged over the
   * predictions — which is a different sentence and the true one.
   */
  const them: string = colorName(summary.color);
  const caption: string =
    baseline === 'engine'
      ? `Average points per prediction vs the engine's best, yours over ${them}'s.`
      : `Your average score against ${them}'s, per prediction, as the engine ` +
        'scores them. Right of the line is better.';

  return [
    el('h3', {}, ['By phase']),
    ...(ceiling === null ? [] : [el('p', { class: 'muted bars-caption' }, [caption])]),
    el('div', { class: 'bars' }, rows),
  ];
}

function phaseBars(summary: Summary): HTMLElement {
  return el('section', { id: PHASES_ID }, phaseSection(summary));
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
 * What one strip cell says on hover, and to a screen reader.
 *
 * The numbers are in the label rather than only in the colour: a band is five
 * possible colours and a reader who wants to know *how much* worse has nowhere
 * else to look until they select the cell.
 */
function cellLabel(row: SummaryRow, scored: boolean): string {
  const where = `Move ${row.moveNumber}: you ${row.guess}, played ${row.actual}`;
  if (!scored) return where;

  const delta: number | null = costAgainst(row, baseline);
  if (delta === null) return `${where} — not scored`;

  const against: string = baseline === 'engine' ? 'the engine' : 'the game';
  const band: CostBand = costBand(row, baseline);
  if (band === 'better') return `${where} — ${(-delta).toFixed(1)} points better than ${against}`;
  if (band === 'even') {
    return row.hit && baseline === 'played'
      ? `${where} — the same move`
      : `${where} — the same cost, within half a point`;
  }
  return `${where} — ${delta.toFixed(1)} points worse than ${against}`;
}

/**
 * Paint one cell, preserving whatever the review has done to it.
 *
 * Called both when the strip is built and as late verdicts land, so it may not
 * touch the cursor: `selected` belongs to the panel and survives a repaint.
 */
/**
 * The predictions that were the engine's own move, by move number.
 *
 * Not a field on `SummaryRow`, deliberately: it is a join between two verdict
 * points that the exports already carry separately, and adding it to a row
 * would change the shape of every saved result to save this one computation.
 */
function engineMoves(summary: Summary): Set<number> {
  const found = new Set<number>();
  for (const verdict of summary.verdicts ?? []) {
    if (verdict.guessed?.point === verdict.best.point) found.add(verdict.moveNumber);
  }
  return found;
}

function dressCell(cell: HTMLElement, row: SummaryRow, scored: boolean, engine: boolean): void {
  const selected: boolean = cell.classList.contains('selected');
  const match: string = row.hit ? 'hit' : 'miss';
  const band: CostBand | null = scored ? costBand(row, baseline) : null;

  /*
   * A cell the engine cannot speak for still shows hit or miss, faintly.
   * Dropping to a blank cell would throw away something the session does know
   * — and a summary opened while searches are still running would begin as a
   * row of empty squares and *gain* information as it filled, which is not how
   * it should read.
   */
  const shown: string =
    band === null || band === 'unscored' ? `${band ?? ''} ${match}`.trim() : band;
  // Your move *was* the best move: worth seeing along the whole session, and
  // it does not conflict with the bar, which still measures the comparison.
  const found: string = engine ? ' engine' : '';

  /*
   * The bar's direction and height. Up is cheaper than the game, down is
   * costlier, and the length is the difference in points against a cap of
   * `BLUNDER_LOSS` — past which a bar would say only "off the scale", which the
   * blunder colour already says. Bands inside the noise floor get no direction:
   * they are drawn as a stub on the axis, since half a point of difference is
   * not a claim about which move was better.
   */
  const delta: number | null = band === null ? null : costAgainst(row, baseline);
  const direction: string =
    delta === null || band === 'even' ? '' : delta < 0 ? ' up' : ' down';
  cell.style.setProperty('--h', String(Math.min(1, Math.abs(delta ?? 0) / BLUNDER_LOSS)));

  const label: string = cellLabel(row, scored);
  cell.className =
    `cell ${shown}${found}${direction}${row.hit ? ' exact' : ''}${selected ? ' selected' : ''}`;
  cell.title = label;
  cell.setAttribute('aria-label', label);

  // The bar is a child rather than the button's own background: the button is
  // the click target and stays full height, while the bar is what the reader
  // measures.
  if (!cell.firstElementChild) cell.append(el('span', { class: 'bar' }));
}

/**
 * What a move was worth against the one the game played, as the board writes
 * it: "+0.8" for eight tenths better, "-1.2" for worse, "0" for a difference
 * the product declines to resolve.
 *
 * The reference is the played move rather than the engine's best, because that
 * is what the colour of the mark already measures, and what every bar in the
 * strip below measures. Two scales on one board is one too many.
 *
 * Null when either side is missing: an unmarked ghost is honest about a
 * comparison that cannot be made, where a "0" would not be.
 */
function gainOver(played: number | null, mine: number | null): string | null {
  if (played === null || mine === null) return null;
  const gain: number = played - mine;
  if (Math.abs(gain) < BEAT_MARGIN) return '0';
  return gain > 0 ? `+${gain.toFixed(1)}` : gain.toFixed(1);
}

/**
 * A point loss as the board tools write it: as the change to your score, so a
 * move that cost six points reads "-6.0" rather than "6.0".
 *
 * The sign flips here and nowhere else. `loss` is positive-is-worse throughout
 * the engine and the summary, because it is a difference between two leads and
 * that is the direction the arithmetic runs; a reader looking at a move wants
 * the number KataGo, OGS and AI Sensei would show them, which is the negation.
 *
 * A negative loss is search noise, not a move that beat perfect play
 * (`analysis.ts`), and "+0.1" reads as a broken engine rather than as a
 * rounding error. Anything inside the half-point floor the product already
 * trusts (`BEAT_MARGIN`) is reported as zero. A *larger* negative survives the
 * flip and shows as a gain: that would be a real anomaly, and hiding it would
 * be the same mistake in the other direction.
 */
function asChange(loss: number): string {
  const noise: boolean = loss < 0 ? loss > -BEAT_MARGIN : loss < 0.05;
  // Plain "0", not "0.0": a decimal implies a measurement precise to a tenth,
  // and this is the opposite — the figure the product declines to resolve.
  return noise ? '0' : (-loss).toFixed(1);
}

/**
 * What the engine made of one prediction, as a sentence under the caption.
 *
 * Three facts, in the order a reader asks for them: what your move cost, what
 * the game's move cost, and what the engine would have played instead. The
 * first two are the comparison the whole review is built on and the third is
 * the only one that is new information — so the engine's move comes last, and
 * only when it is neither of the two moves already on the board.
 *
 * A missing number is said rather than skipped. "Not scored" and "cost
 * nothing" are different claims, and a blank would be read as the second.
 */
function costLine(summary: Summary, row: SummaryRow, verdict: Verdict | undefined): string {
  /*
   * Three slots, always in the same order and always the same shape: your
   * move, the game's, the engine's. The sentence this replaces read well on
   * its own and ran to two or three lines, so the board and the chart under it
   * moved every time the cursor did — and a reader stepping through with the
   * arrow keys is looking at precisely the thing that jumped.
   *
   * The words still exist where words belong. `cellLabel` puts a sentence on
   * every cell's tooltip, which is read one at a time and shifts nothing.
   */
  const cost = (loss: number | null): string => (loss === null ? ' —' : ` ${asChange(loss)}`);
  const slots: string[] = [
    `you ${row.guess}${cost(row.loss)}`,
    `${colorName(summary.color)} ${row.actual}${cost(row.playedLoss)}`,
  ];

  // The engine's slot is kept even when it has nothing to say, so that a
  // verdict landing later fills a gap rather than pushing the line wider.
  if (verdict) slots.push(`engine ${pointName(summary.board, verdict.best.point)}`);
  else if (summary.ai !== null) slots.push('engine —');

  return slots.join(' · ');
}

/**
 * The summary's board, its caption, its navigation, and the strip —
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
  const scored: boolean = summary.ai !== null;
  const board: HTMLElement = el('div', { class: 'board' });
  const caption: HTMLElement = el('p', { class: 'caption muted' });
  const cost: HTMLElement = el('p', { class: 'caption cost muted' });
  const nav: HTMLElement = el('div', { class: 'nav' });
  const strip: HTMLElement = el('div', {
    // Bars need a scale, and with no engine there is nothing to scale. The
    // strip stays the flat hit-or-miss ribbon it has always been.
    class: scored ? 'strip chart' : 'strip',
    id: STRIP_ID,
  });
  const panel: HTMLElement = el('div', { class: 'review' }, [board, caption, cost, nav, strip]);

  /**
   * Verdicts by move number, rebuilt from the *current* summary on every draw.
   *
   * Not built once: this panel is never re-rendered — its cursor is a closure
   * and a rebuild would lose it — so a map captured here would still be the
   * empty one an hour into a heal. `summary.verdicts` holds only the answered
   * prompts, which is exactly the set that grows.
   */
  const verdictsNow = (): Map<number, Verdict> =>
    new Map((current(summary).verdicts ?? []).map((one) => [one.moveNumber, one]));

  let at: Cursor = null;
  /** The verdict the caption was last drawn from, so a redraw can be skipped. */
  let shown: Verdict | undefined;

  const found: Set<number> = engineMoves(summary);
  const cells: HTMLElement[] = summary.rows.map((row, index) => {
    const cell: HTMLElement = el('button', { type: 'button' });
    dressCell(cell, row, scored, found.has(row.moveNumber));
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
      cost.textContent = '';
      return;
    }

    const row = current(summary).rows[at];
    const made: Guess = session.guesses[at];
    const move: GameMove = session.game.moves[row.moveNumber - 1];
    const verdict: Verdict | undefined = verdictsNow().get(row.moveNumber);
    shown = verdict;

    /*
     * Blue for the move the game played, red for yours, green for the
     * engine's — the vocabulary OGS and AI Sensei share, so a reader arrives
     * knowing it.
     *
     * A hit is drawn as the played move rather than with the session's green
     * hit ring, because in review green belongs to the engine and one hue
     * cannot mean two things on the same board. Nothing is lost: a hit is the
     * position with a single ring on it, which is what a hit is.
     */
    const live: Summary = current(summary);
    /*
     * The engine's move, where it is a point on the board. A best move that is
     * a pass is numbered past the last intersection, and marking it would put
     * a mark at no intersection at all — most likely now that the end of a
     * game is prompted, which is exactly where the engine wants to pass.
     */
    const bestPoint: number | undefined = verdict?.best.point;
    const best: number | undefined =
      bestPoint !== undefined && bestPoint < live.board.rows * live.board.cols
        ? bestPoint
        : undefined;

    /*
     * Your move, in the colour of how it turned out: a ghost stone where you
     * guessed a point nobody played, and a ring around the stone where you
     * guessed the move the game made. Where it *was* the engine's move it
     * takes the engine's blue, since the two are one move and how it compared
     * with the game is the lesser fact.
     *
     * The number on it is measured from the baseline the reader chose, which
     * is what the colour measures too — one question, asked once. A mark
     * carrying both scales at once would leave no way to tell which is being
     * read; the two losses are in the line under the board, each labelled.
     */
    const band: CostBand | 'engine' | null =
      made.guess === best ? 'engine' : live.ai === null ? null : costBand(row, baseline);
    const gained: string | null =
      baseline === 'engine' ? gainOver(0, row.loss) : gainOver(row.playedLoss, row.loss);
    // A pass has no place on the board, so it carries no mark. What it cost is
    // still in the line under the board, where it is labelled.
    const yours: Marker | null = made.guess === null ? null : {
      index: made.guess,
      kind: 'guess',
      ...(band === null ? {} : { band }),
      ...(gained === null ? {} : { label: gained }),
    };

    /*
     * The played move keeps its contrast ring even on a hit, where your own
     * ring goes around the same stone. The two say different things — this is
     * the move the game made, that is how yours compared — and they are
     * concentric rather than competing.
     */
    const played: string | null = baseline === 'engine' ? gainOver(0, row.playedLoss) : null;
    const marks: Marker[] =
      made.actual === null
        ? []
        : [
            {
              index: made.actual,
              kind: 'actual',
              ...(played === null ? {} : { label: played }),
            },
          ];
    if (yours && (!made.hit || band !== null)) marks.push(yours);

    // The engine's move only when it is a third point: on the guess or on the
    // played stone it is already the mark that is there.
    
    if (best !== undefined && best !== made.actual && best !== made.guess) {
      // The engine's own move gave up nothing, so against the game's move it
      // is worth simply what the game's move cost — and against itself, zero.
      const better: string | null =
        baseline === 'engine' ? '0' : gainOver(row.playedLoss, 0);
      marks.push({ index: best, kind: 'best', ...(better === null ? {} : { label: better }) });
    }

    renderGoban(move.after, board, {
      showCoordinates: true,
      markers: marks,
      ghosts: summary.color,
    });

    // Where you are; the line below says what happened. Which move each side
    // played was in both, and naming it twice is what made the pair wrap.
    const took: string = row.elapsedMs === null ? '' : ` · ${duration(row.elapsedMs)}`;
    caption.textContent = `Move ${row.moveNumber} · ${at + 1} of ${summary.rows.length}${took}`;
    cost.textContent = costLine(current(summary), row, verdict);
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

  /*
   * Redraw the selected position when *its* verdict arrives, and only then.
   * Redrawing on every verdict would rebuild the board a hundred times during
   * a heal, restarting the marker animations under a reader who is not looking
   * at the move that changed.
   */
  refreshReview = (force = false): void => {
    if (!panel.isConnected) {
      refreshReview = null;
      return;
    }
    if (at === null) return;
    const row: SummaryRow | undefined = current(summary).rows[at];
    if (!row) return;
    // A changed baseline changes every mark on the board without changing a
    // single verdict, so it says so rather than being caught by the guard.
    if (!force && verdictsNow().get(row.moveNumber) === shown) return;
    drawBoard();
  };

  go(null);
  return panel;
}

/**
 * Copy to the clipboard, reporting on the button itself so there is no dialog.
 *
 * `text` may return a promise, because a share link has to be compressed
 * before it exists. The promise is started when the screen renders rather
 * than when the button is pressed, so by click time it has long resolved and
 * the write still happens in a microtask off the user's gesture — which is
 * what the stricter clipboard implementations require.
 */
function copyButton(label: string, text: () => string | Promise<string>): HTMLElement {
  const node: HTMLElement = el('button', { type: 'button' }, [label]);

  const flash = (message: string): void => {
    node.textContent = message;
    setTimeout(() => (node.textContent = label), 1200);
  };

  node.addEventListener('click', (): void => {
    void Promise.resolve(text())
      .then((value: string) => navigator.clipboard.writeText(value))
      .then(
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
  // Resolved at click time, never captured: see `latestSummary`. An export is
  // the one thing on this screen that has to be right about verdicts which
  // landed after it was drawn.
  const now = (): Summary => current(props.summary);

  return el('div', { class: 'actions' }, [
    button('Download annotated SGF', () =>
      download(
        annotatedFilename(now()),
        annotatedSgf(props.session, now()),
        'application/x-go-sgf',
      ),
    ),
    copyButton('Copy as text', () => toText(now())),
    copyButton('Copy as JSON', () => toJSON(now())),
    // The plain record, never the annotated one: a challenge link that
    // carried the guesses would arrive with the answers already on it.
    copyButton('Copy challenge link', props.challengeLink),
  ]);
}

/**
 * The two choices a reader can make about the screen they are looking at.
 *
 * Both are about *reading* the session rather than about the session itself,
 * so both live at the top of it and both are remembered (`settings.ts`). The
 * baseline appears only where there is an engine to be a baseline against.
 */
function summaryControls(props: SummaryProps): HTMLElement {
  const { summary } = props;
  const controls: Child[] = [];

  const box = el('input', { type: 'checkbox', id: 'summary-ai' }) as HTMLInputElement;
  box.checked = props.ai && props.aiUnavailable === null;
  box.disabled = props.aiUnavailable !== null;
  box.addEventListener('change', () => props.onToggleAi(box.checked));
  controls.push(
    el('label', { class: 'toggle', for: 'summary-ai', title: props.aiUnavailable ?? '' }, [
      box,
      props.aiUnavailable === null ? 'score with the engine' : `no engine: ${props.aiUnavailable}`,
    ]),
  );

  if (summary.ai !== null) {
    const choose = (which: Baseline, label: string): HTMLElement => {
      const on: boolean = baseline === which;
      const node: HTMLElement = el(
        'button',
        {
          type: 'button',
          class: `segment${on ? ' on' : ''}`,
          'data-baseline': which,
          'aria-pressed': on ? 'true' : 'false',
        },
        [label],
      );
      node.addEventListener('click', () => setBaseline(which));
      return node;
    };
    controls.push(
      el('div', { class: 'segments' }, [
        el('span', { class: 'segments-label' }, ['measured against']),
        choose('played', `${colorName(summary.color)}'s move`),
        choose('engine', 'the engine'),
      ]),
    );
  }

  return el('div', { class: 'summary-controls' }, controls);
}

/**
 * Change what the screen measures from, without rebuilding it.
 *
 * A re-render would be simpler and would throw away the review's cursor, which
 * is a closure over the strip's cells — flipping the baseline while reading
 * move 47 would land the reader back at the final position. So this repaints
 * the same regions a late verdict does, which is a path already proven by
 * every heal.
 */
function setBaseline(next: Baseline): void {
  if (next === baseline) return;
  baseline = next;
  setBaselineWanted(next);

  document.querySelectorAll('.segments .segment').forEach((node) => {
    const on: boolean = node.getAttribute('data-baseline') === next;
    node.classList.toggle('on', on);
    node.setAttribute('aria-pressed', on ? 'true' : 'false');
  });

  // The same repaint a late verdict does; see `refreshSummaryAnalysis`. The
  // flag is what tells the review that the board changed without its verdict
  // changing, which is a thing only a baseline can do.
  if (latestSummary) refreshSummaryAnalysis(latestSummary, true);
}

export function renderSummary(root: HTMLElement, props: SummaryProps): void {
  const { summary } = props;
  const result: Score = summary.score;
  latestSummary = summary;
  baseline = baselineWanted();

  const parts: Child[] = [
    el('h2', {}, ['Session summary']),
    el('p', { class: 'muted' }, [`${summary.game} · played as ${colorName(summary.color)}`]),
    summaryControls(props),
    el('div', { id: HEADLINE_ID }, headline(summary)),
  ];

  if (result.guessed > 0) {
    parts.push(el('p', { id: SUBHEAD_ID, class: 'subhead' }, subheadNotes(summary)));
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
    // A wrapper rather than the section itself, so there is somewhere to write
    // even when there are no findings yet.
    const findings: HTMLElement | null = engineFindings(summary);
    parts.push(el('div', { id: FINDINGS_ID }, findings ? [findings] : []));
    parts.push(phaseBars(summary));
    if (tenukiAgreement(summary.tenuki).scored > 0) parts.push(tenukiMatrix(summary));
  }

  parts.push(replayActions(props), exportActions(props));

  replace(root, ...parts);
}
