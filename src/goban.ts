/**
 * Board renderer: draws a Position as SVG, reports clicks, and overlays
 * markers.
 *
 * Adapted from kifu (https://github.com/hyponymous/kifu), src/goban.ts. The
 * grid, star points, and coordinate labels follow it closely; the entry point
 * does not. kifu renders a game tree cropped to a viewport around the stones,
 * which suits sharing a diagram. Here the board is always drawn whole, from a
 * position the rules engine produced, because a player reads a position
 * against the whole board and a cropped one would move under them as the game
 * spreads. See docs/reuse-notes.md.
 */
import { BLACK, EMPTY, stoneAt, toIndex, toRowCol, type Position } from './rules.ts';

const CELL = 30;
const MARGIN = 34;
const STONE_SCALE = 0.47;
const LABEL_GAP = 9;
const COL_LETTERS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';

const BOARD_FILL = '#dcb483';
const LINE = '#7a5230';
const LABEL = '#5a3a1a';
const BLACK_STONE = '#1a1a1a';
/** Numbers inside a ghost stone, dark enough to read over any of its fills. */
const LABEL_TEXT = '#241f18';
const WHITE_STONE = '#f5f5f0';
const WHITE_EDGE = '#888';

/** Marker colors are chosen to read against wood, black, and white alike. */
const HIT_MARK = '#1faa5f';
/* Blue for the engine's move, drawn as a filled ghost stone rather than as a
   mark on the wood: that is AI Sensei's blue top move and OGS's suggestion
   circle, so a reader who has used either arrives already knowing it. */
const BEST_MARK = '#1e6fd9';

/**
 * A guess is drawn in the colour of how it turned out, matching the strip's
 * bands below the board — one palette for one meaning, so a reader learns it
 * once. The hues are the strip's, retuned for wood: the page's own values are
 * chosen against a light or dark ground, and this one is neither.
 *
 * The undecided case is a plain grey ghost, which is what a guess looks like
 * before an engine has an opinion about it — and what every guess looks like
 * when there is no engine at all.
 */
const BAND_MARKS: Record<string, string> = {
  better: '#2f8a55',
  even: '#6f665a',
  worse: '#c08a2e',
  blunder: '#a5382a',
  unscored: '#6f665a',
  none: '#6f665a',
  // A guess that *was* the engine's move takes the engine's blue: the two are
  // one move, and colouring it by how it compared with the game would bury the
  // better fact.
  engine: BEST_MARK,
};

/** A ghost stone's fill: opaque enough to carry a number, not quite a stone. */
function ghost(color: string): string {
  return `${color}c4`;
}

/**
 * `last` marks the stone most recently played, as a board would by memory.
 * The others belong to the reveal: where the move went, where you guessed.
 */
export type MarkerKind = 'actual' | 'guess' | 'hit' | 'last' | 'best';

export interface Marker {
  readonly index: number;
  readonly kind: MarkerKind;
  /**
   * For a guess: how it compared with the move the game played, which decides
   * its colour. Absent where nothing has judged it.
   */
  readonly band?: 'better' | 'even' | 'worse' | 'blunder' | 'unscored' | 'engine';
  /**
   * Points this move was worth against the one the game played, written inside
   * the mark. The caller formats it: what the number means is the summary's
   * business, and how it is drawn is this module's. Ignored on an occupied
   * point, where there is a stone rather than a ghost to write on.
   */
  readonly label?: string;
}

export interface GobanOptions {
  readonly markers?: readonly Marker[];
  /** Called with the board index of the intersection clicked. */
  readonly onPoint?: (index: number) => void;
  readonly showCoordinates?: boolean;
  /**
   * Board indices whose stones are newly placed. They get a class the
   * stylesheet animates, so the eye is drawn to what changed rather than
   * having to diff the board. Everything else is drawn static.
   */
  readonly animate?: readonly number[];
  /**
   * Hold those stones back for a beat before they appear. Used when revealing
   * a miss: the played move puts a stone on the board, so letting it land
   * immediately would answer the question before the user has read their own
   * guess. The stylesheet owns the length of the beat.
   */
  readonly animateLate?: boolean;
}

/**
 * Star points for square boards; rectangular boards get none.
 * N < 5: none; 5–8: center if odd; 9–18: corners plus center if odd;
 * >= 19: the full 3x3 grid.
 */
export function hoshiPoints(size: number): [number, number][] {
  if (size < 5) return [];
  const corner: number = size >= 13 ? 3 : 2;
  const far: number = size - 1 - corner;
  const mid: number = (size - 1) / 2;
  const hasCenter: boolean = Number.isInteger(mid);

  if (size <= 8) return hasCenter ? [[mid, mid]] : [];

  const corners: [number, number][] = [
    [corner, corner],
    [corner, far],
    [far, corner],
    [far, far],
  ];
  if (size <= 18) return hasCenter ? [...corners, [mid, mid]] : corners;

  const lines: number[] = hasCenter ? [corner, mid, far] : [corner, far];
  return lines.flatMap((row) => lines.map((col): [number, number] => [row, col]));
}

