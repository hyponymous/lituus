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
  costBand,
  costDelta,
  duration,
  longestStreak,
  percent,
  tenukiAgreement,
  toJSON,
  toText,
  type CostBand,
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

/** Redraw the review's selected position, when a verdict for it arrives. */
let refreshReview: (() => void) | null = null;
const FINDINGS_ID = 'engine-findings';
const SUBHEAD_ID = 'summary-subhead';

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
  const running = `${result.hits}/${result.guessed} matched`;

  if (session.phase === 'reveal' && session.lastGuess) {
    const verdict: string = session.lastGuess.hit
      ? 'The same move.'
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
 * What the engine cost you, as a subordinate line under the hit rate.
 *
 * Subordinate deliberately, and not because engine numbers are unimportant: a
 * hit rate is a number the reader can check by eye and a point loss is not, so
 * exact match keeps the headline and this sits beneath it
 * (`docs/prd-ai-scoring.md` §5).
 *
 * Against the moves actually played, though, rather than alone. A total on its
 * own is a number with nothing to weigh it against — 168 points sounds ruinous
 * until you learn the game gave up 255 over the same moves — and what a reader
 * came to find out is whether they read the board better than the player did.
 * The median leads, for the same reason it does for timing: one catastrophe
 * should not swallow the figure. The difference in the totals follows it,
 * because that is the game's own currency and the more motivating number.
 */
function engineNote(summary: Summary): Child {
  const { ai } = summary;
  if (!ai || ai.graded === 0) return '';

  /*
   * A sentence on its own line, not a fourth clause hung off the subhead with
   * a dot. The other clauses are labels a reader can decode from the number
   * alone — "3.4s a move" needs no help — and this one is not: "0.3 points a
   * move" says nothing about whose points, over what, or whether 0.3 is good.
   * Numbers a reader cannot check by eye have to be told what they are.
   */
  const { against } = ai;
  const sentence: string =
    against === null
      ? `You gave up a median ${ai.medianLoss.toFixed(1)} points a move, ` +
        `${ai.totalLoss.toFixed(0)} in all.`
      : costSentence(against, summary.color);
  return el('span', { class: 'cost-note' }, [sentence]);
}

/**
 * Your median against theirs, then the difference in the totals — signed so
 * that the good direction is the positive one, which is the only way round a
 * reader takes in at a glance.
 */
function costSentence(against: Comparison, color: Color): string {
  const net: number = against.playedLoss - against.yourLoss;
  // Named by colour rather than as "the moves actually played": the reader
  // knows which colour they sat behind, and the record is theirs, not an
  // abstraction.
  const lead: string =
    `You gave up a median ${against.yourMedian.toFixed(1)} points a move, ` +
    `against ${against.playedMedian.toFixed(1)} for ${color === BLACK ? 'Black' : 'White'}`;
  // Under a point either way is a tie, not a result: the same noise floor the
  // bands use, applied to the session rather than to one move.
  if (Math.abs(net) < 1) return `${lead} — level over the session.`;
  return (
    `${lead} — ${Math.abs(net).toFixed(0)} points ` +
    `${net > 0 ? 'fewer' : 'more'} over the session.`
  );
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
 * Three live regions, and no re-render: the subhead's point-loss clause, the
 * findings section, and the strip's cells, which are repainted in place. The
 * review's cursor is a closure over those cells, so a reader walking a run of
 * misses is not thrown back to the final position because a search finished.
 * Nothing else on the screen is touched.
 */
export function refreshSummaryAnalysis(summary: Summary): void {
  latestSummary = summary;

  const subhead: HTMLElement | null = document.getElementById(SUBHEAD_ID);
  if (subhead) {
    subhead.replaceChildren(
      `${summary.score.hits} of ${summary.score.guessed} matched`,
      streakNote(summary),
      timingNote(summary),
      engineNote(summary),
    );
  }

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
  refreshReview?.();

  const slot: HTMLElement | null = document.getElementById(FINDINGS_ID);
  if (!slot) return;
  const findings: HTMLElement | null = engineFindings(summary);
  slot.replaceChildren(...(findings ? [findings] : []));
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
 * What one strip cell says on hover, and to a screen reader.
 *
 * The numbers are in the label rather than only in the colour: a band is five
 * possible colours and a reader who wants to know *how much* worse has nowhere
 * else to look until they select the cell.
 */
function cellLabel(row: SummaryRow, scored: boolean): string {
  const where = `Move ${row.moveNumber}: you ${row.guess}, played ${row.actual}`;
  if (!scored) return where;

  const { loss, playedLoss } = row;
  if (loss === null || playedLoss === null) return `${where} — not scored`;

  const delta: number = loss - playedLoss;
  const band: CostBand = costBand(row);
  if (band === 'better') return `${where} — ${(-delta).toFixed(1)} points better than the game`;
  if (band === 'even') {
    return row.hit ? `${where} — the same move` : `${where} — the same cost, within half a point`;
  }
  return `${where} — ${delta.toFixed(1)} points worse than the game`;
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
  const band: CostBand | null = scored ? costBand(row) : null;

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
  const delta: number | null = band === null ? null : costDelta(row);
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
    const best: number | undefined = verdict?.best.point;

    /*
     * Your move, in the colour of how it turned out: a ghost stone where you
     * guessed a point nobody played, and a ring around the stone where you
     * guessed the move the game made. Where it *was* the engine's move it
     * takes the engine's blue, since the two are one move and how it compared
     * with the game is the lesser fact.
     *
     * The number on it is measured against the move the game played, which is
     * what the colour measures too — one question, asked once. It is not the
     * loss against the engine's best: that is a second scale, and a mark
     * carrying both leaves a reader no way to tell which they are reading. The
     * losses are in the line under the board, where each is labelled.
     */
    const band: CostBand | 'engine' | null =
      made.guess === best ? 'engine' : live.ai === null ? null : costBand(row);
    const gained: string | null = gainOver(row.playedLoss, row.loss);
    const yours: Marker = {
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
    const marks: Marker[] = [{ index: made.actual, kind: 'actual' }];
    if (!made.hit || band !== null) marks.push(yours);

    // The engine's move only when it is a third point: on the guess or on the
    // played stone it is already the mark that is there.
    
    if (best !== undefined && best !== made.actual && best !== made.guess) {
      // The engine's own move gave up nothing, so what it was worth against
      // the game's move is simply what the game's move cost.
      const better: string | null = gainOver(row.playedLoss, 0);
      marks.push({ index: best, kind: 'best', ...(better === null ? {} : { label: better }) });
    }

    renderGoban(move.after, board, { showCoordinates: true, markers: marks });

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
  refreshReview = (): void => {
    if (!panel.isConnected) {
      refreshReview = null;
      return;
    }
    if (at === null) return;
    const row: SummaryRow | undefined = current(summary).rows[at];
    if (!row) return;
    if (verdictsNow().get(row.moveNumber) === shown) return;
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

export function renderSummary(root: HTMLElement, props: SummaryProps): void {
  const { summary } = props;
  const result: Score = summary.score;
  latestSummary = summary;

  const parts: Child[] = [
    el('h2', {}, ['Session summary']),
    el('p', { class: 'muted' }, [`${summary.game} · played as ${colorName(summary.color)}`]),
  ];

  if (result.guessed > 0) {
    // The rate leads; the raw counts and the best run hang off it. Getting one
    // in five is the headline number, and "of how many" is the qualifier.
    parts.push(
      el('p', { class: 'headline' }, [percent(result.rate)]),
      el('p', { id: SUBHEAD_ID, class: 'subhead' }, [
        `${result.hits} of ${result.guessed} matched`,
        streakNote(summary),
        timingNote(summary),
        engineNote(summary),
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
