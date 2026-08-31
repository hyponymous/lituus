/**
 * Compare our forward pass against KataGo's raw network output.
 *
 *   node experiments/katago/raw-parity.ts
 *
 * `kata-raw-nn` returns what the network itself produced — policy, whiteWin,
 * whiteLead, whiteScoreSelfplay — with no search anywhere in the path. That is
 * a stronger reference than the analysis engine at one visit, because it needs
 * no assumption about what `rootInfo` contains.
 *
 * Findings and the open discrepancy: `docs/exploration-forward-pass-parity.md`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-cpu';
import { parseKataGoModelV8 } from '../../src/engine/load-model-v8.ts';
import { ModelV8, postprocess } from '../../src/engine/model-v8.ts';
import { BLACK, WHITE, createBoard, emptyState, type Stone } from '../../src/engine/board.ts';
import { buildFeatures, createFeatureScratch, type RecentMove } from '../../src/engine/features-v7.ts';

const NET = 'experiments/nets/g170e-b15c192-s1672170752-d466197061.bin.gz';
const CFG = `${homedir()}/src/katago/cpp/configs/gtp_example.cfg`;
const OVERRIDE = 'koRule=SIMPLE,scoringRule=TERRITORY,taxRule=SEKI,multiStoneSuicideLegal=false,' +
  'hasButton=false,whiteHandicapBonus=0,friendlyPassOk=false,nnRandomize=false,openclUseFP16=false,' +
  'logToStderr=false,logDir=';

/** Raw net output for a position given as GTP moves. */
function rawNN(moves: Array<[string, string]>): { policy: number[]; pass: number; whiteWin: number; whiteLead: number; noResult: number; whiteScoreSelfplay: number } {
  const cmds = ['boardsize 19', 'komi 8',
    ...moves.map(([c, p]) => `play ${c} ${p}`), 'kata-raw-nn 0', 'quit'].join('\n') + '\n';
  const out = execFileSync('katago', ['gtp', '-config', CFG, '-override-config', OVERRIDE, '-model', NET],
    { input: cmds, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  const lines = out.split('\n');
  const num = (key: string): number => Number(lines.find((l) => l.startsWith(`${key} `))!.split(' ')[1]);
  const at = lines.findIndex((l) => l.trim() === 'policy');
  const policy: number[] = [];
  for (let r = 0; r < 19; r++) {
    for (const tok of lines[at + 1 + r].trim().split(/\s+/)) policy.push(tok === 'NAN' ? -1 : Number(tok));
  }
  return { policy, pass: num('policyPass'), whiteWin: num('whiteWin'), whiteLead: num('whiteLead'), noResult: num('noResult'), whiteScoreSelfplay: num('whiteScoreSelfplay') };
}

await tf.setBackend('cpu'); await tf.ready();
const model = new ModelV8(tf, parseKataGoModelV8(gunzipSync(readFileSync(NET))));
const board = createBoard(19, 19);
const scratch = createFeatureScratch(board);

interface Case { name: string; gtp: Array<[string, string]>; stones: Array<[number, Stone]>; toPlay: Stone; history: RecentMove[] }
const Q16 = 3 * 19 + 15, D4 = 15 * 19 + 3;
const Q4 = 15 * 19 + 15, D16 = 3 * 19 + 3, C3 = 16 * 19 + 2;
const seq: Array<[string, string, number, Stone]> = [
  ['B', 'Q16', Q16, BLACK], ['W', 'D4', D4, WHITE], ['B', 'Q4', Q4, BLACK],
  ['W', 'D16', D16, WHITE], ['B', 'C3', C3, BLACK],
];
const cases: Case[] = [];
for (let n = 0; n <= seq.length; n++) {
  const played = seq.slice(0, n);
  const toPlay: Stone = n % 2 === 0 ? BLACK : WHITE;
  cases.push({
    name: `${n} stones, ${toPlay === BLACK ? 'B' : 'W'} to play`,
    gtp: played.map(([c, p]) => [c, p] as [string, string]),
    stones: played.map(([, , idx, col]) => [idx, col] as [number, Stone]),
    toPlay,
    history: played.map(([, , idx, col]) => ({ move: idx, player: col })),
  });
}

for (const c of cases) {
  const t = rawNN(c.gtp);
  const state = emptyState(board);
  for (const [p, col] of c.stones) state.stones[p] = col;
  const inputs = buildFeatures({ board, state, toPlay: c.toPlay, history: c.history, komi: 8, ruleset: 'territory' }, scratch);
  const ev = model.evaluate(inputs.spatial, inputs.global, 19);

  const logits = [...ev.policy, ev.policyPass];
  const hi = Math.max(...logits.filter((_, i) => i === 361 || state.stones[i] === 0));
  let sum = 0;
  const ours: number[] = logits.map((v, i) => {
    if (i < 361 && state.stones[i] !== 0) return -1;
    const e = Math.exp(v - hi); sum += e; return e;
  });
  for (let i = 0; i < ours.length; i++) if (ours[i] >= 0) ours[i] /= sum;

  let mx = 0;
  for (let i = 0; i < 361; i++) { if (t.policy[i] < 0) continue; mx = Math.max(mx, Math.abs(ours[i] - t.policy[i])); }
  const j = postprocess(ev.value, ev.scoreValue, model.postProcess);
  // kata-raw-nn reports from White's side; ours is side-to-move.
  const theirWin = c.toPlay === WHITE ? t.whiteWin : 1 - t.whiteWin - t.noResult;
  const theirLead = c.toPlay === WHITE ? t.whiteLead : -t.whiteLead;
  const theirMean = c.toPlay === WHITE ? t.whiteScoreSelfplay : -t.whiteScoreSelfplay;
  console.log(
    `${c.name.padEnd(19)} pol ${mx.toFixed(6)}  win ${Math.abs(j.winrate - theirWin).toFixed(6)}` +
    `  lead ours ${j.scoreLead.toFixed(3)} vs ${theirLead.toFixed(3)} (Δ ${Math.abs(j.scoreLead - theirLead).toFixed(4)})` +
    `  mean ours ${j.scoreMean.toFixed(3)} vs ${theirMean.toFixed(3)} (Δ ${Math.abs(j.scoreMean - theirMean).toFixed(4)})`);
}
