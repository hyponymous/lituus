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
  deepenTargets,
  mayDeepen,
  verdictFor,
  withDeepLine,
  withVerdict,
  type Analysis,
  type EngineConfig,
  type DeepTarget,
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

// ── Deeper lines ─────────────────────────────────────────────────────────────

/** A scored move with a short line, of the kind a deeper pass would lengthen. */
function scored(): Analysis {
  const one: Verdict = {
    ...verdict(7, { ...move(10, 1.5, 50), pv: [10, 20] }),
    guessed: { ...move(30, 4.0, 50), pv: [30, 40] },
  };
  return withVerdict(emptyAnalysis(CONFIG), one);
}

test('a deeper line replaces the line and carries the budget that bought it', () => {
  const after: Analysis = withDeepLine(scored(), {
    moveNumber: 7,
    visits: 4000,
    played: [10, 20, 30, 40, 50, 60],
  });

  const played: MoveVerdict | null | undefined = verdictFor(after, 7)?.played;
  assert.deepEqual(played?.pv, [10, 20, 30, 40, 50, 60]);
  assert.equal(played?.pvBudget, 4000);
});

test('a deeper line cannot touch a number, which is the reason it exists', () => {
  // The search that lengthened this line also produced a loss and a visit
  // count of its own, at a budget eighty times the one the session was scored
  // at. Letting either in would move a band, a rate and both totals of a
  // session the reader has already finished (PRD §5).
  const before: Analysis = scored();
  const after: Analysis = withDeepLine(before, {
    moveNumber: 7,
    visits: 4000,
    played: [10, 20, 30, 40],
    guessed: [30, 40, 50, 60],
  });

  const was: Verdict | null = verdictFor(before, 7);
  const now: Verdict | null = verdictFor(after, 7);
  assert.equal(now?.played?.loss, was?.played?.loss);
  assert.equal(now?.played?.visits, 50);
  assert.equal(now?.played?.forced, was?.played?.forced);
  assert.equal(now?.guessed?.loss, was?.guessed?.loss);
  assert.equal(now?.guessed?.visits, 50);
  assert.deepEqual(now?.best, was?.best, 'and the best move is not its business either');
  assert.equal(now?.rootScoreLead, was?.rootScoreLead);
});

test('a line for a move nobody scored is not a way to add a verdict', () => {
  const before: Analysis = scored();
  const after: Analysis = withDeepLine(before, { moveNumber: 99, visits: 4000, played: [10, 20] });

  assert.equal(after, before, 'nothing to deepen, so nothing changed');
  assert.equal(verdictCount(after), 1);
});

test('a line whose first ply is not the move is refused, not drawn', () => {
  // The failure this guards is a search against a stale position: it comes back
  // well-formed and about a different move, and on the board it would be
  // indistinguishable from truth.
  const after: Analysis = withDeepLine(scored(), {
    moveNumber: 7,
    visits: 4000,
    played: [11, 20, 30, 40],
  });

  assert.deepEqual(verdictFor(after, 7)?.played?.pv, [10, 20]);
  assert.equal(verdictFor(after, 7)?.played?.pvBudget, undefined);
});

test('a slot the deeper pass left alone keeps the line it had', () => {
  const after: Analysis = withDeepLine(scored(), {
    moveNumber: 7,
    visits: 4000,
    played: [10, 20, 30, 40],
  });

  assert.deepEqual(verdictFor(after, 7)?.guessed?.pv, [30, 40]);
  assert.equal(verdictFor(after, 7)?.guessed?.pvBudget, undefined);
});

test('deepening does not mutate the analysis it came from', () => {
  const before: Analysis = scored();
  withDeepLine(before, { moveNumber: 7, visits: 4000, played: [10, 20, 30] });

  assert.deepEqual(verdictFor(before, 7)?.played?.pv, [10, 20]);
});

// ── Choosing what to read again ──────────────────────────────────────────────

/** A session of mistakes: move number to (played loss, guessed loss). */
function mistakes(losses: ReadonlyArray<readonly [number, number, number]>): Analysis {
  let analysis: Analysis = emptyAnalysis(CONFIG);
  for (const [moveNumber, playedLoss, guessedLoss] of losses) {
    analysis = withVerdict(analysis, {
      ...verdict(moveNumber, { ...move(10, playedLoss), pv: [10, 20] }),
      guessed: { ...move(30, guessedLoss), pv: [30, 40, 50] },
    });
  }
  return analysis;
}

const none = new Set<number>();

test('a quiet game is read again nowhere', () => {
  // The floor is MISLEADING_LOSS, the same one annotate.ts uses to decide a
  // refutation is worth grafting. A session of one-point mistakes has no wound
  // worth four seconds of the reader's GPU.
  assert.deepEqual(deepenTargets(mistakes([[1, 1.0, 2.9], [2, 0.2, 1.4]]), none, 3), []);
});

test('the worst mistakes come first, and no more than asked for', () => {
  const targets: DeepTarget[] = deepenTargets(
    mistakes([[1, 4.0, 0.1], [2, 9.0, 0.1], [3, 6.0, 0.1], [4, 3.5, 0.1]]),
    none,
    2,
  );

  assert.deepEqual(targets.map((target) => target.moveNumber), [2, 3]);
});

test('a position offers one line, the worse of its two', () => {
  // Where the guess lost nine and the played move lost one, the reader wants
  // the refutation of their own move — not both, which would double the cost
  // of a pass for a line nobody asked about.
  const targets: DeepTarget[] = deepenTargets(mistakes([[1, 1.0, 9.0]]), none, 3);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].slot, 'guessed');
  assert.equal(targets[0].point, 30);
  assert.equal(targets[0].plies, 3, 'and says what a deeper read has to beat');
});

test('a move already offered is not offered again', () => {
  const analysis: Analysis = mistakes([[1, 9.0, 0.1], [2, 6.0, 0.1]]);

  assert.deepEqual(
    deepenTargets(analysis, new Set([1]), 3).map((target) => target.moveNumber),
    [2],
  );
});

test('a barely-searched mistake is not worth a long answer', () => {
  // No figure beside it to explain, so a line for it would be a long answer to
  // a question the board never asked.
  let analysis: Analysis = emptyAnalysis(CONFIG);
  analysis = withVerdict(analysis, {
    ...verdict(1, { ...move(10, 12.0, 3), pv: [10, 20] }),
    guessed: null,
  });

  assert.deepEqual(deepenTargets(analysis, none, 3), []);
});

test('a phone is not asked to do ten times the work for a nicety', () => {
  // The conservative start, and the first line to move once the phone is
  // trusted: it is the device that has produced wrong numbers with every check
  // passing, and the one whose worker gets killed with no last words.
  const phone: Analysis = withDevice(emptyAnalysis(CONFIG), 'apple / metal-3, mobile');
  const laptop: Analysis = withDevice(emptyAnalysis(CONFIG), 'apple / metal-3, desktop');

  assert.equal(mayDeepen(phone), false);
  assert.equal(mayDeepen(laptop), true);
  assert.equal(mayDeepen(emptyAnalysis(CONFIG)), true, 'an unknown device is not a phone');
});

test('an engine that has already failed is not asked for extras', () => {
  const hurt: Analysis = withIncident(withDevice(emptyAnalysis(CONFIG), 'apple / x, desktop'), {
    move: 7,
    reason: 'The device was lost.',
    fatal: false,
  });

  assert.equal(mayDeepen(hurt), false);
});
