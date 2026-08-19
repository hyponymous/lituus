/**
 * Game model: a parsed SGF tree read as one playable game.
 *
 * Reads the main line — the first variation at every branch point — and
 * replays it eagerly, so every move carries the position on both sides of it.
 * The session layer above is then a cursor over an array rather than a second
 * replay engine, which is what makes strictly-forward navigation trivial.
 *
 * This module knows about SGF and about the rules, and nothing about users,
 * guesses, or scoring. Anything needing those belongs in the session layer.
 */

import type { GameTree, Props } from './sgf-parser.ts';
import {
  BLACK,
  EMPTY,
  WHITE,
  createPosition,
  fromStones,
  pass,
  playRecorded,
  toIndex,
  type Color,
  type MoveResult,
  type Position,
} from './rules.ts';

export interface GameMove {
  readonly color: Color;
  /**
   * Board index, or null for a pass. Passes are part of the record and are
   * replayed, but are never a prediction prompt: there is nothing to point at.
   */
  readonly index: number | null;
  /** 1-based, counting passes, as move numbers are conventionally quoted. */
  readonly number: number;
  /** The position immediately before this move — what a guesser sees. */
  readonly before: Position;
  /** The position immediately after it, captures resolved. */
  readonly after: Position;
  /** Indices of stones this move removed from the board. */
  readonly captured: readonly number[];
}

/**
 * Header fields worth showing the user. Every field is optional because SGF
 * in the wild omits any of them; the views must not assume otherwise.
 */
export interface GameMeta {
  readonly blackName?: string;
  readonly blackRank?: string;
  readonly whiteName?: string;
  readonly whiteRank?: string;
  readonly event?: string;
  readonly place?: string;
  readonly date?: string;
  readonly result?: string;
  readonly komi?: string;
  readonly handicap?: number;
  readonly ruleset?: string;
}

export interface Game {
  readonly cols: number;
  readonly rows: number;
  /** The position play starts from: setup and handicap stones already placed. */
  readonly initial: Position;
  readonly moves: readonly GameMove[];
  readonly meta: GameMeta;
  /**
   * Things the reader decided on the user's behalf and should admit to —
   * a collection reduced to its first game, variations left untraversed.
   */
  readonly notes: readonly string[];
}

const DEFAULT_SIZE = 19;
/** Beyond this a board is almost certainly a corrupt SZ rather than a real game. */
const MAX_SIZE = 52;

/** Raised for a file that parses as SGF but is not a game we can run. */
export class GameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameError';
  }
}

function parseSize(root: Props): [number, number] {
  const raw: string = root.SZ?.[0] ?? String(DEFAULT_SIZE);
  const parts: string[] = raw.includes(':') ? raw.split(':') : [raw, raw];
  const [cols, rows] = parts.map(Number);

  for (const n of [cols, rows]) {
    if (!Number.isInteger(n) || n < 2 || n > MAX_SIZE) {
      throw new GameError(`Unsupported board size "${raw}".`);
    }
  }
  return [cols, rows];
}

/**
 * An SGF point ('qd') as a board index. Returns null for a pass — both the
 * empty value and the historical 'tt', which meant a pass on boards up to 19.
 */
export function pointIndex(pos: Position, value: string): number | null {
  if (value === '') return null;
  if (value === 'tt' && pos.cols <= 19 && pos.rows <= 19) return null;

  const col: number = value.charCodeAt(0) - 97;
  const row: number = value.charCodeAt(1) - 97;
  if (!(col >= 0 && col < pos.cols && row >= 0 && row < pos.rows)) return null;
  return toIndex(pos, row, col);
}

