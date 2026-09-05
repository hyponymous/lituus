/**
 * The engine half of the summary: derived figures, the exports, and the round
 * trip that makes a saved result a regression test for all of it.
 *
 * The figures here are the ones a reader cannot check by eye. A hit rate can be
 * counted off the strip; a median point loss cannot, and a "you beat the game"
 * claim made on search noise is worse than no claim at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/sgf-parser.ts';
import { readGame, type Game } from '../src/game.ts';
import { advance, guess, startSession, type Session } from '../src/session.ts';
import { pointFromName } from '../src/goban.ts';
import {
  costAgainst,
  costBand,
  perPrediction,
  summarize,
  toJSON,
  toText,
  type CostBand,
  type Summary,
  type SummaryRow,
} from '../src/summary.ts';
import { annotatedSgf } from '../src/annotate.ts';
import { restoreAnalysis, restoreSession, driftFrom } from '../src/dev.ts';
import {
  BEAT_MARGIN,
  BLUNDER_LOSS,
  MISSED_RUN_MIN,
  emptyAnalysis,
  withIncident,
  withVerdict,
  type Analysis,
  type EngineConfig,
  type MoveVerdict,
  type Verdict,
} from '../src/analysis.ts';
import type { Position } from '../src/rules.ts';

const CONFIG: EngineConfig = {
  network: 'b15c192',
  visits: 50,
  backend: 'replay',
  device: null,
};

/** Eight Black moves, so there are enough prompts for a run to form. */
const GAME =
  '(;SZ[19];B[pd];W[dp];B[dd];W[pp];B[cn];W[fq];B[nq];W[qn];B[cf];W[nc];B[qf];W[pb])';

function board(): Position {
  return readGame(parse(GAME)).initial;
}

function at(name: string): number {
  const point: number | null = pointFromName(board(), name);
  if (point === null) assert.fail(`"${name}" is not a point on this board`);
  return point;
}

function move(point: number, loss: number, visits: number = 50): MoveVerdict {
  return { point, loss, visits, forced: true, pv: [point] };
}

function verdict(over: Partial<Verdict> & { moveNumber: number }): Verdict {
  return {
    rootScoreLead: 0.5,
    rootVisits: 55,
    best: { point: at('Q4'), scoreLead: 0.5, pv: [at('Q4')] },
    played: move(at('Q16'), 0.2),
    guessed: move(at('D16'), 1.2),
    natural: null,
    ...over,
  };
}

/**
 * Play the record as Black, guessing each named point, and summarize against
 * whatever verdicts the caller supplies. Guesses are given as point names in
 * prompt order; `null` means guess the move actually played.
 */
interface Played {
  readonly session: Session;
  readonly summary: Summary;
}

function play(guesses: readonly (string | null)[], verdicts: readonly Verdict[]): Played {
  const game: Game = readGame(parse(GAME));
  let session: Session = startSession(game, 1);

  for (const name of guesses) {
    if (session.phase !== 'prompt' || session.move?.index == null) break;
    const point: number = name === null ? session.move.index : at(name);
    session = guess(session, point, 1000);
    session = advance(session);
  }

  let analysis: Analysis = emptyAnalysis(CONFIG);
  for (const one of verdicts) analysis = withVerdict(analysis, one);
  return { session, summary: summarize(session, analysis) };
}

// ── No engine ────────────────────────────────────────────────────────────────

test('a session with no engine summarizes exactly as it did before', () => {
  const game: Game = readGame(parse(GAME));
  let session: Session = startSession(game, 1);
  session = advance(guess(session, at('D16'), 1000));

  const summary: Summary = summarize(session);
  assert.equal(summary.ai, null);
  assert.equal(summary.verdicts, null);
  assert.equal(summary.rows[0].loss, null);
  assert.equal(summary.rows[0].beat, false);
});

// ── Per-prediction figures ───────────────────────────────────────────────────

test('a guess carries what it cost, and what the game s move cost', () => {
  const { summary } = play(['D16'], [verdict({ moveNumber: 1 })]);
  const row: SummaryRow = summary.rows[0];

  assert.equal(row.loss, 1.2);
  assert.equal(row.playedLoss, 0.2);
});

