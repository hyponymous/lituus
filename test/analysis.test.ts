/**
 * Analysis store tests: the record of what an engine thought.
 *
 * Small surface, but the parts that matter are the ones a screen cannot show
 * you are wrong. A verdict stored under the wrong move number, or a one-visit
 * estimate quoted as though it were read, looks exactly like a working feature.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_TRUSTED_VISITS,
  describeEngine,
  emptyAnalysis,
  withIncident,
  INCIDENT_LIMIT,
  isTrusted,
  sameEngine,
  verdictCount,
  verdictFor,
  withVerdict,
  type Analysis,
  type EngineConfig,
  type MoveVerdict,
  type Verdict,
} from '../src/analysis.ts';

const CONFIG: EngineConfig = { network: 'b15c192', visits: 50, backend: 'replay' };

function move(point: number, loss: number, visits: number = 50): MoveVerdict {
  return { point, loss, visits, forced: false, pv: [] };
}

function verdict(moveNumber: number, played: MoveVerdict | null = move(10, 1.5)): Verdict {
  return {
    moveNumber,
    rootScoreLead: 0.5,
    rootVisits: 55,
    best: { point: 20, scoreLead: 0.5, pv: [20] },
    played,
    guessed: null,
    natural: null,
  };
}

// ── The store ────────────────────────────────────────────────────────────────

test('an empty analysis carries its configuration and no verdicts', () => {
  const analysis: Analysis = emptyAnalysis(CONFIG);
  assert.equal(verdictCount(analysis), 0);
  assert.equal(analysis.config.network, 'b15c192');
});

test('a verdict is retrievable by move number', () => {
  const analysis: Analysis = withVerdict(emptyAnalysis(CONFIG), verdict(7));
  assert.equal(verdictFor(analysis, 7)?.moveNumber, 7);
  assert.equal(verdictFor(analysis, 8), null);
});

test('adding a verdict does not mutate the analysis it came from', () => {
  const before: Analysis = emptyAnalysis(CONFIG);
  const after: Analysis = withVerdict(before, verdict(3));

  assert.equal(verdictCount(before), 0);
  assert.equal(verdictCount(after), 1);
});

test('a second verdict for the same move replaces the first', () => {
  // A replay of the same game re-answers the same positions; the store must not
  // end up with two opinions about one move.
  const first: Analysis = withVerdict(emptyAnalysis(CONFIG), verdict(5, move(10, 1.0)));
  const second: Analysis = withVerdict(first, verdict(5, move(10, 4.0)));

  assert.equal(verdictCount(second), 1);
  assert.equal(verdictFor(second, 5)?.played?.loss, 4.0);
});

// ── Failures ─────────────────────────────────────────────────────────────────

test('an incident is remembered alongside the verdicts', () => {
  const analysis: Analysis = withIncident(withVerdict(emptyAnalysis(CONFIG), verdict(4)), {
    move: 9,
    reason: 'The GPU stopped.',
    fatal: true,
  });

  assert.equal(verdictCount(analysis), 1);
  assert.equal(analysis.failures, 1);
  assert.deepEqual(analysis.incidents, [{ move: 9, reason: 'The GPU stopped.', fatal: true }]);
});

test('the incident list is capped but the count is not', () => {
  // A dead engine fails once per queued prompt, so the list is bounded and the
  // count is what says how much of the session went unscored.
  let analysis: Analysis = emptyAnalysis(CONFIG);
  for (let move = 1; move <= INCIDENT_LIMIT + 5; move++) {
    analysis = withIncident(analysis, { move, reason: 'gone', fatal: false });
  }

  assert.equal(analysis.incidents.length, INCIDENT_LIMIT);
  assert.equal(analysis.failures, INCIDENT_LIMIT + 5);
  // The first ones, not the last: the failure that started it is the one that
  // explains the rest.
  assert.equal(analysis.incidents[0].move, 1);
});

test('recording an incident does not mutate the analysis it came from', () => {
  const before: Analysis = emptyAnalysis(CONFIG);
  const after: Analysis = withIncident(before, { move: 2, reason: 'gone', fatal: false });

  assert.equal(before.failures, 0);
  assert.equal(before.incidents.length, 0);
  assert.equal(after.failures, 1);
});

// ── Trust ────────────────────────────────────────────────────────────────────

test('a barely-searched estimate is not trusted', () => {
  // The reason this is not "did we get a number": at one visit the number is the
  // raw network evaluation, and one was measured ten points out.
  assert.equal(isTrusted(move(10, 8.0, 1)), false);
  assert.equal(isTrusted(move(10, 8.0, MIN_TRUSTED_VISITS - 1)), false);
});

test('an estimate at the floor is trusted', () => {
  assert.equal(isTrusted(move(10, 8.0, MIN_TRUSTED_VISITS)), true);
  assert.equal(isTrusted(move(10, 8.0, 50)), true);
});

// ── Comparability ────────────────────────────────────────────────────────────

test('the same network and visit count compare, whatever ran them', () => {
  // Desktop and a replay of the same configuration produce comparable numbers;
  // the backend is provenance, not a reason to refuse.
  assert.equal(sameEngine(CONFIG, { ...CONFIG, backend: 'webgpu' }), true);
});

test('a different network or visit count does not compare', () => {
  assert.equal(sameEngine(CONFIG, { ...CONFIG, network: 'b6c96' }), false);
  assert.equal(sameEngine(CONFIG, { ...CONFIG, visits: 100 }), false);
});

test('a configuration describes itself for an export', () => {
  assert.equal(describeEngine(CONFIG), 'b15c192 @ 50 visits (replay)');
});
