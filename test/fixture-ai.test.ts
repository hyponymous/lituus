/**
 * The saved engine result, as a regression test for every figure derived from
 * it — with no GPU, no worker, and no network.
 *
 * `result-ai.json` is the session already committed as `result.json`, run
 * through real KataGo at the shipping configuration (b15c192 @ 50 visits) with
 * every guess forced via `allowMoves`. It is the fixture
 * `docs/design-ai-scoring.md` §9.4 asks for: a real analysis, permanently
 * available, that any change to how a loss, a median or a run is derived has to
 * reproduce.
 *
 * The game is Ke Jie against Ichiriki Ryo, 10th Ing Cup — a published
 * professional record, which is why it can be committed at all. It is also,
 * per `docs/prd-ai-scoring.md` §1, exactly the game AI scoring is *not*
 * recommended for: the played move nearly always deserves to be found, so the
 * losses are small and the standing-missed-move runs are empty. That makes it
 * a good fixture and a poor demonstration, and the run logic is covered by
 * hand-built verdicts in `ai-summary.test.ts` instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { driftFrom, restoreAnalysis, restoreSession } from '../src/dev.ts';
import { asChange, edge, summarize, toText, type Summary } from '../src/summary.ts';
import { annotatedSgf } from '../src/annotate.ts';
import { readGame } from '../src/game.ts';
import { parse } from '../src/sgf-parser.ts';
import { verdictCount, type Analysis } from '../src/analysis.ts';
import type { Session } from '../src/session.ts';

const SAVED: string = readFileSync(new URL('./fixtures/result-ai.json', import.meta.url), 'utf8');

function restore(): { session: Session; analysis: Analysis; summary: Summary } {
  const session: Session = restoreSession(SAVED);
  const analysis: Analysis | null = restoreAnalysis(SAVED, session.game);
  assert.ok(analysis, 'the fixture should carry verdicts');
  return { session, analysis, summary: summarize(session, analysis) };
}

test('the saved engine result restores a verdict for every prediction', () => {
  const { session, analysis } = restore();
  assert.equal(session.guesses.length, 100);
  assert.equal(verdictCount(analysis), 100);
  assert.equal(analysis.config.network, 'b15c192');
  assert.equal(analysis.config.visits, 50);
});

test('every engine figure recomputes to what was saved', () => {
  // The whole point of the fixture. The aggregates in the file are ignored and
  // rebuilt from the verdicts, so a change to how any of them is derived shows
  // up here rather than in a session nobody will play again.
  const { summary } = restore();
  assert.deepEqual(driftFrom(SAVED, summary), []);
});

test('the figures are the ones the engine actually produced', () => {
  // Pinned so a refactor cannot quietly move them. These came from KataGo, not
  // from this code, and a change to any of them is a finding rather than a
  // fixture to regenerate.
  const { summary } = restore();
  assert.ok(summary.ai);
  assert.equal(summary.ai.graded, 100);
  assert.equal(summary.ai.medianLoss, 0.03);
  assert.equal(summary.ai.beat, 9);
  assert.equal(summary.ai.blunders, 5);
  assert.equal(summary.ai.misleading, 2);
});

test('a professional record produces no standing-missed-move runs', () => {
  // Not an accident and worth asserting: against players who mostly find the
  // engine's move, there is no stretch where neither side plays it. The
  // feature is for amateur games, and this is what the other end looks like.
  const { summary } = restore();
  assert.deepEqual(summary.ai?.runs, []);
});

test('the text export names the engine and what was given up', () => {
  const { summary } = restore();
  const text: string = toText(summary);
  assert.match(text, /Engine: b15c192 @ 50 visits/);
  assert.match(text, /Your guess beat the game's move 9 times/);
  // Negative zero renders as "-0.0" without care, which would print every
  // perfect guess as though it had lost something. Only a *zero* is wrong:
  // a small negative is a real number here, since a move can beat the
  // engine's own root evaluation by a fraction of a point.
  assert.doesNotMatch(text, /-0\.0+(?!\d)/);
});

/*
 * The direction, on every surface at once.
 *
 * Move 16 of the fixture: the guess R6 lost 2.72 points and the played move S3
 * lost -0.23, both from KataGo. So the guess reads as -2.7 wherever it is
 * printed, the played move as +0.2, and the comparison between them as -3.0 —
 * and any surface that disagrees with the others has doubled the one negation
 * a display is allowed. The unit-level half of this is `review-numbers.test.ts`.
 */
const COSTLY = { move: 16, loss: 2.72, playedLoss: -0.23 } as const;

test('the fixture still holds the losses these tests read the sign from', () => {
  const { summary } = restore();
  const row = summary.rows.find((one) => one.moveNumber === COSTLY.move);

  assert.ok(row, `move ${COSTLY.move} should be one of the predictions`);
  assert.equal(row.loss, COSTLY.loss);
  assert.equal(row.playedLoss, COSTLY.playedLoss);
  assert.equal(row.hit, false);
});

test('a costly guess reads as a cost in the text export', () => {
  const { summary } = restore();
  const text: string = toText(summary);
  const line: string | undefined = text
    .split('\n')
    .find((one) => one.trimStart().startsWith(`${COSTLY.move} `));

  assert.ok(line, 'the move should have a line of its own');
  assert.match(line, /miss/);
  assert.match(line, /-2\.7/, 'a guess that cost 2.72 points is -2.7, never +2.7');
});

test('a costly guess reads the same way in the annotated record', () => {
  const { session, summary } = restore();
  const sgf: string = annotatedSgf(session, summary);

  // "Your guess (lituus). -2.7 — the game played +0.2." — the comment for the
  // one move, with both figures the way up a reader expects them.
  assert.match(sgf, /Your guess \(lituus\)\. -2\.7/);
  assert.match(sgf, /the game played \+0\.2/);
});

test('the summary headline is your loss against the game s, not its negation', () => {
  const { summary } = restore();
  const { ai } = summary;
  assert.ok(ai?.against, 'the fixture is a scored session');

  // Both sides as costs, and the edge between them from the same two numbers.
  assert.equal(asChange(ai.against.yourLoss), edge(ai.against.yourLoss, 0));
  const better: boolean = ai.against.yourLoss < ai.against.playedLoss;
  assert.equal(
    edge(ai.against.yourLoss, ai.against.playedLoss).startsWith('+'),
    better,
    'the headline is positive exactly when your predictions cost less',
  );
});

test('the annotated record still parses back as the game that was played', () => {
  const { session, summary } = restore();
  const sgf: string = annotatedSgf(session, summary);
  const reread = readGame(parse(sgf));

  assert.equal(reread.moves.length, session.game.moves.length);
  assert.equal(reread.meta.blackName, 'Ke Jie');
  assert.match(sgf, /The engine would have played here/);
});
