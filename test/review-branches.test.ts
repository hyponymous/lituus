/**
 * The three branches under the review board, and which of them has a line
 * worth walking (design §6.2).
 *
 * The views have no other test file: they are structure, and structure is
 * checked by eye. This is the exception because none of it is structure —
 * which slots exist, in which order, and what disables one are rules about
 * what the engine may be quoted on, and they are what would rot first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/sgf-parser.ts';
import { readGame, type Game } from '../src/game.ts';
import { advance, endSession, guess, startSession, type Session } from '../src/session.ts';
import { pointFromName } from '../src/goban.ts';
import { summarize, type Summary } from '../src/summary.ts';
import {
  emptyAnalysis,
  withVerdict,
  type Analysis,
  type EngineConfig,
  type MoveVerdict,
  type Verdict,
} from '../src/analysis.ts';
import { branches, type Branch } from '../src/views.ts';
import type { Position } from '../src/rules.ts';
import { SHOWN_PLIES } from '../src/variation.ts';

const CONFIG: EngineConfig = { network: 'b15c192', visits: 50, backend: 'replay', device: null };

const GAME = '(;SZ[19];B[pd];W[dp];B[dd];W[pp];B[cn];W[fq];B[nq];W[qn])';

function board(): Position {
  return readGame(parse(GAME)).initial;
}

function at(name: string): number {
  const point: number | null = pointFromName(board(), name);
  if (point === null) assert.fail(`"${name}" is not a point on this board`);
  return point;
}

const LINE: readonly string[] = ['D16', 'Q4', 'C6', 'F3', 'O3', 'R6'];

function pv(from: string): number[] {
  return [at(from), ...LINE.filter((name) => name !== from).map(at)];
}

function move(point: number, loss: number, visits: number, plies = 6): MoveVerdict {
  const line: number[] = LINE.map(at).filter((one) => one !== point);
  return { point, loss, visits, forced: true, pv: [point, ...line].slice(0, plies) };
}

function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    moveNumber: 1,
    rootScoreLead: 0.5,
    rootVisits: 55,
    best: { point: at('Q4'), scoreLead: 0.5, pv: pv('Q4') },
    played: move(at('Q16'), 0.2, 40),
    guessed: move(at('D16'), 1.2, 50),
    natural: null,
    ...over,
  };
}

/** One answered prompt — guess D16 where the record played Q16 — and its slots. */
function slots(one: Verdict | undefined): Branch[] {
  const game: Game = readGame(parse(GAME));
  let session: Session = startSession(game, 1);
  session = endSession(advance(guess(session, at('D16'), 1000)));

  let analysis: Analysis = emptyAnalysis(CONFIG);
  // A verdict for some other move, so the summary is an engine-scored one even
  // where this move has nothing: `ai` is what decides the engine's slot exists.
  analysis = withVerdict(analysis, verdict({ moveNumber: 99 }));
  if (one) analysis = withVerdict(analysis, one);

  const summary: Summary = summarize(session, analysis);
  return branches(summary, summary.rows[0], session.guesses[0], one);
}

const keys = (list: readonly Branch[]): string[] => list.map((branch) => branch.key);
const walkable = (list: readonly Branch[]): string[] =>
  list.filter((branch) => branch.line.length > 0).map((branch) => branch.key);

test('the slots stand in one fixed order and say what the cost line has always said', () => {
  const list: Branch[] = slots(verdict());

  assert.deepEqual(keys(list), ['yours', 'played', 'engine']);
  assert.deepEqual(
    list.map((branch) => branch.text),
    // Losses print negative-is-worse, whatever their sign inside.
    ['you D16 -1.2', 'Black Q16 -0.2', 'engine Q4'],
  );
  assert.deepEqual(
    list.map((branch) => branch.point),
    [at('D16'), at('Q16'), at('Q4')],
  );
});

test('a line is cut to what the search paid for', () => {
  const list: Branch[] = slots(verdict());

  for (const branch of list) {
    assert.equal(branch.line.length, SHOWN_PLIES, `${branch.key} shows what 50 visits bought`);
  }
  assert.equal(list[0].line[0], at('D16'), 'and starts with the move it is the line for');
});

test('a line a deeper search paid for is shown at the length it was recorded', () => {
  // Length belongs to the line, not to a constant (PRD §5): the pass that
  // bought this one truncated it with its own budget in mind, so the view
  // trusts it whole where it cuts everything else.
  const deep: MoveVerdict = { ...move(at('D16'), 1.2, 50), pvVisits: 4000 };
  const list: Branch[] = slots(verdict({ guessed: deep }));

  assert.equal(list[0].line.length, deep.pv.length);
  assert.ok(deep.pv.length > SHOWN_PLIES, 'and it is longer than the constant it escapes');
  assert.equal(list[1].line.length, SHOWN_PLIES, 'the branch beside it is cut as ever');
});

test('a branch the search barely looked at has no line to walk', () => {
  // Under MIN_TRUSTED_VISITS: not worth quoting as a number, so not worth
  // walking either.
  const list: Branch[] = slots(verdict({ guessed: move(at('D16'), 1.2, 4) }));

  assert.deepEqual(walkable(list), ['played', 'engine']);
});

test('a line of one ply is the mark the board already carries', () => {
  const list: Branch[] = slots(verdict({ played: move(at('Q16'), 0.2, 40, 1) }));

  assert.deepEqual(walkable(list), ['yours', 'engine']);
});

test('a branch that passes has no line, because the record truncates one there', () => {
  // `MoveVerdict.pv` is truncated at a pass, so a branch that passes arrives
  // with nothing to walk and needs no case of its own.
  const list: Branch[] = slots(verdict({ played: { ...move(at('Q16'), 0.2, 40), pv: [] } }));

  assert.deepEqual(walkable(list), ['yours', 'engine']);
});

test("the engine's branch is not gated by visits, because BestMove carries none", () => {
  // It is the search's most-visited child by construction, which is the gate.
  const list: Branch[] = slots(
    verdict({ played: move(at('Q16'), 0.2, 1), guessed: move(at('D16'), 1.2, 1) }),
  );

  assert.deepEqual(walkable(list), ['engine']);
});

test('the engine keeps its slot with nothing to say, so a late verdict fills a gap', () => {
  const list: Branch[] = slots(undefined);

  assert.deepEqual(keys(list), ['yours', 'played', 'engine'], 'three slots, one of them empty');
  assert.deepEqual(list[2].text, 'engine —');
  assert.deepEqual(walkable(list), [], 'and nothing to walk anywhere on the line');
});
