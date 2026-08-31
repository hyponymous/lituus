/**
 * Record the network's raw output on a handful of positions, as ground truth
 * for the in-browser engine.
 *
 *   node experiments/katago/groundtruth.ts --net <net> \
 *     --turns 0,40,120,199 --out test/fixtures/net-b15c192.json <game.sgf>
 *
 * Step 4 of `docs/design-ai-scoring.md` §12 builds a forward pass and has to
 * show it agrees with the network it claims to be running. Agreement cannot be
 * checked against a *search* — that mixes the graph, the input planes and the
 * tree together, so a disagreement says nothing about which is wrong. One
 * visit is one evaluation, so `maxVisits: 1` with `includePolicy` returns the
 * policy head and the value head as the network itself produced them.
 *
 * The output is committed as a fixture: it is a few hundred numbers, it never
 * changes for a given network, and regenerating it needs a GPU that CI does
 * not have.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse } from '../../src/sgf-parser.ts';
import { readGame, type Game } from '../../src/game.ts';
import { stoneAt, type Position } from '../../src/rules.ts';
import { toGtp } from './coords.ts';

type Engine = ChildProcessByStdio<Writable, Readable, null>;

const DEFAULT_CONFIG = 'experiments/katago/analysis.cfg';
const DEFAULT_KOMI = 6.5;
const RULESETS = new Set(['japanese', 'chinese', 'tromp-taylor', 'aga', 'new-zealand', 'korean']);

interface Response {
  readonly id: string;
  readonly turnNumber: number;
  readonly policy?: readonly number[];
  readonly rootInfo?: {
    readonly winrate: number;
    readonly scoreLead: number;
    readonly scoreSelfplay?: number;
    readonly scoreStdev?: number;
    readonly visits: number;
    readonly currentPlayer?: string;
  };
  readonly error?: string;
  readonly warning?: string;
  readonly isDuringSearch?: boolean;
}

function parseArgs(argv: readonly string[]): {
  net: string; out: string; turns: number[]; file: string; config: string;
} {
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags.set(argv[i].slice(2), argv[++i]);
    else rest.push(argv[i]);
  }
  const net: string | undefined = flags.get('net');
  const out: string | undefined = flags.get('out');
  if (!net || !out || rest.length !== 1) {
    throw new Error(
      'usage: groundtruth.ts --net <net> --out <file> [--turns a,b,c] [--config <cfg>] <game.sgf>',
    );
  }
  return {
    net,
    out,
    turns: (flags.get('turns') ?? '0,40,120,199').split(',').map(Number),
    file: rest[0],
    config: flags.get('config') ?? DEFAULT_CONFIG,
  };
}

function initialStones(pos: Position): Array<[string, string]> {
  const stones: Array<[string, string]> = [];
  for (let i = 0; i < pos.stones.length; i++) {
    const stone: number = stoneAt(pos, i);
    if (stone !== 0) stones.push([stone === 1 ? 'B' : 'W', toGtp(pos, i)]);
  }
  return stones;
}

async function main(): Promise<void> {
  const { net, out, turns, file, config } = parseArgs(process.argv.slice(2));
  const game: Game = readGame(parse(readFileSync(file, 'utf8')));
  const komiRaw: number = Number(game.meta.komi);
  const rules: string = (game.meta.ruleset ?? '').toLowerCase().trim();

  const query = {
    id: 'truth',
    initialStones: initialStones(game.initial),
    moves: game.moves.map((m) => [m.color === 1 ? 'B' : 'W', toGtp(game.initial, m.index)]),
    rules: RULESETS.has(rules) ? rules : 'japanese',
    komi: Number.isFinite(komiRaw) ? komiRaw : DEFAULT_KOMI,
    boardXSize: game.cols,
    boardYSize: game.rows,
    analyzeTurns: turns,
    // One visit is one forward pass, which is the whole point: this has to
    // measure the network, not a search over it.
    maxVisits: 1,
    includePolicy: true,
  };

  const engine: Engine = spawn(
    process.env.KATAGO ?? 'katago',
    ['analysis', '-config', config, '-model', net],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );

  const results = new Map<number, Response>();
  const done = new Promise<void>((resolve) => {
    createInterface({ input: engine.stdout }).on('line', (line: string) => {
      const res = JSON.parse(line) as Response;
      if (res.error) throw new Error(res.error);
      if (res.isDuringSearch) return;
      results.set(res.turnNumber, res);
      if (results.size === turns.length) resolve();
    });
  });

  engine.stdin.write(`${JSON.stringify(query)}\n`);
  engine.stdin.end();
  await done;
  engine.kill();

  const positions = turns.map((turn: number) => {
    const res: Response | undefined = results.get(turn);
    if (!res?.policy || !res.rootInfo) throw new Error(`no result for turn ${turn}`);
    const move = game.moves[turn];
    return {
      turn,
      moveNumber: move.number,
      toPlay: move.color === 1 ? 'B' : 'W',
      // Rounded to what a float32 forward pass can be expected to reproduce
      // across two implementations; see the tolerance the test uses.
      policy: res.policy.map((p: number) => (p < 0 ? -1 : Number(p.toFixed(6)))),
      winrate: Number(res.rootInfo.winrate.toFixed(6)),
      scoreLead: Number(res.rootInfo.scoreLead.toFixed(6)),
      visits: res.rootInfo.visits,
    };
  });

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        note: 'Raw network output from native KataGo at one visit. See experiments/katago/groundtruth.ts.',
        network: net.split('/').pop(),
        sgf: file.split('/').pop(),
        boardXSize: game.cols,
        boardYSize: game.rows,
        komi: query.komi,
        rules: query.rules,
        positions,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`wrote ${positions.length} positions to ${out}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