/**
 * Human-readable name of a point, e.g. "Q16".
 *
 * An index that is not a point on this board reads as "pass", which is what
 * one always is in practice: the engine numbers a pass just past the last
 * intersection. The arithmetic below would otherwise have named it "A0" — a
 * plausible-looking name for no point at all, which `pointFromName` then
 * refuses, so an exported variation containing one came back shorter than it
 * went out. "pass" is refused by the same reader, and says what it is.
 */
export function pointName(pos: Position, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= pos.rows * pos.cols) return 'pass';
  const [row, col] = toRowCol(pos, index);
  return `${COL_LETTERS[col] ?? '?'}${pos.rows - row}`;
}

/**
 * The inverse of `pointName`: "Q16" back to a board index, null if that is not
 * a point on this board. Kept beside its inverse so the two cannot drift apart
 * — a round trip through the two is the only thing that reads an exported
 * result back in.
 */
export function pointFromName(pos: Position, name: string): number | null {
  const col: number = COL_LETTERS.indexOf(name.slice(0, 1).toUpperCase());
  const row: number = pos.rows - Number(name.slice(1));

  if (col < 0 || col >= pos.cols) return null;
  if (!Number.isInteger(row) || row < 0 || row >= pos.rows) return null;
  return toIndex(pos, row, col);
}

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el: SVGElement = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}

function centerX(col: number): number {
  return MARGIN + col * CELL;
}

function centerY(row: number): number {
  return MARGIN + row * CELL;
}

function drawGrid(svg: SVGElement, pos: Position): void {
  const width: number = (pos.cols - 1) * CELL;
  const height: number = (pos.rows - 1) * CELL;
  const stroke = { stroke: LINE, 'stroke-width': 0.8 };

  for (let col = 0; col < pos.cols; col++) {
    svg.appendChild(
      svgEl('line', { x1: centerX(col), y1: MARGIN, x2: centerX(col), y2: MARGIN + height, ...stroke }),
    );
  }
  for (let row = 0; row < pos.rows; row++) {
    svg.appendChild(
      svgEl('line', { x1: MARGIN, y1: centerY(row), x2: MARGIN + width, y2: centerY(row), ...stroke }),
    );
  }
}

function drawHoshi(svg: SVGElement, pos: Position): void {
  if (pos.cols !== pos.rows) return;
  for (const [row, col] of hoshiPoints(pos.cols)) {
    svg.appendChild(svgEl('circle', { cx: centerX(col), cy: centerY(row), r: 3, fill: LINE }));
  }
}

function drawCoordinates(svg: SVGElement, pos: Position): void {
  const radius: number = CELL * STONE_SCALE;

  for (let col = 0; col < pos.cols; col++) {
    const text: SVGElement = svgEl('text', {
      x: centerX(col),
      y: MARGIN - radius - LABEL_GAP,
      'text-anchor': 'middle',
      'font-size': 11,
      fill: LABEL,
    });
    text.textContent = COL_LETTERS[col] ?? '';
    svg.appendChild(text);
  }

  for (let row = 0; row < pos.rows; row++) {
    const text: SVGElement = svgEl('text', {
      x: MARGIN - radius - LABEL_GAP,
      y: centerY(row) + 4,
      'text-anchor': 'end',
      'font-size': 11,
      fill: LABEL,
    });
    text.textContent = String(pos.rows - row);
    svg.appendChild(text);
  }
}

function drawStones(
  svg: SVGElement,
  pos: Position,
  fresh: ReadonlySet<number>,
  late: boolean,
): void {
  const radius: number = CELL * STONE_SCALE;

  for (let row = 0; row < pos.rows; row++) {
    for (let col = 0; col < pos.cols; col++) {
      const point: number = stoneAt(pos, toIndex(pos, row, col));
      if (point === 0) continue;

      const attrs: Record<string, string | number> = {
        cx: centerX(col),
        cy: centerY(row),
        r: radius,
        fill: point === BLACK ? BLACK_STONE : WHITE_STONE,
      };
      if (point !== BLACK) {
        attrs.stroke = WHITE_EDGE;
        attrs['stroke-width'] = 0.8;
      }
      if (fresh.has(toIndex(pos, row, col))) {
        attrs.class = late ? 'stone-new stone-late' : 'stone-new';
      }
      svg.appendChild(svgEl('circle', attrs));
    }
  }
}