test('a barely-searched estimate is reported as no number at all', () => {
  // Not zero, and not the raw figure: at one visit it is the network's guess
  // wearing the confidence of a read one.
  const { summary } = play(
    ['D16'],
    [verdict({ moveNumber: 1, guessed: move(at('D16'), 9.9, 1) })],
  );
  assert.equal(summary.rows[0].loss, null);
  assert.equal(summary.ai?.graded, 0);
});

test('beating the played move needs to clear the noise floor', () => {
  const { summary: barely } = play(
    ['D16'],
    [verdict({ moveNumber: 1, played: move(at('Q16'), 1.0), guessed: move(at('D16'), 1.0 - BEAT_MARGIN) })],
  );
  assert.equal(barely.ai?.beat, 0, 'a difference exactly at the margin is noise');

  const { summary: clearly } = play(
    ['D16'],
    [verdict({ moveNumber: 1, played: move(at('Q16'), 4.0), guessed: move(at('D16'), 0.5) })],
  );
  assert.equal(clearly.ai?.beat, 1);
  assert.equal(clearly.rows[0].beat, true);
});

test('a guess cannot beat a played move that was never properly searched', () => {
  const { summary } = play(
    ['D16'],
    [verdict({ moveNumber: 1, played: move(at('Q16'), 9.0, 1), guessed: move(at('D16'), 0.1) })],
  );
  assert.equal(summary.ai?.beat, 0);
});

// ── Aggregates ───────────────────────────────────────────────────────────────

test('the session reports a median and a total, not a mean', () => {
  const { summary } = play(
    ['D16', 'C6', 'O3'],
    [
      verdict({ moveNumber: 1, guessed: move(at('D16'), 1) }),
      verdict({ moveNumber: 3, guessed: move(at('C6'), 2) }),
      // One catastrophe, which a mean would let swallow the figure.
      verdict({ moveNumber: 5, guessed: move(at('O3'), 60) }),
    ],
  );

  assert.equal(summary.ai?.medianLoss, 2);
  assert.equal(summary.ai?.totalLoss, 63);
  assert.equal(summary.ai?.graded, 3);
});

test('the comparison with the game is over the moves both sides can be quoted for', () => {
  const { summary } = play(
    ['D16', 'C6', 'O3'],
    [
      verdict({ moveNumber: 1, played: move(at('Q16'), 4), guessed: move(at('D16'), 1) }),
      verdict({ moveNumber: 3, played: move(at('Q16'), 1), guessed: move(at('C6'), 3) }),
      // Never properly searched, so neither side of it may be quoted: counting
      // it would manufacture a comparison out of the engine's silence.
      verdict({ moveNumber: 5, played: move(at('Q16'), 9, 1), guessed: move(at('O3'), 2) }),
    ],
  );

  const against = summary.ai?.against;
  assert.equal(against?.moves, 2);
  assert.equal(against?.yourLoss, 4);
  assert.equal(against?.playedLoss, 5);
  assert.equal(against?.yourMedian, 2);
  assert.equal(against?.playedMedian, 2.5);
  // The unsearched move is still graded on your side, where only your own
  // loss is needed.
  assert.equal(summary.ai?.graded, 3);
});

test('a session the engine could not speak for has nothing to compare', () => {
  const { summary } = play(['D16'], []);
  assert.equal(summary.ai?.against, null);
});

test('a phase carries the same comparison, over its own moves', () => {
  const { summary } = play(
    ['D16', 'C6', 'O3'],
    [
      verdict({ moveNumber: 1, played: move(at('Q16'), 4), guessed: move(at('D16'), 1) }),
      verdict({ moveNumber: 3, played: move(at('Q16'), 1), guessed: move(at('C6'), 3) }),
      // Unsearched, so excluded here for the same reason it is excluded from
      // the session-wide comparison.
      verdict({ moveNumber: 5, played: move(at('Q16'), 9, 1), guessed: move(at('O3'), 2) }),
    ],
  );

  // Every prompt in this record is inside the opening, so the phase's figures
  // are the session's — which is the cheapest way to pin that the two are the
  // same computation over different slices.
  const opening = summary.phases.find((phase) => phase.phase === 'opening');
  assert.deepEqual(opening?.cost, summary.ai?.against);
  assert.equal(opening?.cost?.moves, 2);

  // And a phase that was never reached has nothing to say, rather than zero.
  assert.equal(summary.phases.find((phase) => phase.phase === 'endgame')?.cost, null);
});

