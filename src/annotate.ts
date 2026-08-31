/**
 * Annotated SGF export: the game as played, with your wrong guesses attached
 * as variations so they can be walked in any Go editor.
 *
 * The branches are the point. At each move you got wrong, the played move
 * stays on the main line and your guess hangs beside it — the shape an editor
 * already knows how to explore. No per-move commentary is written: "you played
 * here and it was wrong" is precisely what the variation already says, and
 * repeating it as text would be noise. Comments are reserved for what the
 * structure cannot carry: the session summary at the root, which includes how
 * long the predictions took and what the engine made of it, and — where an
 * engine ran — what a guess cost and what the engine would have played instead.
 *
 * Engine scores are signed from the guessing player's side, as
 * `experiments/katago/review.ts` settled on against a reader: `+0.4` is four
 * tenths of a point to the good, `-3.1` is three points thrown away. "Lost 3.1"
 * in prose is unambiguous and unreadable in a column of thirty.
 *
 * The original tree is rebuilt in place rather than regenerated from the game
 * model, so commentary, markup, the record's own variations, and properties
 * lituus does not understand all survive.
 */

import type { Game } from './game.ts';
import {
  MISLEADING_LOSS,
  lossOf,
  type BestMove,
  type Verdict,
} from './analysis.ts';
import type { GameNode, GameTree, Props } from './sgf-parser.ts';
import { serialize } from './sgf-writer.ts';
import { summarize, toText, type Summary } from './summary.ts';
import { BLACK, toRowCol, type Color, type Position } from './rules.ts';
import type { Session } from './session.ts';

/** A board index as an SGF point value — the inverse of game.ts's pointIndex. */
export function pointValue(pos: Position, index: number): string {
  const [row, col] = toRowCol(pos, index);
  return String.fromCharCode(97 + col) + String.fromCharCode(97 + row);
}

function isMoveNode(props: Props): boolean {
  return props.B !== undefined || props.W !== undefined;
}

function moveProp(color: Color): 'B' | 'W' {
  return color === BLACK ? 'B' : 'W';
}

/**
 * A rebuilt sequence, not yet a tree. The distinction matters: when a branch
 * falls on the first node of a variation, the parent run is empty, and an SGF
 * tree with no nodes is malformed — `((;B[cc])(;B[aa]))` cannot be parsed
 * back. Returning the parts lets the caller splice the children into its own
 * variation list rather than wrapping them in an empty shell.
 */
interface Sequence {
  readonly nodes: GameNode[];
  readonly variations: GameTree[];
  /** Moves counted along the main line so far, so numbering survives recursion. */
  readonly moves: number;
}

function asTrees(sequence: Sequence): GameTree[] {
  return sequence.nodes.length > 0
    ? [{ nodes: sequence.nodes, variations: sequence.variations }]
    : sequence.variations;
}

/**
 * Copy a tree, hanging each guess beside the move it was an answer to.
 *
 * A variation is a sibling of the node it replaces, so the tree must branch
 * *before* that node: everything earlier stays in the parent, and the played
 * continuation and the guess become two children. `skipFirst` exists to make
 * that recursion terminate — without it, re-entering at a branch point would
 * branch on the same node forever.
 */
function rebuild(
  tree: GameTree,
  extras: ReadonlyMap<number, readonly GameTree[]>,
  moves: number,
  from: number,
  skipFirst: boolean,
): Sequence {
  const run: GameNode[] = [];
  let counted: number = moves;
  let at: number = from;
  let branch = -1;

  while (at < tree.nodes.length) {
    const node: GameNode = tree.nodes[at];
    const move: boolean = isMoveNode(node.props);
    const branches: boolean =
      move && extras.has(counted + 1) && !(at === from && skipFirst);

    if (branches) {
      branch = at;
      break;
    }
    run.push(node);
    if (move) counted++;
    at++;
  }

  if (branch === -1) {
    if (tree.variations.length === 0) return { nodes: run, variations: [], moves: counted };

    // Only the first variation is the line the user played; the record's own
    // alternatives are carried across untouched.
    const [main, ...others] = tree.variations;
    const walked: Sequence = rebuild(main, extras, counted, 0, false);
    return { nodes: run, variations: [...asTrees(walked), ...others], moves: walked.moves };
  }

  const extra: readonly GameTree[] = extras.get(counted + 1) ?? [];
  // Re-entering at the branch point always consumes that node, so this
  // sequence is never empty and is safe to wrap.
  const played: Sequence = rebuild(tree, extras, counted, branch, true);
  const playedTree: GameTree = { nodes: played.nodes, variations: played.variations };

  // The played line stays first, so an editor opening the record on its main
  // line still walks the game that was actually played.
  return {
    nodes: run,
    variations: [playedTree, ...extra],
    moves: played.moves,
  };
}

/**
 * How many points a move must be worth before it earns a sentence.
 *
 * Three, matching the threshold the rest of this work treats as a real mistake.
 * A comment on every prompt is a comment on nothing, which is the failure this
 * number exists to avoid.
 */
const MIN_EDGE = MISLEADING_LOSS;

/** Points from the guessing player's side: positive is good, negative is lost. */
function signed(loss: number): string {
  const value: number = -loss;
  return `${value < -0.05 ? '-' : '+'}${Math.abs(value).toFixed(1)}`;
}

/**
 * What to say about a guess, beyond the fact that it was made.
 *
 * Only where the engine has something worth a sentence: the guess beat the
 * game's move, or one of the two cost real points. Otherwise the variation
 * speaks for itself and the comment would be noise.
 */
