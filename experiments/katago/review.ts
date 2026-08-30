/**
 * Write the playthrough back out as an SGF: the game as it went, with every
 * guess attached as a variation and the engine's verdict in the comments.
 *
 *   node experiments/katago/review.ts --play <playthrough.json> \
 *     --stem experiments/out/dogfood/<name> \
 *     --out experiments/out/dogfood/<name>-review.sgf <game.sgf>
 *
 * The numbers are already in the JSONL, but a table of coordinates is not how
 * anyone reviews a game. Any SGF reader will step through this one, and the
 * guess sits at the point it was made, next to what was actually played.
 *
 * Two things earn a comment: a guess that beat or lost to the game by enough
 * points to be worth a sentence, and a move — either player's — expensive
 * enough that the reader should see how it was punished. Everything else is
 * left quiet, because a comment on every prompt is a comment on nothing.
 *
 * Scores are signed from the guessing player's point of view: `+0.4` is four
 * tenths of a point to the good, `-3.1` is three points thrown away. The
 * alternative — "lost 3.1" in prose — was unambiguous but unreadable in a
 * column of thirty.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse, type GameTree, type GameNode, type Props } from '../../src/sgf-parser.ts';
import { serialize } from '../../src/sgf-writer.ts';
import { readGame, type Game } from '../../src/game.ts';
import { toRowCol } from '../../src/rules.ts';
import { fromGtp, toGtp } from './coords.ts';

const HIGHLIGHTS = 3;
/**
 * How many points a move has to be worth before it is worth a sentence.
 * Three is the threshold the rest of this work treats as a real mistake.
 */
const MIN_EDGE = 3;
const SGF_LETTERS = 'abcdefghijklmnopqrstuvwxyz';

interface PlayRow { move: number; guess: string; actual: string; hit: boolean; ms: number; phase: string }
interface GuessRow { turn: number; guess: string; hit: boolean; guessLoss: number; guessPv?: string[] }
interface RefRow { turn: number; pointLoss: number | null; best: string; bestPv?: string[]; playedPv?: string[] }
interface DeepRow { turn: number; visits: number; playedPv?: string[]; guessPv?: string[] }

const load = <T,>(path: string): T[] =>
  readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);

function parseArgs(argv: readonly string[]): {
  play: string; stem: string; out: string; minEdge: number; file: string;
} {
  const flags = new Map<string, string>();
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags.set(argv[i].slice(2), argv[++i]);
    else files.push(argv[i]);
  }
  const play: string | undefined = flags.get('play');
  const stem: string | undefined = flags.get('stem');
  const out: string | undefined = flags.get('out');
  if (!play || !stem || !out || files.length !== 1) {
    throw new Error(
      'usage: review.ts --play <play.json> --stem <out stem> --out <file.sgf>' +
      ' [--min-edge <points>] <game.sgf>',
    );
  }
  return {
    play, stem, out, minEdge: Number(flags.get('min-edge') ?? MIN_EDGE), file: files[0],
  };
}

const { play, stem, out, minEdge, file } = parseArgs(process.argv.slice(2));
const game: Game = readGame(parse(readFileSync(file, 'utf8')) as GameTree[]);
const source: Props = (parse(readFileSync(file, 'utf8'))[0]?.nodes[0]?.props) ?? {};
const doc = JSON.parse(readFileSync(play, 'utf8')) as { moves: PlayRow[]; color: string; rate: number; hits: number; prompts: number };

const guesses = new Map(load<GuessRow>(`${stem}-guesses.jsonl`).map((r) => [r.turn, r]));
const refs = new Map(load<RefRow>(`${stem}-ref.jsonl`).map((r) => [r.turn, r]));
const fix = new Map(load<{ turn: number; pointLoss: number }>(`${stem}-backfill.jsonl`).map((r) => [r.turn, r.pointLoss]));
// Optional: a longer, better-searched line for the few moves that earned one.
const deepPath = `${stem}-deep.jsonl`;
const deep = new Map(existsSync(deepPath) ? load<DeepRow>(deepPath).map((r) => [r.turn, r]) : []);
/**
 * The backfill comes first. It exists precisely because the tree figure was
 * missing *or* came from a handful of visits, so a non-null tree figure is
 * not evidence it is the better one — in the endgame it is routinely a
 * one-visit guess off by ten points.
 */
