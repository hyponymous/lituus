/**
 * SGF writing and annotation.
 *
 * The serializer is checked by round-tripping: parse, write, parse again, and
 * compare trees. That catches escaping and structure bugs together, and it is
 * the property that actually matters — an exported record has to be readable
 * by something other than us.
 *
 * The annotator is checked by re-parsing its own output, because a variation
 * grafted at the wrong depth still serializes to valid SGF.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse, type GameTree } from '../src/sgf-parser.ts';
import { serialize } from '../src/sgf-writer.ts';
import { pointIndex, readGame, type Game } from '../src/game.ts';
import { advance, endSession, guess, startSession, type Session } from '../src/session.ts';
import { annotatedFilename, annotatedSgf, pointValue } from '../src/annotate.ts';
import { summarize, type Summary } from '../src/summary.ts';
import { BLACK, type Position } from '../src/rules.ts';

const FIXTURES: string = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function load(sgf: string): Game {
  return readGame(parse(sgf));
}

function point(pos: Position, name: string): number {
  const index: number | null = pointIndex(pos, name);
  if (index === null) assert.fail(`"${name}" is not a point on this board`);
  return index;
}

/** Parse, serialize, parse again — the trees must match. */
function roundTrips(sgf: string): void {
  const once: GameTree[] = parse(sgf);
  const twice: GameTree[] = parse(serialize(once));
  assert.deepEqual(twice, once);
}

const SIMPLE = '(;SZ[19]PB[Ada]PW[Bo];B[dd];W[pp];B[cc];W[qq])';

// ── Serializer ───────────────────────────────────────────────────────────────

test('a simple game round-trips', () => {
  roundTrips(SIMPLE);
});

test('variations round-trip, including their nesting', () => {
  roundTrips('(;SZ[19];B[dd](;W[pp];B[cc])(;W[qq](;B[dp])(;B[pd])))');
});

test('a collection round-trips as a collection', () => {
  roundTrips('(;SZ[19];B[dd])(;SZ[9];B[ee])');
});

test('multi-value properties round-trip', () => {
  roundTrips('(;SZ[19]AB[dd][pp][dp]AW[pd];B[cc])');
});

test('escaped brackets and backslashes survive the trip', () => {
  // The two characters that mean something inside a value.
  roundTrips('(;SZ[19]C[a \\] bracket and a \\\\ backslash];B[dd])');
});

test('newlines and colons inside comments are left alone', () => {
  roundTrips('(;SZ[19]C[line one\nline two: with a colon];B[dd])');
});

test('a real professional record round-trips', () => {
  roundTrips(readFileSync(join(FIXTURES, '2024-07-09d.sgf'), 'utf8'));
});

test('a lone variation stays a variation rather than collapsing', () => {
  // (;A(;B)) and (;A;B) are the same game but different trees. Collapsing
  // would quietly change the shape of every record we export.
  const source = '(;SZ[19];B[dd](;W[pp]))';
  assert.deepEqual(parse(serialize(parse(source))), parse(source));
});

// ── Point values ─────────────────────────────────────────────────────────────

test('board indices convert back to the SGF points they came from', () => {
  const game: Game = load(SIMPLE);
  for (const name of ['aa', 'dd', 'pp', 'qq', 'ss']) {
    assert.equal(pointValue(game.initial, point(game.initial, name)), name);
  }
});

// ── Annotation ───────────────────────────────────────────────────────────────

/** Play as Black, missing every prompt on purpose. */
function missEverything(game: Game): Session {
  let session: Session = startSession(game, BLACK);
  while (session.phase === 'prompt' && session.move?.index != null) {
    const actual: number = session.move.index;
    const wrong: number = actual === 0 ? 1 : 0;
    session = advance(guess(session, wrong));
  }
  return session;
}

test('the annotated record still parses', () => {
  const game: Game = load(SIMPLE);
  const sgf: string = annotatedSgf(missEverything(game));
  assert.doesNotThrow(() => parse(sgf));
});

