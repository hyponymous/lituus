/**
 * Dev harness tests: the round trip from a played session, out through the
 * JSON export, and back into a session that summarizes to the same numbers.
 *
 * The harness only earns its keep if that trip is lossless, so the round trip
 * is the main assertion here. `driftFrom` is what reports a break in it at
 * runtime, and it gets tested in both directions: silent when nothing moved,
 * specific when something did.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '../src/sgf-parser.ts';
import { readGame, type Game } from '../src/game.ts';
import { advance, canGuess, guess, startSession, type Session } from '../src/session.ts';
import { summarize, toJSON, type Summary } from '../src/summary.ts';
import { RestoreError, driftFrom, restoreSession } from '../src/dev.ts';
import { BLACK, WHITE } from '../src/rules.ts';

const GAME =
  '(;SZ[19]PB[Ada]BR[3d]PW[Bo]WR[4d]RE[B+R]' +
  ';B[dd];W[pp];B[dp];W[pd];B[qf];W[nc];B[pj];W[cf])';

/** Some legal point that is not `actual`, so a deliberate miss stays legal. */
function aMiss(session: Session, actual: number): number {
  for (let index = 0; index < session.position.stones.length; index++) {
    if (index !== actual && canGuess(session, index)) return index;
  }
  assert.fail('no legal point left to miss with');
}

/** Play every prompt for `color`, hitting on the move numbers in `hits`. */
function play(sgf: string, color: 1 | -1, hits: Set<number>): Session {
  const game: Game = readGame(parse(sgf));
  let session: Session = startSession(game, color);

  while (session.phase === 'prompt' && session.move) {
    const actual: number | null = session.move.index;
    if (actual === null) break;
    session = advance(guess(session, hits.has(session.move.number) ? actual : aMiss(session, actual)));
  }
  return session;
}

test('an exported result rebuilds into a session that exports identically', () => {
  const played: Session = play(GAME, BLACK, new Set([1, 3, 5]));
  const exported: string = toJSON(summarize(played));

  const restored: Session = restoreSession(exported);
  assert.equal(toJSON(summarize(restored)), exported);
});

test('the rebuilt session carries the same guesses, not just the same totals', () => {
  const played: Session = play(GAME, BLACK, new Set([1, 5]));
  const restored: Session = restoreSession(toJSON(summarize(played)));

  assert.deepEqual(restored.guesses, played.guesses);
  assert.equal(restored.color, played.color);
  assert.equal(restored.phase, 'done');
});

test('a result played as White rebuilds as White', () => {
  const played: Session = play(GAME, WHITE, new Set([2, 4]));
  const restored: Session = restoreSession(toJSON(summarize(played)));

  assert.equal(restored.color, WHITE);
  assert.equal(summarize(restored).score.hits, 2);
});

test('a session with no guesses at all still rebuilds', () => {
  const game: Game = readGame(parse(GAME));
  const empty: Session = startSession(game, BLACK);
  const restored: Session = restoreSession(toJSON(summarize({ ...empty, phase: 'done' })));

  assert.deepEqual(restored.guesses, []);
});

test('the record survives the round trip well enough to draw a board', () => {
  const played: Session = play(GAME, BLACK, new Set([1]));
  const restored: Session = restoreSession(toJSON(summarize(played)));

  assert.equal(restored.game.cols, 19);
  assert.equal(restored.game.moves.length, played.game.moves.length);
  assert.deepEqual(restored.game.moves.at(-1)?.after.stones, played.game.moves.at(-1)?.after.stones);
});

// ── Rejecting what it cannot rebuild ─────────────────────────────────────────

test('text that is not JSON is rejected by name', () => {
  assert.throws(() => restoreSession('not json at all'), RestoreError);
});

