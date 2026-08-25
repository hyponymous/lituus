/**
 * Build a benchmark fixture: real positions from the corpus, in the shape the
 * web-katrain engine expects.
 *
 * Timing depends on how full the board is — an empty board has 361 legal
 * moves to expand and an endgame position has a fraction of that — so the
 * fixture samples several stages of a game rather than one.
 *
 *   node experiments/browser/make-positions.ts <game.sgf> <out.json>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse } from '../../src/sgf-parser.ts';
import { readGame, type Game, type GameMove } from '../../src/game.ts';
import { stoneAt, toRowCol } from '../../src/rules.ts';

/** Fractions through the game to sample, so the mix spans opening to endgame. */
const STAGES: readonly number[] = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85];
/** How much move history to hand the engine; it uses the most recent few. */
const HISTORY = 8;

type Player = 'black' | 'white';
type Intersection = Player | null;

interface BenchPosition {
  readonly label: string;
  readonly board: Intersection[][];
  readonly currentPlayer: Player;
  readonly moveHistory: Array<{ x: number; y: number; player: Player }>;
}

const playerOf = (color: number): Player => (color === 1 ? 'black' : 'white');

function boardOf(game: Game, move: GameMove): Intersection[][] {
  const pos = move.before;
  const board: Intersection[][] = [];
  for (let y = 0; y < pos.rows; y++) {
    const row: Intersection[] = [];
    for (let x = 0; x < pos.cols; x++) {
      const stone: number = stoneAt(pos, y * pos.cols + x);
      row.push(stone === 0 ? null : playerOf(stone));
    }
    board.push(row);
  }
  return board;
}

function historyOf(game: Game, upto: number): BenchPosition['moveHistory'] {
  const out: BenchPosition['moveHistory'] = [];
  for (let i = Math.max(0, upto - HISTORY); i < upto; i++) {
    const m: GameMove = game.moves[i];
    // A pass is (-1,-1) by the engine's convention.
    const [row, col] = m.index === null ? [-1, -1] : toRowCol(m.before, m.index);
    out.push({ x: col, y: row, player: playerOf(m.color) });
  }
  return out;
}

const [sgfPath, outPath] = process.argv.slice(2);
if (!sgfPath || !outPath) throw new Error('usage: make-positions.ts <game.sgf> <out.json>');

const game: Game = readGame(parse(readFileSync(sgfPath, 'utf8')));
if (game.cols !== game.rows) throw new Error('benchmark expects a square board');

const promptable: GameMove[] = game.moves.filter((m) => m.index !== null);
const positions: BenchPosition[] = STAGES.map((fraction) => {
  const move: GameMove = promptable[Math.floor(fraction * (promptable.length - 1))];
  const turn: number = game.moves.indexOf(move);
  return {
    label: `move-${move.number}`,
    board: boardOf(game, move),
    currentPlayer: playerOf(move.color),
    moveHistory: historyOf(game, turn),
  };
});

const komi: number = Number(game.meta.komi);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({
  source: sgfPath.split('/').pop(),
  boardSize: game.cols,
  komi: Number.isFinite(komi) ? komi : 6.5,
  rules: 'japanese',
  positions,
}));

const stones: number[] = positions.map((p) => p.board.flat().filter(Boolean).length);
console.error(`${outPath}: ${positions.length} positions on ${game.cols}x${game.cols}, ` +
  `${stones.join('/')} stones`);