test('a phase is summarized by the mean, which the median cannot do here', () => {
  const { summary } = play(
    ['D16', 'C6'],
    [
      verdict({ moveNumber: 1, played: move(at('Q16'), 4), guessed: move(at('D16'), 1) }),
      verdict({ moveNumber: 3, played: move(at('Q16'), 1), guessed: move(at('C6'), 3) }),
    ],
  );

  // 4 points given up against 5, over two predictions.
  const opening = summary.phases.find((phase) => phase.phase === 'opening');
  assert.deepEqual(perPrediction(opening?.cost ?? null), { yours: 2, played: 2.5 });

  // And nothing to say where the engine could not speak for both sides.
  assert.equal(perPrediction(null), null);
});

test('a phase costs nothing when there was no engine', () => {
  const game: Game = readGame(parse(GAME));
  let session: Session = startSession(game, 1);
  session = advance(guess(session, at('D16'), 1000));

  const summary: Summary = summarize(session);
  assert.ok(summary.phases.every((phase) => phase.cost === null));
});

test('blunders are counted at the threshold the measurements used', () => {
  const { summary } = play(
    ['D16', 'C6'],
    [
      verdict({ moveNumber: 1, guessed: move(at('D16'), BLUNDER_LOSS) }),
      verdict({ moveNumber: 3, guessed: move(at('C6'), BLUNDER_LOSS - 0.1) }),
    ],
  );
  assert.equal(summary.ai?.blunders, 1);
});

test('a misleading position is counted, and so is finding it anyway', () => {
  const { summary } = play(
    [null, 'C6'],
    [
      verdict({ moveNumber: 1, natural: { point: at('R16'), prior: 0.08, loss: 5 } }),
      verdict({ moveNumber: 3, natural: { point: at('R16'), prior: 0.08, loss: 5 } }),
    ],
  );
  assert.equal(summary.ai?.misleading, 2);
  assert.equal(summary.ai?.misleadingHits, 1);
  assert.equal(summary.rows[0].misleading, true);
});

// ── Missed-move runs ─────────────────────────────────────────────────────────

test('a stretch where neither of you played the engine s move is one finding', () => {
  const verdicts: Verdict[] = [1, 3, 5, 7, 9].map((moveNumber) =>
    verdict({ moveNumber, best: { point: at('Q4'), scoreLead: 0.5, pv: [at('Q4')] } }),
  );
  const { summary } = play(['D16', 'C6', 'O3', 'C14', 'R14'], verdicts);

  assert.equal(summary.ai?.runs.length, 1);
  assert.equal(summary.ai?.runs[0].name, 'Q4');
  assert.equal(summary.ai?.runs[0].length, 5);
  assert.equal(summary.ai?.runs[0].everGuessed, false);
});

test('a run shorter than the floor is not reported', () => {
  const verdicts: Verdict[] = [1, 3, 5].map((moveNumber) => verdict({ moveNumber }));
  const { summary } = play(['D16', 'C6', 'O3'], verdicts);

  assert.ok(MISSED_RUN_MIN > 3);
  assert.equal(summary.ai?.runs.length, 0);
});

test('a run notes when you did find the move, even though the game never did', () => {
  const verdicts: Verdict[] = [1, 3, 5, 7].map((moveNumber) =>
    verdict({ moveNumber, best: { point: at('Q4'), scoreLead: 0.5, pv: [] } }),
  );
  const { summary } = play(['Q4', 'C6', 'O3', 'C14'], verdicts);

  assert.equal(summary.ai?.runs[0].everGuessed, true);
});

test('a prompt with no verdict breaks a run rather than bridging it', () => {
  // Bridging would claim the engine kept naming a move across positions where
  // nothing ever asked it.
  const verdicts: Verdict[] = [1, 3, 7, 9].map((moveNumber) =>
    verdict({ moveNumber, best: { point: at('Q4'), scoreLead: 0.5, pv: [] } }),
  );
  const { summary } = play(['D16', 'C6', 'O3', 'C14', 'R14'], verdicts);
  assert.equal(summary.ai?.runs.length, 0);
});