/** Apply AB / AW / AE from one node. Returns the same position if none apply. */
function applySetup(pos: Position, props: Props): Position {
  const setup = [
    ['AB', BLACK],
    ['AW', WHITE],
    ['AE', EMPTY],
  ] as const;

  let stones: Int8Array | null = null;
  for (const [prop, value] of setup) {
    for (const point of props[prop] ?? []) {
      const index: number | null = pointIndex(pos, point);
      if (index === null) continue;
      stones ??= Int8Array.from(pos.stones);
      stones[index] = value;
    }
  }
  // Setup is a board edit, not a move, so it clears any pending ko ban.
  return stones ? fromStones(pos.cols, pos.rows, stones) : pos;
}

function readMeta(root: Props): GameMeta {
  const one = (key: string): string | undefined => {
    const value: string | undefined = root[key]?.[0];
    return value !== undefined && value !== '' ? value : undefined;
  };
  const handicap: number = Number(root.HA?.[0] ?? '0');

  return {
    blackName: one('PB'),
    blackRank: one('BR'),
    whiteName: one('PW'),
    whiteRank: one('WR'),
    event: one('EV'),
    place: one('PC'),
    date: one('DT'),
    result: one('RE'),
    komi: one('KM'),
    handicap: Number.isFinite(handicap) && handicap > 1 ? handicap : undefined,
    ruleset: one('RU'),
  };
}

/** The main line as a flat node list: every node, then the first variation. */
function mainLine(tree: GameTree): Props[] {
  const props: Props[] = [];
  for (let node: GameTree | undefined = tree; node; node = node.variations[0]) {
    for (const { props: p } of node.nodes) props.push(p);
  }
  return props;
}

function hasVariations(tree: GameTree): boolean {
  for (let node: GameTree | undefined = tree; node; node = node.variations[0]) {
    if (node.variations.length > 1) return true;
  }
  return false;
}

/**
 * Read parsed SGF trees as one game. Takes the first game of a collection and
 * says so in `notes`, rather than making the user choose before they have seen
 * anything — the PoC studies one game at a time.
 */
export function readGame(trees: readonly GameTree[]): Game {
  const tree: GameTree | undefined = trees[0];
  if (!tree || tree.nodes.length === 0) {
    throw new GameError('The file contains no game.');
  }

  const notes: string[] = [];
  if (trees.length > 1) {
    notes.push(`This file holds ${trees.length} games; studying the first.`);
  }
  if (hasVariations(tree)) {
    notes.push('The record has variations; only the main line is studied.');
  }

  const nodes: Props[] = mainLine(tree);
  const [cols, rows] = parseSize(nodes[0]);
  const meta: GameMeta = readMeta(nodes[0]);

  const moves: GameMove[] = [];
  let position: Position = createPosition(cols, rows);
  let initial: Position | null = null;

  for (const props of nodes) {
    position = applySetup(position, props);

    for (const [prop, color] of [['B', BLACK], ['W', WHITE]] as const) {
      const value: string | undefined = props[prop]?.[0];
      if (value === undefined) continue;

      // The first move fixes the starting position: everything placed up to
      // here — handicap stones included — is where the user begins.
      initial ??= position;

      const before: Position = position;
      const index: number | null = pointIndex(before, value);
      const played: MoveResult = index === null
        ? { position: pass(before), captured: [] }
        : playRecorded(before, index, color);

      position = played.position;
      moves.push({
        color,
        index,
        number: moves.length + 1,
        before,
        after: position,
        captured: played.captured,
      });
    }
  }

  if (moves.length === 0) {
    throw new GameError('The record has no moves to study.');
  }

  return { cols, rows, initial: initial ?? position, moves, meta, notes };
}

/** Moves the given color is asked to predict — every move of theirs but a pass. */
export function promptableMoves(game: Game, color: Color): GameMove[] {
  return game.moves.filter((move) => move.color === color && move.index !== null);
}

/** A short one-line description, for the setup view's header. */
export function describe(game: Game): string {
  const { meta } = game;
  const side = (name?: string, rank?: string): string =>
    [name ?? '?', rank].filter(Boolean).join(' ');
  return `${side(meta.blackName, meta.blackRank)} vs ${side(meta.whiteName, meta.whiteRank)}`;
}
