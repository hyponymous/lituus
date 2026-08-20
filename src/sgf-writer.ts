/**
 * SGF serializer: game trees back to text.
 *
 * The counterpart to sgf-parser.ts, written here rather than vendored because
 * kifu only ever reads. Round-tripping matters more than prettiness: a record
 * we export should re-parse to the same tree, including properties lituus does
 * not understand.
 */

import type { GameNode, GameTree, Props } from './sgf-parser.ts';

/**
 * Inside a property value only `]` and `\` are special. Everything else —
 * newlines, colons, unicode — passes through untouched. The backslash has to
 * go first or it would escape the escapes.
 */
function escapeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/]/g, '\\]');
}

function writeNode(props: Props): string {
  let out = ';';
  for (const [key, values] of Object.entries(props)) {
    out += key;
    for (const value of values) out += `[${escapeValue(value)}]`;
  }
  return out;
}

/**
 * Variations are always parenthesized, even when there is only one. Collapsing
 * a lone variation into the parent's node list would parse back to a different
 * tree shape — same game, different structure — and this exists to round-trip.
 */
function writeTree(tree: GameTree): string {
  let out: string = tree.nodes.map((node: GameNode) => writeNode(node.props)).join('');
  for (const variation of tree.variations) out += `(${writeTree(variation)})`;
  return out;
}

export function serialize(trees: readonly GameTree[]): string {
  return trees.map((tree) => `(${writeTree(tree)})`).join('\n');
}
