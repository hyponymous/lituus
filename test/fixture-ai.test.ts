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
import { summarize, toText, type Summary } from '../src/summary.ts';
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
  // perfect guess as though it had lost something.
  assert.doesNotMatch(text, /-0\.0/);
});

test('the annotated record still parses back as the game that was played', () => {
  const { session, summary } = restore();
  const sgf: string = annotatedSgf(session, summary);
  const reread = readGame(parse(sgf));

  assert.equal(reread.moves.length, session.game.moves.length);
  assert.equal(reread.meta.blackName, 'Ke Jie');
  assert.match(sgf, /The engine would have played here/);
});