test('a result from before the sgf field says so rather than failing obscurely', () => {
  const played: Session = play(GAME, BLACK, new Set([1]));
  const older = JSON.parse(toJSON(summarize(played))) as Record<string, unknown>;
  delete older.sgf;

  assert.throws(() => restoreSession(JSON.stringify(older)), /no "sgf" field/);
});

test('a color that is neither Black nor White is rejected', () => {
  const played: Session = play(GAME, BLACK, new Set([1]));
  const bad = JSON.parse(toJSON(summarize(played))) as Record<string, unknown>;
  bad.color = 'Green';

  assert.throws(() => restoreSession(JSON.stringify(bad)), /"Black" or "White"/);
});

test('a guess that is not a point on the board is rejected', () => {
  const played: Session = play(GAME, BLACK, new Set([1]));
  const bad = JSON.parse(toJSON(summarize(played))) as { moves: { guess: string }[] };
  bad.moves[0].guess = 'Z99';

  assert.throws(() => restoreSession(JSON.stringify(bad)), /not a point on a 19x19 board/);
});

test('a hit flag that disagrees with replaying the move is rejected, not trusted', () => {
  // The whole point of recomputing rather than reading back: if the export and
  // the replay disagree, one of them is a bug and neither should be believed.
  const played: Session = play(GAME, BLACK, new Set([1]));
  const bad = JSON.parse(toJSON(summarize(played))) as { moves: { hit: boolean }[] };
  bad.moves[0].hit = !bad.moves[0].hit;

  assert.throws(() => restoreSession(JSON.stringify(bad)), /exported as a miss/);
});

test('a move number the record does not have is rejected', () => {
  const played: Session = play(GAME, BLACK, new Set([1]));
  const bad = JSON.parse(toJSON(summarize(played))) as { moves: { move: number }[] };
  bad.moves[0].move = 999;

  assert.throws(() => restoreSession(JSON.stringify(bad)), /no move 999 to predict/);
});

test('a move belonging to the other color is rejected', () => {
  const played: Session = play(GAME, BLACK, new Set([1]));
  const bad = JSON.parse(toJSON(summarize(played))) as { moves: { move: number }[] };
  bad.moves[0].move = 2;

  assert.throws(() => restoreSession(JSON.stringify(bad)), /does not belong to the color/);
});

// ── Drift ────────────────────────────────────────────────────────────────────

test('a result that still computes the same way reports no drift', () => {
  const played: Session = play(GAME, BLACK, new Set([1, 3]));
  const exported: string = toJSON(summarize(played));

  assert.deepEqual(driftFrom(exported, summarize(restoreSession(exported))), []);
});

test('drift names the field, what it was, and what it is now', () => {
  const played: Session = play(GAME, BLACK, new Set([1, 3]));
  const summary: Summary = summarize(played);
  const stale = JSON.parse(toJSON(summary)) as Record<string, unknown>;
  stale.hits = 99;

  assert.deepEqual(driftFrom(JSON.stringify(stale), summary), ['hits: was 99, now 2']);
});

test('drift reaches into nested fields and arrays', () => {
  const played: Session = play(GAME, BLACK, new Set([1, 3]));
  const summary: Summary = summarize(played);
  const stale = JSON.parse(toJSON(summary)) as {
    tenuki: { bothAway: number };
    moves: { guess: string }[];
  };
  stale.tenuki.bothAway = 42;
  stale.moves[1].guess = 'A1';

  const drift: string[] = driftFrom(JSON.stringify(stale), summary);
  assert.ok(
    drift.some((line) => line.startsWith('tenuki.bothAway: was 42')),
    `expected a tenuki line in ${JSON.stringify(drift)}`,
  );
  assert.ok(
    drift.some((line) => line.startsWith('moves[1].guess: was "A1"')),
    `expected a moves line in ${JSON.stringify(drift)}`,
  );
});

