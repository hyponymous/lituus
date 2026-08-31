/**
 * Our V7 input planes, checked against KataGo's own committed expectations.
 *
 * KataGo's test suite pins `fillRowV7` to golden output in
 * `cpp/tests/results/runOutputTests.txt`: every plane printed as a grid, with
 * the board drawn beside it. `experiments/katago/golden-inputs.ts` lifts two of
 * those positions into `test/fixtures/golden-v7.json`. That makes this the only
 * check in the project that measures our encoder against the reference
 * implementation rather than against our own reading of it — and it runs with
 * no KataGo binary, no GPU and no network.
 *
 * What it can and cannot prove:
 *
 * The position is rebuilt from the printed board, so planes 1, 2 and 9-13 —
 * stones and move history — are close to tautological here; they are asserted
 * anyway, because they are what makes the rebuild trustworthy. The planes that
 * carry real weight are the ones we *derive*: 3, 4 and 5, the liberty counts,
 * and 14-17, the ladder planes.
 *
 * Several planes are deliberately not compared, each for its own reason:
 *
 *   6        ko. The ko point depends on the ko rule, and both fixtures were
 *            generated under Tromp-Taylor positional superko, which lituus
 *            does not implement.
 *   7, 8     encore. Japanese scoring as lituus uses it never enters an encore
 *            phase, so these are always zero for us and the fixture agrees.
 *   18, 19   area. `fillRowV7` fills these from Benson's pass-alive analysis,
 *            and only for area scoring or the second encore — neither of which
 *            lituus reaches. See `docs/exploration-forward-pass-parity.md`.
 *   20, 21   second-encore ownership, unreachable for the same reason as 7/8.
 *
 * Globals are not compared at all: the fixtures are Tromp-Taylor, so their
 * ruleset and komi encodings describe rules lituus does not offer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  BLACK,
  EMPTY,
  WHITE,
  createBoard,
  emptyState,
  opponentOf,
  type Board,
  type BoardState,
  type Stone,
} from '../src/engine/board.ts';
import {
  SPATIAL_CHANNELS,
  buildFeatures,
  createFeatureScratch,
  type RecentMove,
} from '../src/engine/features-v7.ts';
import {
  createLadderScratch,
  ladderPlanes,
  type LadderPlanes,
} from '../src/engine/ladder.ts';

const here: string = dirname(fileURLToPath(import.meta.url));

interface GoldenRecord {
  readonly section: string;
  readonly planes: Record<string, readonly (readonly number[])[]>;
  readonly board: readonly string[];
}

const fixture: { records: readonly GoldenRecord[] } = JSON.parse(
  readFileSync(join(here, 'fixtures', 'golden-v7.json'), 'utf8'),
);

/**
 * The planes this test is entitled to check; see the header for the rest.
 *
 * 14 and 17 are here because `ladder.ts` computes them from the current
 * position alone. 15 and 16 are the same search run on the boards one and two
 * moves ago, and the fixture draws only the position it describes — the
 * previous boards cannot be recovered from it, because a drawing does not say
 * what was captured. They are exercised by `test/ladder.test.ts` instead.
 */
const COMPARED: readonly number[] = [0, 1, 2, 3, 4, 5, 9, 10, 11, 12, 13, 14, 17];

interface Rebuilt {
  readonly board: Board;
  readonly state: BoardState;
  readonly toPlay: Stone;
  readonly history: readonly RecentMove[];
}

/**
 * Rebuild the position from the board KataGo printed beside each plane.
 *
 * The drawing is fixed-width: two characters per point, the first a stone
 * (`X`, `O`) or `.`, the second the age of the move played there if it was one
 * of the last five, `1` being the most recent. A marker can sit on an empty
 * point, where the stone played there has since been captured — which is why
 * history is read from the markers rather than from the stones.
 *
 * The marker counts up to the present: `5` is the most recent move and `1` the
 * oldest of the five, which is the opposite of the plane order. A game shorter
 * than five moves simply has no low markers.
 *
 * The marker's own colour is not always legible, so colours come from the
 * position in the sequence instead: move `5` was made by the opponent of the
 * player to move, and they alternate back from there. That is the same
 * alternation KataGo assumes when it fills the history planes, so nothing is
 * being assumed here that the encoding does not already.
 */
function rebuild(drawing: readonly string[]): Rebuilt {
  const size: number = drawing.length;
  const board: Board = createBoard(size, size);
  const state: BoardState = emptyState(board);
  const ages = new Map<number, number>();

  for (let row = 0; row < size; row++) {
    const line: string = drawing[row];
    for (let col = 0; col < size; col++) {
      const point: number = row * size + col;
      const stone: string = line[col * 2] ?? '.';
      const mark: string = line[col * 2 + 1] ?? ' ';

      if (stone === 'X') state.stones[point] = BLACK;
      else if (stone === 'O') state.stones[point] = WHITE;

      if (mark >= '1' && mark <= '5') ages.set(Number(mark), point);
    }
  }

  // Marker 5 is the most recent, so whoever made it is not the player to move.
  const recent: number | undefined = ages.get(5);
  assert.ok(recent !== undefined, 'the drawing marks no most-recent move');
  const played: Stone = state.stones[recent] as Stone;
  assert.notEqual(played, EMPTY, 'the most recent move was captured; colour is unreadable');
  const toPlay: Stone = opponentOf(played);

  // Chronological, oldest first. Markers run 1..5 with no gaps, so a missing
  // one means the game is shorter than five moves and the run stops there.
  const history: RecentMove[] = [];
  for (let marker = 1; marker <= 5; marker++) {
    const point: number | undefined = ages.get(marker);
    if (point === undefined) {
      history.length = 0;
      continue;
    }
    history.push({ move: point, player: marker % 2 === 1 ? played : toPlay });
  }
  return { board, state, toPlay, history };
}

/** Flatten a printed grid to the plane order `buildFeatures` writes. */
function flatten(grid: readonly (readonly number[])[]): number[] {
  return grid.flatMap((row) => [...row]);
}

/** Compare one record's planes against the fixture, channel by channel. */
function check(record: GoldenRecord, channels: readonly number[]): void {
  const { board, state, toPlay, history } = rebuild(record.board);
  const planes: LadderPlanes = ladderPlanes(board, state, toPlay, createLadderScratch(board), {
    captured: new Uint8Array(board.area),
    workingMoves: new Uint8Array(board.area),
  });
  const { spatial } = buildFeatures(
    {
      board,
      state,
      toPlay,
      history,
      komi: 7.5,
      ruleset: 'territory',
      ladders: { captured: planes.captured, workingMoves: planes.workingMoves },
    },
    createFeatureScratch(board),
  );

  for (const channel of channels) {
    const expected: number[] = flatten(record.planes[String(channel)]);
    assert.equal(expected.length, board.area, `channel ${channel} is the wrong size`);

    const actual: number[] = [];
    for (let point = 0; point < board.area; point++) {
      actual.push(spatial[point * SPATIAL_CHANNELS + channel]);
    }
    assert.deepEqual(actual, expected, `channel ${channel} differs from KataGo`);
  }
}

for (const record of fixture.records) {
  test(`V7 planes match KataGo: ${record.section}`, () => {
    check(record, COMPARED);
  });

}
