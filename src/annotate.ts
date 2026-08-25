/**
 * Annotated SGF export: the game as played, with your wrong guesses attached
 * as variations so they can be walked in any Go editor.
 *
 * The branches are the point. At each move you got wrong, the played move
 * stays on the main line and your guess hangs beside it — the shape an editor
 * already knows how to explore. No per-move commentary is written: "you played
 * here and it was wrong" is precisely what the variation already says, and
 * repeating it as text would be noise. Comments are reserved for what the
 * structure cannot carry: the session summary at the root, which now includes
 * how long the predictions took, and engine evaluation once that exists.
 *
 * The original tree is rebuilt in place rather than regenerated from the game
 * model, so commentary, markup, the record's own variations, and properties
 * lituus does not understand all survive.
 */

import type { Game } from './game.ts';
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
  guesses: ReadonlyMap<number, Props>,
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
      move && guesses.has(counted + 1) && !(at === from && skipFirst);

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
    const walked: Sequence = rebuild(main, guesses, counted, 0, false);
    return { nodes: run, variations: [...asTrees(walked), ...others], moves: walked.moves };
  }

  const guess: Props | undefined = guesses.get(counted + 1);
  // Re-entering at the branch point always consumes that node, so this
  // sequence is never empty and is safe to wrap.
  const played: Sequence = rebuild(tree, guesses, counted, branch, true);
  const playedTree: GameTree = { nodes: played.nodes, variations: played.variations };

  return {
    nodes: run,
    variations: guess
      ? [playedTree, { nodes: [{ props: guess }], variations: [] }]
      : [playedTree],
    moves: played.moves,
  };
}

/** The guess nodes to graft on, keyed by the move number they answer. */
function guessNodes(session: Session, board: Position): Map<number, Props> {
  const nodes = new Map<number, Props>();

  for (const made of session.guesses) {
    if (made.hit) continue;
    const move = session.game.moves[made.moveNumber - 1];
    if (!move) continue;

    nodes.set(made.moveNumber, {
      [moveProp(move.color)]: [pointValue(board, made.guess)],
      // The one thing the structure cannot say: which branches are yours
      // rather than the record's own.
      C: ['Your guess (lituus).'],
    });
  }
  return nodes;
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
  const nodes: Map<number, Props> = guessNodes(session, game.initial);

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
