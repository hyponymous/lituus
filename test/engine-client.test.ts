/**
 * The parts of the engine client that are decisions rather than plumbing.
 *
 * Spawning a worker, downloading 37MB and talking to a GPU are all things only
 * a browser can do, and they are checked by driving the built app (the
 * end-to-end runs behind `docs/design-ai-scoring.md` §5.2). What is worth
 * testing here is the small amount of *judgement* in the module: which records
 * can be scored at all, and what a score claims about the engine that produced
 * it. Both are answers the setup view shows the user before anything is
 * downloaded, so getting them wrong is a promise broken later.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameEngine, type EngineConfig } from '../src/analysis.ts';
import { DOWNLOAD_BYTES, VISITS, engineConfig, unscorableReason } from '../src/engine-client.ts';
import { NETWORK } from '../src/engine/network.ts';
import { readGame, type Game } from '../src/game.ts';
import { parse } from '../src/sgf-parser.ts';

const game = (sgf: string): Game => readGame(parse(sgf));

test('square records can be scored', () => {
  for (const size of [9, 13, 19]) {
    assert.equal(unscorableReason(game(`(;SZ[${size}];B[cc];W[dd])`)), null);
  }
});

test('a rectangular record is refused, with its own dimensions in the reason', () => {
  const reason: string | null = unscorableReason(game('(;SZ[19:15];B[cc];W[dd])'));
  assert.ok(reason, 'a 19x15 record should not be scorable');
  assert.match(reason, /square/);
  // The user is told which record this is about, not just that a rule exists.
  assert.match(reason, /19x15/);
});

test('the refusal is about the board, not about the toggle', () => {
  // lituus studies rectangular records perfectly well; it is the V7 feature
  // encoding that indexes by a single dimension (PRD §12, design §7). The
  // reason has to be legible as a limit of the engine rather than of the tool.
  const reason: string | null = unscorableReason(game('(;SZ[19:15];B[cc])'));
  assert.ok(reason && !/unsupported|invalid|cannot be studied/i.test(reason));
});

test('the recorded configuration names the network that actually ships', () => {
  const config: EngineConfig = engineConfig();
  assert.equal(config.network, NETWORK.label);
  assert.equal(config.visits, VISITS);
  assert.equal(config.backend, 'webgpu');
});

test('comparability follows the network and the visits, not the backend', () => {
  // PRD §9 asks whether two point losses may be put side by side, and the
  // answer is about what was computed rather than about what computed it: the
  // same network at the same visit count is the same question asked twice. So
  // verdicts recorded from native KataGo stay comparable with ones the browser
  // produces — which is what makes the replay evaluator a fixture for this
  // feature rather than a separate thing that merely resembles it.
  const replayed: EngineConfig = { network: NETWORK.label, visits: VISITS, backend: 'replay' };
  assert.equal(sameEngine(engineConfig(), replayed), true);

  // A different visit count is a different engine, and that is the split this
  // guards: the same user on a desktop and a phone must not compare numbers.
  const mobile: EngineConfig = { network: 'b6c96', visits: VISITS, backend: 'webgpu' };
  assert.equal(sameEngine(engineConfig(), mobile), false);
  assert.equal(sameEngine(engineConfig(), { ...engineConfig(), visits: 25 }), false);
});

test('the advertised download size is the network the build fetches', () => {
  assert.equal(DOWNLOAD_BYTES, NETWORK.bytes);
  // Rounded to megabytes for the setup copy; a value that rounds to 0 would
  // read as free and would mean the descriptor had drifted.
  assert.ok(Math.round(DOWNLOAD_BYTES / 1_000_000) >= 1);
});