test('the sgf field is left out of the drift report', () => {
  const played: Session = play(GAME, BLACK, new Set([1]));
  const summary: Summary = summarize(played);
  const stale = JSON.parse(toJSON(summary)) as Record<string, unknown>;
  stale.sgf = '(;SZ[19])';

  assert.deepEqual(driftFrom(JSON.stringify(stale), summary), []);
});

test('a shorter move list drifts as a length difference, not a field-by-field flood', () => {
  const played: Session = play(GAME, BLACK, new Set([1, 3]));
  const summary: Summary = summarize(played);
  const stale = JSON.parse(toJSON(summary)) as { moves: unknown[] };
  stale.moves = stale.moves.slice(0, 1);

  const drift: string[] = driftFrom(JSON.stringify(stale), summary);
  assert.ok(drift.includes(`moves: was 1 entries, now ${summary.rows.length}`), drift.join('\n'));
});

test('a field absent from the saved result is named once, not once per move', () => {
  // An export predating a field is an old file, not one regression per row.
  const played: Session = play(GAME, BLACK, new Set([1, 3]));
  const summary: Summary = summarize(played);
  const older = JSON.parse(toJSON(summary)) as {
    moves: Record<string, unknown>[];
    tenuki?: unknown;
  };
  delete older.tenuki;
  for (const row of older.moves) delete row.playedAway;

  assert.deepEqual(driftFrom(JSON.stringify(older), summary), [
    'not in the saved result: moves[].playedAway, tenuki',
  ]);
});

test('a field the saved result has and nothing computes any more is called out', () => {
  const played: Session = play(GAME, BLACK, new Set([1]));
  const summary: Summary = summarize(played);
  const stale = JSON.parse(toJSON(summary)) as Record<string, unknown>;
  stale.averageThinkingTime = 12;

  assert.deepEqual(driftFrom(JSON.stringify(stale), summary), [
    'in the saved result but no longer exported: averageThinkingTime',
  ]);
});

test('real changes lead, and are not folded in with the missing fields', () => {
  const played: Session = play(GAME, BLACK, new Set([1, 3]));
  const summary: Summary = summarize(played);
  const older = JSON.parse(toJSON(summary)) as Record<string, unknown> & { streaks?: unknown };
  delete older.streaks;
  older.hits = 99;

  const drift: string[] = driftFrom(JSON.stringify(older), summary);
  assert.equal(drift[0], 'hits: was 99, now 2');
  assert.equal(drift.at(-1), 'not in the saved result: streaks');
});

test('an export made before the sgf field carried anything still diffs cleanly', () => {
  // The record is the input, so a different one must not read as drift.
  const played: Session = play(GAME, BLACK, new Set([1]));
  const summary: Summary = summarize(played);
  const stale = JSON.parse(toJSON(summary)) as Record<string, unknown>;
  delete stale.sgf;

  assert.deepEqual(driftFrom(JSON.stringify(stale), summary), []);
});

// ── A real saved result ──────────────────────────────────────────────────────

/**
 * A full 200-move game, exported and kept. The assertions are deliberately
 * self-consistency rather than a comparison against stored numbers: pinning
 * the bytes would make every intentional change to the export a failing test,
 * and the harness already reports that case as drift when you look at it.
 */
const SAVED: string = readFileSync('test/fixtures/result.json', 'utf8');

test('the saved result restores to a full session', () => {
  const session: Session = restoreSession(SAVED);
  const summary: Summary = summarize(session);

  assert.equal(session.guesses.length, 100);
  assert.equal(summary.score.guessed, 100);
  assert.equal(session.game.moves.length, 200);
  assert.equal(session.game.cols, 19);
});

test('the saved result is a complete export — nothing missing, nothing stale', () => {
  assert.deepEqual(driftFrom(SAVED, summarize(restoreSession(SAVED))), []);
});

test('the saved result survives a second trip through the export', () => {
  const once: string = toJSON(summarize(restoreSession(SAVED)));
  const twice: string = toJSON(summarize(restoreSession(once)));

  assert.equal(twice, once);
});