const playedLoss = (turn: number): number =>
  fix.get(turn) ?? refs.get(turn)?.pointLoss ?? NaN;

/** SGF names a point by column letter then row letter, row 0 at the top. */
function toSgf(index: number | null): string {
  if (index === null) return '';
  const [row, col] = toRowCol(game.initial, index);
  return `${SGF_LETTERS[col]}${SGF_LETTERS[row]}`;
}

const rows = doc.moves
  .map((r) => {
    const g: GuessRow | undefined = guesses.get(r.move - 1);
    // On a hit the guess *is* the played move, so there is one move and it
    // gets one number — the forced one, which had the whole budget spent on
    // it. Reading the tree as well would print two values for one move, and
    // the tree's can come from a single visit.
    const lost: number = r.hit ? (g?.guessLoss ?? NaN) : playedLoss(r.move - 1);
    return g && Number.isFinite(lost)
      ? { ...r, turn: r.move - 1, g, lost, edge: lost - g.guessLoss }
      : null;
  })
  .filter((r): r is NonNullable<typeof r> => r !== null);
type Row = typeof rows[0];

const at = new Map<number, Row>(rows.map((r) => [r.turn, r]));

// "Better" and "worse" are only meaningful where the guess differed.
const misses = rows.filter((r) => !r.hit);
const ranked = [...misses].sort((a, b) => b.edge - a.edge);
const best = ranked.slice(0, HIGHLIGHTS);
const worst = ranked.slice(-HIGHLIGHTS).reverse();
const note = new Map<number, 'better' | 'worse'>();
for (const r of best) note.set(r.turn, 'better');
for (const r of worst) if (!note.has(r.turn)) note.set(r.turn, 'worse');

/** Points from the guessing player's side: positive is good, negative is lost. */
function signed(loss: number): string {
  const v: number = -loss;
  return `${v < -0.05 ? '-' : '+'}${Math.abs(v).toFixed(1)}`;
}

/**
 * The guess measured against the move the game played: positive means the
 * guess was the better of the two. This is already a difference, not a loss,
 * so it does not get flipped the way `signed` flips one.
 */
function delta(edge: number): string {
  return `${edge < -0.05 ? '-' : '+'}${Math.abs(edge).toFixed(1)}`;
}

/** `7. M3  8. Q5  9. R4` — a line a reader can follow against the board. */
function numbered(firstMove: number, line: readonly string[]): string {
  return line.map((m, i) => `${firstMove + i}. ${m}`).join('  ');
}

/** The move the game actually answered with, or undefined past the end. */
function playedAt(turn: number): string | undefined {
  const move = game.moves[turn];
  return move && move.index !== null ? toGtp(game.initial, move.index) : undefined;
}

const guessPvOf = (r: Row): readonly string[] => deep.get(r.turn)?.guessPv ?? r.g.guessPv ?? [];
const playedPvOf = (r: Row): readonly string[] =>
  deep.get(r.turn)?.playedPv ?? refs.get(r.turn)?.playedPv ?? [];

/**
 * A line, played out on the board rather than left as a single stone.
 *
 * The first move of a principal variation is the move it belongs to, so the
 * whole line can be laid down as-is, colors alternating from the mover. `MN`
 * on the first node tells the reader where in the game this branch sits;
 * without it most readers number a variation from one.
 */
function lineNodes(
  startTurn: number, startColor: number, line: readonly string[], comment?: string,
): GameNode[] {
  const nodes: GameNode[] = [];
  for (const [ply, move] of line.entries()) {
    const index: number | null = fromGtp(game.initial, move);
    // A pass mid-variation, or a coordinate this board has no point for,
    // ends the line rather than being guessed at.
    if (index === null) break;
    const color = ply % 2 === 0 ? startColor : -startColor;
    const props: Props = { [color === 1 ? 'B' : 'W']: [toSgf(index)] };
    if (ply === 0) {
      props.MN = [String(startTurn + 1)];
      if (comment !== undefined) props.C = [comment];
    }
    nodes.push({ props });
  }
  return nodes;
}

/**
 * The guess, and — if it was expensive — how the engine punishes it.
 *
 * A refutation is only worth showing when there is something to refute, so a
 * guess that cost nothing is left as the single stone it was.
 */
