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
  withDevice,
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

const CONFIG: EngineConfig = {
  network: 'b15c192',
  visits: 50,
  backend: 'replay',
  device: null,
};

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

// ── The device ───────────────────────────────────────────────────────────────

test('the device is recorded on the configuration the verdicts carry', () => {
  const analysis: Analysis = withVerdict(withDevice(emptyAnalysis(CONFIG), 'apple / metal-3, mobile'), verdict(1));

  assert.equal(analysis.config.device, 'apple / metal-3, mobile');
  assert.equal(analysis.config.network, CONFIG.network);
  assert.equal(verdictCount(analysis), 1);
});

test('a second device is added to the record, not swapped in', () => {
  // A result exported from a phone and re-scored on a laptop has two machines
  // behind it. Naming only the later one would attribute the phone's verdicts
  // to the laptop, which is the confusion the field exists to end.
  const phone: Analysis = withDevice(emptyAnalysis(CONFIG), 'apple / apple, mobile');
  const both: Analysis = withDevice(phone, 'apple / metal-3, desktop');

  assert.equal(both.config.device, 'apple / apple, mobile; apple / metal-3, desktop');
  // And the same device again is not named twice, however many times an engine
  // is restarted on it.
  assert.equal(withDevice(both, 'apple / apple, mobile').config.device, both.config.device);
  assert.equal(withDevice(phone, 'apple / apple, mobile'), phone);
});

test('a described engine names the device when there is one', () => {
  assert.equal(describeEngine(CONFIG), 'b15c192 @ 50 visits (replay)');
  assert.equal(
    describeEngine({ ...CONFIG, device: 'apple / metal-3, mobile' }),
    'b15c192 @ 50 visits (replay, apple / metal-3, mobile)',
  );
});

test('the device does not decide whether two results may be compared', () => {
  // It names the split this test exists for, and is still the wrong thing to
  // test on: two laptops report different adapters and agree perfectly, and
  // every result exported before the field existed reports null.
  assert.equal(sameEngine(CONFIG, { ...CONFIG, device: 'apple / metal-3, mobile' }), true);
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