test('a miss becomes a variation beside the played move', () => {
  const game: Game = load(SIMPLE);
  const trees: GameTree[] = parse(annotatedSgf(missEverything(game)));

  // Root run, then a branch: the played move first, the guess second.
  const root: GameTree = trees[0];
  assert.equal(root.variations.length, 2, 'one branch per missed move');
  assert.equal(root.variations[0].nodes[0].props.B?.[0], 'dd', 'played move leads');
  assert.equal(root.variations[1].nodes[0].props.B?.[0], 'aa', 'the guess is the sibling');
});

test('the guess variation is a leaf — we cannot know what would have followed', () => {
  const game: Game = load(SIMPLE);
  const root: GameTree = parse(annotatedSgf(missEverything(game)))[0];
  const guessBranch: GameTree = root.variations[1];

  assert.equal(guessBranch.nodes.length, 1);
  assert.deepEqual(guessBranch.variations, []);
});

test('the guess is marked so it cannot be mistaken for the record s own line', () => {
  const game: Game = load(SIMPLE);
  const root: GameTree = parse(annotatedSgf(missEverything(game)))[0];
  assert.match(root.variations[1].nodes[0].props.C?.[0] ?? '', /lituus/);
});

test('hits add no branch at all', () => {
  const game: Game = load(SIMPLE);
  let session: Session = startSession(game, BLACK);
  session = advance(guess(session, session.move?.index ?? 0)); // hit move 1
  const root: GameTree = parse(annotatedSgf(endSession(session)))[0];

  assert.deepEqual(root.variations, [], 'nothing branched: the only guess was right');
});

test('the record s own variations survive alongside ours', () => {
  const game: Game = load('(;SZ[19];B[dd];W[pp](;B[cc];W[qq])(;B[dp]))');
  const root: GameTree = parse(annotatedSgf(missEverything(game)))[0];

  // Somewhere in the exported tree, the record's alternative B[dp] is intact.
  const flatten = (tree: GameTree): string[] => [
    ...tree.nodes.flatMap((node) => node.props.B ?? []),
    ...tree.variations.flatMap(flatten),
  ];
  assert.ok(flatten(root).includes('dp'), "the record's own variation was dropped");
});

test('every property of the original is preserved', () => {
  const game: Game = load('(;SZ[19]PB[Ada]BR[3d]PW[Bo]KM[7.5]RU[Japanese]XX[unknown];B[dd])');
  const root: GameTree = parse(annotatedSgf(missEverything(game)))[0];
  const props = root.nodes[0].props;

  assert.equal(props.KM?.[0], '7.5');
  assert.equal(props.RU?.[0], 'Japanese');
  assert.equal(props.XX?.[0], 'unknown', 'properties we do not understand survive too');
});

test('the session summary lands in the root comment', () => {
  const game: Game = load(SIMPLE);
  const root: GameTree = parse(annotatedSgf(missEverything(game)))[0];
  const comment: string = root.nodes[0].props.C?.[0] ?? '';

  assert.match(comment, /Ada vs Bo/);
  assert.match(comment, /matched/);
  assert.match(comment, /lituus/);
});

test('an existing root comment is kept, not overwritten', () => {
  const game: Game = load('(;SZ[19]C[Commentary by a professional.];B[dd];W[pp])');
  const root: GameTree = parse(annotatedSgf(missEverything(game)))[0];

  assert.match(root.nodes[0].props.C?.[0] ?? '', /Commentary by a professional\./);
});

test('a real record survives annotation with its move count intact', () => {
  const game: Game = load(readFileSync(join(FIXTURES, '2024-07-09d.sgf'), 'utf8'));
  const annotated: string = annotatedSgf(missEverything(game));
  const reread: Game = readGame(parse(annotated));

  assert.equal(reread.moves.length, game.moves.length, 'the main line is unchanged');
});

// ── Filename ─────────────────────────────────────────────────────────────────

test('the filename is derived from the players', () => {
  const game: Game = load(SIMPLE);
  const summary: Summary = summarize(missEverything(game));
  assert.equal(annotatedFilename(summary), 'ada-vs-bo-predicted.sgf');
});

test('a nameless game still gets a usable filename', () => {
  const game: Game = load('(;SZ[19];B[dd];W[pp])');
  const summary: Summary = summarize(missEverything(game));
  assert.match(annotatedFilename(summary), /^[a-z0-9-]+\.sgf$/);
});