function guessTree(r: Row): GameTree {
  const pv: readonly string[] = guessPvOf(r);
  const refute: boolean = r.g.guessLoss >= minEdge && pv.length > 1;
  const line: readonly string[] = refute ? pv : [r.guess];
  const head = `Your guess ${r.guess}: ${delta(r.edge)} vs actual game ` +
    `(${signed(r.g.guessLoss)} vs ${signed(r.lost)})`;
  const tree: GameTree = {
    nodes: lineNodes(r.turn, game.moves[r.turn].color, line, head), variations: [],
  };
  if (refute && tree.nodes.length > 1) {
    const shown: readonly string[] = pv.slice(0, tree.nodes.length);
    tree.nodes[1].props.C = [[
      `How ${r.guess} is refuted (your guess at move ${r.move}, ${signed(r.g.guessLoss)}):`,
      numbered(r.move, shown),
      ...(deep.has(r.turn) ? [`Searched at ${deep.get(r.turn)?.visits} visits.`] : []),
    ].join('\n')];
  }
  return tree;
}

/**
 * How the game's own move is punished, as an alternative to the reply the
 * game actually chose.
 *
 * A refutation nobody found is the interesting case. If the game went on to
 * play the engine's punishment anyway then it is already on the board, and
 * repeating it as a variation is noise.
 */
function refutationTree(r: Row): GameTree | null {
  if (r.lost < minEdge) return null;
  const pv: readonly string[] = playedPvOf(r);
  if (pv.length < 2) return null;
  const reply: string | undefined = playedAt(r.turn + 1);
  if (reply !== undefined && pv[1] === reply) return null;
  const line: readonly string[] = pv.slice(1);
  const nodes: GameNode[] = lineNodes(r.turn + 1, -game.moves[r.turn].color, line);
  if (nodes.length === 0) return null;
  const who: string = r.hit ? `${r.actual}, which you both chose,` : `the game's ${r.actual}`;
  nodes[0].props.C = [[
    `How ${who} is refuted (move ${r.move}, ${signed(r.lost)}):`,
    numbered(r.move + 1, pv.slice(1, nodes.length + 1)),
    `The game played ${reply ?? 'nothing'} instead.`,
    ...(deep.has(r.turn) ? [`Searched at ${deep.get(r.turn)?.visits} visits.`] : []),
  ].join('\n')];
  return { nodes, variations: [] };
}

/**
 * What the engine would have played, for the moves worth stopping at. Neither
 * the guess nor the game found it, so without this the reader is told a third
 * move was best and never shown it.
 */
function bestTree(r: Row): GameTree | null {
  const ref: RefRow | undefined = refs.get(r.turn);
  if (!ref?.best || ref.best === r.guess || ref.best === r.actual) return null;
  const line: readonly string[] = (ref.bestPv ?? []).length ? (ref.bestPv ?? []) : [ref.best];
  const nodes: GameNode[] = lineNodes(r.turn, game.moves[r.turn].color, line);
  if (nodes.length === 0) return null;
  nodes[0].props.C = [[
    `The engine's own choice at move ${r.move}: ${ref.best}.`,
    ...(nodes.length > 1 ? [numbered(r.move, line.slice(0, nodes.length))] : []),
  ].join('\n')];
  return { nodes, variations: [] };
}

/**
 * The played move, carrying the verdict on the guess made at this point.
 *
 * The comment goes on the main line rather than only on the variation. A
 * reader that declines to show variations — or a reader the user has not
 * clicked into — would otherwise show a game with nothing said about it, and
 * the analysis would be present but invisible.
 */
function moveNode(turn: number): GameNode {
  const move = game.moves[turn];
  const props: Props = { [move.color === 1 ? 'B' : 'W']: [toSgf(move.index)] };
  const r: Row | undefined = at.get(turn);
  if (!r) return { props };

  const kind: 'better' | 'worse' | undefined = note.get(r.turn);
  // Silence everywhere the answer is "you were about right, and so were they".
  if (!kind && Math.abs(r.edge) < minEdge && !(r.hit && r.lost >= minEdge)) return { props };

  if (r.hit) {
    // A hit only reaches here when the move was expensive, so congratulating
    // the prediction buries the point. What the reader needs to know is that
    // they read this position the same way the game did and both were wrong.
    props.C = [`${signed(r.lost)} — you and the game both chose ${r.actual}.`];
  } else {
    const head: string =
      `${delta(r.edge)} vs actual game (${signed(r.g.guessLoss)} vs ${signed(r.lost)})`;
    props.C = [kind === undefined ? head : [
      `${kind === 'better' ? 'BETTER' : 'WORSE'}: ${head}`,
      `Engine preferred ${refs.get(r.turn)?.best ?? '?'}. You took ${(r.ms / 1000).toFixed(1)}s.`,
    ].join('\n')];
  }
  return { props };
}