test('a run ends when the game finally plays the move', () => {
  const verdicts: Verdict[] = [1, 3, 5, 7, 9].map((moveNumber) =>
    verdict({ moveNumber, best: { point: at('Q4'), scoreLead: 0.5, pv: [] } }),
  );
  // Move 5 is D4 in the record... so instead make the engine's best equal the
  // played move there, which is the same thing from the run's point of view.
  verdicts[2] = verdict({
    moveNumber: 5,
    best: { point: at('C6'), scoreLead: 0.5, pv: [] },
    played: move(at('C6'), 0),
  });
  const { summary } = play(['D16', 'C6', 'O3', 'C14', 'R14'], verdicts);
  assert.equal(summary.ai?.runs.length, 0, 'neither side of the break reaches the floor');
});

// ── Exports ──────────────────────────────────────────────────────────────────

test('the text export leads with what was given up and what was beaten', () => {
  const { summary } = play(
    ['D16'],
    [verdict({ moveNumber: 1, played: move(at('Q16'), 4), guessed: move(at('D16'), 0.5) })],
  );
  const text: string = toText(summary);

  assert.match(text, /Engine: b15c192 @ 50 visits/);
  // Signed, and negative for a loss, like every figure a reader sees
  // (docs/design-ai-scoring.md §6.1).
  assert.match(text, /Your guesses vs the engine's best: -0\.5/);
  assert.match(text, /beat the game's move 1 times/);
});

test('the text export says so when only part of the session was analysed', () => {
  const { summary } = play(['D16', 'C6'], [verdict({ moveNumber: 1 })]);
  assert.match(toText(summary), /Analysed 1 of 2 predictions/);
});

test('the JSON export carries the verdicts, not only the figures from them', () => {
  const { summary } = play(['D16'], [verdict({ moveNumber: 1 })]);
  const json = JSON.parse(toJSON(summary)) as Record<string, unknown>;

  assert.deepEqual(json.engine, {
    network: 'b15c192',
    visits: 50,
    backend: 'replay',
    device: null,
    failures: 0,
    incidents: [],
  });
  assert.equal(Array.isArray(json.verdicts), true);
  assert.equal((json.verdicts as unknown[]).length, 1);
});

test('the export says the engine stopped, rather than leaving a silent gap', () => {
  // Without this a run that lost its GPU is indistinguishable from one that was
  // simply left unfinished: both are losses that are null.
  const game: Game = readGame(parse(GAME));
  let session: Session = startSession(game, 1);
  session = advance(guess(session, at('D16'), 1000));
  const analysis: Analysis = withIncident(emptyAnalysis(CONFIG), {
    move: 1,
    reason: 'The GPU stopped.',
    fatal: true,
  });
  const summary: Summary = summarize(session, analysis);

  const engine = (JSON.parse(toJSON(summary)) as { engine: Record<string, unknown> }).engine;
  assert.equal(engine.failures, 1);
  assert.deepEqual(engine.incidents, [{ move: 1, reason: 'The GPU stopped.', fatal: true }]);
  assert.match(toText(summary), /Scoring stopped at move 1: The GPU stopped\./);
});

test('a session with no engine exports the same keys, all null', () => {
  const game: Game = readGame(parse(GAME));
  const session: Session = advance(guess(startSession(game, 1), at('D16'), 1000));
  const json = JSON.parse(toJSON(summarize(session))) as Record<string, unknown>;

  assert.equal(json.engine, null);
  assert.equal(json.ai, null);
  assert.equal(json.verdicts, null);
});

// ── The round trip ───────────────────────────────────────────────────────────

test('an exported result restores its verdicts and recomputes the same figures', () => {
  const { summary } = play(
    ['D16', 'C6'],
    [
      verdict({ moveNumber: 1, played: move(at('Q16'), 4), guessed: move(at('D16'), 0.5) }),
      verdict({ moveNumber: 3, guessed: move(at('C6'), 12) }),
    ],
  );
  const exported: string = toJSON(summary);

  const session: Session = restoreSession(exported);
  const analysis: Analysis | null = restoreAnalysis(exported, session.game);
  assert.ok(analysis);

  // The figures are recomputed from the verdicts, never read back, so this
  // compares a fresh computation against the saved one.
  assert.deepEqual(driftFrom(exported, summarize(session, analysis)), []);
});

test('the round trip is exact for losses that sit on a rounding boundary', () => {
  // The bug this catches: verdicts exported finer than the figures derived from
  // them round twice on the way back — 0.5249 to 0.525 to 0.53, where the
  // original said 0.52 — and the fixture check then reports drift on a handful
  // of moves for no reason anyone can see.
  const { summary } = play(
    ['D16', 'C6'],
    [
      verdict({ moveNumber: 1, played: move(at('Q16'), 0.5249), guessed: move(at('D16'), 8.065) }),
      verdict({ moveNumber: 3, guessed: move(at('C6'), 10.955) }),
    ],
  );
  const exported: string = toJSON(summary);
  const session: Session = restoreSession(exported);

  assert.deepEqual(
    driftFrom(exported, summarize(session, restoreAnalysis(exported, session.game) ?? undefined)),
    [],
  );
});

test('a difference sitting on the beat margin survives the round trip', () => {
  // Found against real games: a guess 0.500001 better than the game read as a
  // beat in the session and not in the restored result, so the summary changed
  // its mind about the most motivating thing it says. The store now fixes the
  // precision, so both sides agree whichever way the threshold falls.
  const { summary } = play(
    ['D16'],
    [verdict({ moveNumber: 1, played: move(at('Q16'), 1.004), guessed: move(at('D16'), 0.5) })],
  );
  const exported: string = toJSON(summary);
  const session: Session = restoreSession(exported);

  assert.deepEqual(
    driftFrom(exported, summarize(session, restoreAnalysis(exported, session.game) ?? undefined)),
    [],
  );
});

test('a stored verdict is kept at the precision the product quotes', () => {
  const { summary } = play(
    ['D16'],
    [verdict({ moveNumber: 1, guessed: move(at('D16'), 1.23456) })],
  );
  assert.equal(summary.verdicts?.[0].guessed?.loss, 1.23);
});

test('a result exported without an engine restores no analysis, and says so quietly', () => {
  const game: Game = readGame(parse(GAME));
  const session: Session = advance(guess(startSession(game, 1), at('D16'), 1000));
  const exported: string = toJSON(summarize(session));

  assert.equal(restoreAnalysis(exported, session.game), null);
});

// ── The annotated record ─────────────────────────────────────────────────────

test('a costly guess earns a comment; a quiet one does not', () => {
  const { session: costlySession, summary: costly } = play(
    ['D16'],
    [verdict({ moveNumber: 1, played: move(at('Q16'), 0.2), guessed: move(at('D16'), 9) })],
  );
  assert.match(annotatedSgf(costlySession, costly), /the game played/);

  const { session: quietSession, summary: quiet } = play(
    ['D16'],
    [verdict({ moveNumber: 1, played: move(at('Q16'), 0.2), guessed: move(at('D16'), 0.4) })],
  );
  const sgf: string = annotatedSgf(quietSession, quiet);
  assert.match(sgf, /Your guess \(lituus\)\. -0\.4 \(game -0\.2\)/);
});

test('the engine s own move is shown where neither of you found it', () => {
  const { session, summary } = play(
    ['D16'],
    [
      verdict({
        moveNumber: 1,
        played: move(at('Q16'), 9),
        guessed: move(at('D16'), 7),
        best: { point: at('Q4'), scoreLead: 0.5, pv: [at('Q4'), at('D4')] },
      }),
    ],
  );
  assert.match(annotatedSgf(session, summary), /The engine would have played here/);
});

test('the engine s move is not shown when one of you played it', () => {
  const { session, summary } = play(
    ['D16'],
    [
      verdict({
        moveNumber: 1,
        played: move(at('Q16'), 9),
        guessed: move(at('D16'), 7),
        best: { point: at('D16'), scoreLead: 0.5, pv: [at('D16')] },
      }),
    ],
  );
  assert.doesNotMatch(annotatedSgf(session, summary), /The engine would have played/);
});

test('the annotated record still parses back as a game', () => {
  const { session, summary } = play(
    ['D16', 'C6'],
    [
      verdict({
        moveNumber: 1,
        played: move(at('Q16'), 9),
        guessed: move(at('D16'), 7),
        best: { point: at('Q4'), scoreLead: 0.5, pv: [at('Q4'), at('D4')] },
      }),
      verdict({ moveNumber: 3, guessed: move(at('C6'), 1) }),
    ],
  );
  const reread: Game = readGame(parse(annotatedSgf(session, summary)));
  assert.equal(reread.moves[0].index, at('Q16'), 'the played game is still the main line');
});

// ── The cost band ────────────────────────────────────────────────────────────
//
// The axis the review is read on once there is an engine (`docs/prd-ai-scoring.md`
// §5). Boundary cases are derived from BEAT_MARGIN and BLUNDER_LOSS rather than
// written out, so moving a threshold moves these with it instead of quietly
// defusing them.

function bandOf(guessLoss: number, playedLoss: number | null): CostBand {
  const played: MoveVerdict | null =
    playedLoss === null ? null : move(at('Q16'), playedLoss);
  const { summary } = play(
    ['D16'],
    [verdict({ moveNumber: 1, played, guessed: move(at('D16'), guessLoss) })],
  );
  return costBand(summary.rows[0], 'played');
}

test('a guess that cost clearly less than the played move reads as better', () => {
  assert.equal(bandOf(0.2, 0.2 + BEAT_MARGIN + 0.1), 'better');
});

test('a difference inside the noise floor reads as even, in either direction', () => {
  assert.equal(bandOf(1, 1), 'even');
  assert.equal(bandOf(1, 1 + BEAT_MARGIN - 0.01), 'even');
  assert.equal(bandOf(1 + BEAT_MARGIN - 0.01, 1), 'even');
});

test('an exact match lands in even, since one move cannot cost two amounts', () => {
  const { summary } = play([null], [verdict({ moveNumber: 1, guessed: move(at('Q16'), 0.2) })]);
  assert.equal(summary.rows[0].hit, true);
  assert.equal(costBand(summary.rows[0], 'played'), 'even');
});

test('costlier than the played move reads as worse, and past the blunder line as blunder', () => {
  assert.equal(bandOf(1 + BEAT_MARGIN, 1), 'worse');
  assert.equal(bandOf(1 + BLUNDER_LOSS - 0.01, 1), 'worse');
  assert.equal(bandOf(1 + BLUNDER_LOSS, 1), 'blunder');
});

test('a comparison missing either half is unscored, never even', () => {
  // The engine saying nothing about the played move is not the engine saying
  // the two cost the same.
  assert.equal(bandOf(1.2, null), 'unscored');
});

test('with no engine every row is unscored', () => {
  const game: Game = readGame(parse(GAME));
  const summary: Summary = summarize(advance(guess(startSession(game, 1), at('D16'), 1000)));
  assert.equal(costBand(summary.rows[0], 'played'), 'unscored');
});

test('the cost delta keeps the sign convention a point loss already carries', () => {
  // Negative is the good direction: you gave up less than they did. The strip
  // draws it upward, so a flipped sign here would invert the whole chart.
  const { summary } = play(
    ['D16'],
    [verdict({ moveNumber: 1, played: move(at('Q16'), 4), guessed: move(at('D16'), 1) })],
  );
  assert.equal(costAgainst(summary.rows[0], 'played'), -3);

  // Against the engine there is nothing to subtract: the loss is the cost.
  assert.equal(costAgainst(summary.rows[0], 'engine'), 1);
});

test('a delta needs both halves, and says so rather than reading as zero', () => {
  const { summary } = play(['D16'], [verdict({ moveNumber: 1, played: null })]);
  assert.equal(costAgainst(summary.rows[0], 'played'), null);

  // ...but an unsearched played move does not stop the engine baseline, which
  // never needed it.
  assert.equal(costAgainst(summary.rows[0], 'engine'), 1.2);
});

test('nothing beats the engine, so a negative against it is noise, not a win', () => {
  // A guess the engine likes better than its own best is search noise around
  // zero. Against the played move the same row is a genuine `better`.
  const { summary } = play(
    ['D16'],
    [verdict({ moveNumber: 1, played: move(at('Q16'), 4), guessed: move(at('D16'), -0.9) })],
  );
  assert.equal(costBand(summary.rows[0], 'played'), 'better');
  assert.equal(costBand(summary.rows[0], 'engine'), 'even');
});