function drawMarker(svg: SVGElement, pos: Position, marker: Marker): void {
  const [row, col] = toRowCol(pos, marker.index);
  const x: number = centerX(col);
  const y: number = centerY(row);
  const size: number = CELL * 0.26;

  if (marker.kind === 'last') {
    // A dot on the stone itself, in the opposite color so it reads on either.
    // Smaller and quieter than the reveal marks: it is orientation, not an
    // answer, and it must not compete with them for attention.
    const fill: string = stoneAt(pos, marker.index) === BLACK ? WHITE_STONE : BLACK_STONE;
    svg.appendChild(
      svgEl('circle', { cx: x, cy: y, r: CELL * 0.13, fill, class: 'mark mark-last' }),
    );
    return;
  }

  /*
   * A move that was not played is a ghost stone, carrying what it was worth.
   * This is the review tools' idiom and it says two things at once — where the
   * move was, and what it cost — where a mark on the wood said only the first.
   *
   * The cross this replaces was a verdict: red, on the guess, whether or not
   * the guess was any good. Once a guess can beat the game that reading is
   * simply wrong, and the colour is better spent on the answer.
   */
  if (marker.kind === 'best' || marker.kind === 'guess') {
    const color: string =
      marker.kind === 'best' ? BEST_MARK : BAND_MARKS[marker.band ?? 'none'];

    /*
     * On an occupied point the ghost becomes a ring: the move is already there
     * as a stone, and a translucent disc over it would only muddy the stone's
     * own colour. That is what a hit looks like — your move and the game's
     * move are one stone, ringed in the colour of how it turned out.
     */
    const played: boolean = stoneAt(pos, marker.index) !== EMPTY;

    svg.appendChild(
      svgEl('circle', {
        cx: x,
        cy: y,
        r: CELL * STONE_SCALE,
        fill: played ? 'none' : ghost(color),
        stroke: color,
        // Your move is the one you are looking for on the board, so it is the
        // one drawn heavily. The engine's is an answer to it, and reads as one.
        'stroke-width': marker.kind === 'guess' ? 3 : 1,
        class: `mark mark-${marker.kind}`,
      }),
    );

    if (marker.label !== undefined && !played) {
      /*
       * As large as the label allows, which is the point of it: a number too
       * small to read at a glance is a number the reader ignores. Long labels
       * ("+10.5") step down rather than spilling the stone.
       */
      const scale: number = marker.label.length <= 2 ? 0.5 : marker.label.length <= 4 ? 0.42 : 0.34;
      const text: SVGElement = svgEl('text', {
        x,
        y,
        fill: LABEL_TEXT,
        'font-size': CELL * scale,
        'font-weight': 700,
        'font-family': 'system-ui, sans-serif',
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        class: `mark mark-${marker.kind}-label`,
      });
      text.textContent = marker.label;
      svg.appendChild(text);
    }
    return;
  }

  /*
   * The move the game played is ringed in whichever stone colour it is not,
   * the way every board tool marks the move on the board — and the way the
   * `last` dot above already does it. It needs no colour of its own: it always
   * sits on a stone, and the contrast is what makes it visible. That also
   * leaves blue free to mean the engine, which is where the reader's eye goes
   * looking for it.
   */
  const stroke: string =
    marker.kind === 'hit'
      ? HIT_MARK
      : stoneAt(pos, marker.index) === BLACK
        ? WHITE_STONE
        : BLACK_STONE;

  svg.appendChild(
    svgEl('circle', {
      cx: x,
      cy: y,
      r: size,
      fill: 'none',
      stroke,
      'stroke-width': 2.5,
      class: `mark mark-${marker.kind}`,
    }),
  );
}

/**
 * Transparent click targets, one per intersection. Cheap at a few hundred
 * rects, and it puts hit-testing in the browser's hands rather than ours.
 */
function drawHitTargets(svg: SVGElement, pos: Position, onPoint: (index: number) => void): void {
  const half: number = CELL / 2;

  for (let row = 0; row < pos.rows; row++) {
    for (let col = 0; col < pos.cols; col++) {
      const rect: SVGElement = svgEl('rect', {
        x: centerX(col) - half,
        y: centerY(row) - half,
        width: CELL,
        height: CELL,
        fill: 'transparent',
        style: 'cursor:pointer',
      });
      const index: number = toIndex(pos, row, col);
      rect.addEventListener('click', () => onPoint(index));
      svg.appendChild(rect);
    }
  }
}

export function renderGoban(pos: Position, container: HTMLElement, opts: GobanOptions = {}): void {
  const width: number = (pos.cols - 1) * CELL + MARGIN * 2;
  const height: number = (pos.rows - 1) * CELL + MARGIN * 2;

  const svg: SVGElement = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width: '100%',
    style: 'display:block',
  });

  svg.appendChild(svgEl('rect', { x: 0, y: 0, width, height, fill: BOARD_FILL }));
  drawGrid(svg, pos);
  drawHoshi(svg, pos);
  if (opts.showCoordinates !== false) drawCoordinates(svg, pos);
  drawStones(svg, pos, new Set(opts.animate ?? []), opts.animateLate === true);

  for (const marker of opts.markers ?? []) drawMarker(svg, pos, marker);
  if (opts.onPoint) drawHitTargets(svg, pos, opts.onPoint);

  container.replaceChildren(svg);
}