function guessComment(verdict: Verdict | undefined): string {
  const mine: number | null = verdict ? lossOf(verdict.guessed) : null;
  if (mine === null) return 'Your guess (lituus).';

  const theirs: number | null = verdict ? lossOf(verdict.played) : null;
  const line: string = `Your guess (lituus). ${signed(mine)}`;
  if (theirs === null) return line;

  const edge: number = theirs - mine;
  if (edge > MIN_EDGE) return `${line} — better than the game's ${signed(theirs)}.`;
  if (-edge > MIN_EDGE) return `${line} — the game played ${signed(theirs)}.`;
  return `${line} (game ${signed(theirs)}).`;
}

/**
 * The engine's own move, as a third branch, where neither of you found it and
 * the position was expensive enough to be worth stopping at.
 *
 * Without this the reader is told a third move was best and never shown it,
 * which is the difference between a score and an explanation.
 */
function bestBranch(
  board: Position,
  color: Color,
  verdict: Verdict | undefined,
  guess: number,
  actual: number,
): GameTree | null {
  if (!verdict) return null;
  const best: BestMove = verdict.best;
  if (best.point === guess || best.point === actual) return null;

  const cost: number | null = lossOf(verdict.played);
  const mine: number | null = lossOf(verdict.guessed);
  const worst: number = Math.max(cost ?? 0, mine ?? 0);
  if (worst < MIN_EDGE) return null;

  // The whole variation, not just the move: a line the reader can walk is what
  // makes "this was better" checkable rather than asserted.
  const line: readonly number[] = best.pv.length > 0 ? best.pv : [best.point];
  const nodes: GameNode[] = line.map((point, ply) => ({
    props: {
      [moveProp(ply % 2 === 0 ? color : (-color as Color))]: [pointValue(board, point)],
    } as Props,
  }));

  nodes[0].props.C = [`The engine would have played here (lituus).`];
  return { nodes, variations: [] };
}

/** The guess nodes to graft on, keyed by the move number they answer. */
function guessNodes(
  session: Session,
  board: Position,
  verdicts: ReadonlyMap<number, Verdict>,
): Map<number, Props> {
  const nodes = new Map<number, Props>();

  for (const made of session.guesses) {
    if (made.hit) continue;
    const move = session.game.moves[made.moveNumber - 1];
    if (!move) continue;

    nodes.set(made.moveNumber, {
      [moveProp(move.color)]: [pointValue(board, made.guess)],
      // The one thing the structure cannot say: which branches are yours
      // rather than the record's own.
      C: [guessComment(verdicts.get(made.moveNumber))],
    });
  }
  return nodes;
}

/**
 * Every branch to hang beside a move, in the order a reader should meet them:
 * what you guessed, then what the engine would have done.
 */
function branchesFor(
  session: Session,
  board: Position,
  verdicts: ReadonlyMap<number, Verdict>,
): Map<number, GameTree[]> {
  const guesses: Map<number, Props> = guessNodes(session, board, verdicts);
  const best: Map<number, GameTree> = bestNodes(session, board, verdicts);
  const branches = new Map<number, GameTree[]>();

  for (const [moveNumber, props] of guesses) {
    branches.set(moveNumber, [{ nodes: [{ props }], variations: [] }]);
  }
  for (const [moveNumber, tree] of best) {
    branches.set(moveNumber, [...(branches.get(moveNumber) ?? []), tree]);
  }
  return branches;
}

/** The engine's own move, for every prompt that earns one. */
function bestNodes(
  session: Session,
  board: Position,
  verdicts: ReadonlyMap<number, Verdict>,
): Map<number, GameTree> {
  const trees = new Map<number, GameTree>();

  for (const made of session.guesses) {
    const move = session.game.moves[made.moveNumber - 1];
    if (!move) continue;
    const branch: GameTree | null = bestBranch(
      board,
      move.color,
      verdicts.get(made.moveNumber),
      made.guess,
      made.actual,
    );
    if (branch) trees.set(made.moveNumber, branch);
  }
  return trees;
}

/** Prepend the session summary to the root comment, keeping anything already there. */
function withRootComment(tree: GameTree, summary: Summary): GameTree {
  const [root, ...rest] = tree.nodes;
  if (!root) return tree;

  const existing: string | undefined = root.props.C?.[0];
  const note = `${toText(summary)}\n\nGenerated by lituus.`;

  return {
    ...tree,
    nodes: [
      { props: { ...root.props, C: [existing ? `${note}\n\n---\n\n${existing}` : note] } },
      ...rest,
    ],
  };
}

export function annotatedTree(session: Session, summary: Summary): GameTree {
  const game: Game = session.game;
  const verdicts = new Map<number, Verdict>(
    (summary.verdicts ?? []).map((verdict) => [verdict.moveNumber, verdict]),
  );
  const nodes: Map<number, GameTree[]> = branchesFor(session, game.initial, verdicts);

  // A record whose first node carries both the root properties and move 1
  // cannot have a variation hung beside that move: branching before it would
  // duplicate SZ, PB and the rest into both lines, and there is no earlier
  // node to branch from. That one move goes unannotated.
  const first: GameNode | undefined = game.source.nodes[0];
  if (first && isMoveNode(first.props)) nodes.delete(1);

  const built: Sequence = rebuild(game.source, nodes, 0, 0, false);
  return withRootComment({ nodes: built.nodes, variations: built.variations }, summary);
}

export function annotatedSgf(session: Session, summary: Summary = summarize(session)): string {
  return serialize([annotatedTree(session, summary)]);
}

/** A filename that says what it is and sorts next to its siblings. */
export function annotatedFilename(summary: Summary): string {
  const slug: string = summary.game
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'game'}-predicted.sgf`;
}
