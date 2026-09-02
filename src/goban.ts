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
import { BLACK, stoneAt, toIndex, toRowCol, type Position } from './rules.ts';

const CELL = 30;
const MARGIN = 34;
const STONE_SCALE = 0.47;
const LABEL_GAP = 9;
const COL_LETTERS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';

const BOARD_FILL = '#dcb483';
const LINE = '#7a5230';
const LABEL = '#5a3a1a';
const BLACK_STONE = '#1a1a1a';
const WHITE_STONE = '#f5f5f0';
const WHITE_EDGE = '#888';

/** Marker colors are chosen to read against wood, black, and white alike. */
const GUESS_MARK = '#d94f4f';
const HIT_MARK = '#1faa5f';
/* Blue for the engine's move, drawn as a filled ghost stone rather than as a
   mark on the wood: that is AI Sensei's blue top move and OGS's suggestion
   circle, so a reader who has used either arrives already knowing it. */
const BEST_MARK = '#1e6fd9';
const BEST_FILL = 'rgba(30, 111, 217, 0.38)';

/**
 * `last` marks the stone most recently played, as a board would by memory.
 * The others belong to the reveal: where the move went, where you guessed.
 */
export type MarkerKind = 'actual' | 'guess' | 'hit' | 'last' | 'best';

export interface Marker {
  readonly index: number;
  readonly kind: MarkerKind;
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

  if (marker.kind === 'best') {
    // Stone-sized, so it reads as the move that could have been played there
    // rather than as an annotation about the point.
    svg.appendChild(
      svgEl('circle', {
        cx: x,
        cy: y,
        r: CELL * 0.42,
        fill: BEST_FILL,
        stroke: BEST_MARK,
        'stroke-width': 1.5,
        class: 'mark mark-best',
      }),
    );
    return;
  }

  if (marker.kind === 'guess') {
    // A cross, which reads clearly on an empty intersection where a ring
    // could be mistaken for a stone.
    const stroke = {
      stroke: GUESS_MARK,
      'stroke-width': 2.5,
      'stroke-linecap': 'round',
      class: 'mark mark-guess',
    };
    svg.appendChild(svgEl('line', { x1: x - size, y1: y - size, x2: x + size, y2: y + size, ...stroke }));
    svg.appendChild(svgEl('line', { x1: x - size, y1: y + size, x2: x + size, y2: y - size, ...stroke }));
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