/**
 * Whether this prompt is one the reader should stop at: a highlighted move,
 * a guess that beat or lost to the game by enough to matter, or either move
 * being expensive on its own.
 */
function notable(r: Row): boolean {
  return note.has(r.turn) || Math.abs(r.edge) >= minEdge
    || r.lost >= minEdge || r.g.guessLoss >= minEdge;
}

/** Everything offered as an alternative to the move the game played at `turn`. */
function altsAt(turn: number): GameTree[] {
  const trees: GameTree[] = [];
  // A refutation of the previous move is a reply, so it branches here.
  const prev: Row | undefined = at.get(turn - 1);
  if (prev) {
    const refutation: GameTree | null = refutationTree(prev);
    if (refutation) trees.push(refutation);
  }
  const r: Row | undefined = at.get(turn);
  if (!r) return trees;
  if (!r.hit && fromGtp(game.initial, r.guess) !== null) trees.push(guessTree(r));
  // Wherever the position is worth stopping at, show the move that was
  // right. Being told a third move beat both of yours and never being shown
  // it is the least useful thing a review can say.
  if (notable(r)) {
    const engine: GameTree | null = bestTree(r);
    if (engine) trees.push(engine);
  }
  return trees;
}

/** Splits the line wherever there is something to show alongside the game. */
function build(from: number): GameTree {
  const nodes: GameNode[] = [];
  for (let turn = from; turn < game.moves.length; turn++) {
    const alternatives: GameTree[] = altsAt(turn);
    if (alternatives.length > 0) {
      const played: GameTree = build(turn + 1);
      played.nodes.unshift(moveNode(turn));
      return { nodes, variations: [played, ...alternatives] };
    }
    nodes.push(moveNode(turn));
  }
  // The last move can still have gone unpunished, and nothing follows it to
  // hang the refutation off.
  return { nodes, variations: altsAt(game.moves.length) };
}

const summary: string =
  `lituus playthrough review.\n\n` +
  `You predicted ${doc.color} and hit ${doc.hits} of ${doc.prompts} (${(100 * doc.rate).toFixed(1)}%).\n` +
  `Scores are signed from your side: +0.4 is four tenths of a point gained, ` +
  `-3.1 is three points thrown away.\n` +
  `Comments mark the moves worth ${minEdge} points or more; the rest are left quiet.\n` +
  `Guesses that differed from the game are attached as variations, ` +
  `along with the refutation of any move that cost ${minEdge} points and was never punished.\n` +
  `Comments call out the ${best.length} moves where your guess most beat the game, ` +
  `and the ${worst.length} where it lost the most.` +
  (deep.size > 0 ? `\nThe ${deep.size} biggest mistakes carry a longer line from a deeper search.` : '') +
  `\n\nPoint loss is measured against the engine's own estimate of the position, ` +
  `so a small positive number means the move beat that estimate — search noise, not genius.`;

const tree: GameTree = build(0);
const root: GameNode = { props: { ...source, C: [summary] } };
tree.nodes.unshift(root);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, serialize([tree]));
const commented: number = rows.filter((r) =>
  note.has(r.turn) || Math.abs(r.edge) >= minEdge || (r.hit && r.lost >= minEdge)).length;
const refuted: number = rows.filter((r) => refutationTree(r) !== null).length;
const engineLines: number = rows.filter((r) => notable(r) && bestTree(r) !== null).length;
console.error(
  `[review] ${out}: ${commented} of ${rows.length} prompts commented, ` +
  `${misses.length} guesses, ${refuted} refutations and ${engineLines} engine lines, ` +
  `${note.size} highlighted (best +${best[0]?.edge.toFixed(1)}, worst ${worst[0]?.edge.toFixed(1)})`,
);
