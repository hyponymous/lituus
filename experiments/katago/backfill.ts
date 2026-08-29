/**
 * Give a verdict to the positions the reference refused to judge.
 *
 *   node experiments/katago/backfill.ts --net <net> --visits 500 \
 *     --ref experiments/out/6k-3k-ref.jsonl \
 *     --out experiments/out/6k-3k-backfill.jsonl \
 *     experiments/corpus/6k-3k/*.sgf
 *
 * A search only reports moves it visited. A move bad enough that PUCT never
 * expands it comes back with no `scoreLead` at all — so the moves most worth
 * calling blunders are exactly the ones the reference drops, and dropping
 * them biases every blunder rate downwards.
 *
 * `allowMoves` forces the issue: restricted to the played move, the search
 * has to evaluate it. The catch is that the move is then trivially the best
 * one, so its own query's root estimate is meaningless — the loss has to be
 * measured against the root from the *unrestricted* query, which the
 * reference already recorded.
 *
 * Writes only the repaired positions. Nothing is overwritten; `survey.ts`
 * merges this file over the reference when it is present.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { parse, type GameTree } from '../../src/sgf-parser.ts';
import { readGame, type Game } from '../../src/game.ts';
import { stoneAt, type Position } from '../../src/rules.ts';
import { toGtp } from './coords.ts';

const CONFIG = 'experiments/katago/analysis.cfg';
const RULESETS = new Set(['japanese', 'chinese', 'tromp-taylor', 'aga', 'new-zealand', 'korean']);

interface RefRecord {
  readonly game: string;
  readonly turn: number;
  readonly played: string;
  readonly pointLoss: number | null;
  readonly rootScoreLead: number;
}

interface Response {
  readonly id: string;
  readonly moveInfos?: ReadonlyArray<{ readonly move: string; readonly scoreLead: number }>;
  readonly error?: string;
  readonly isDuringSearch?: boolean;
}

function komiOf(game: Game): number {
  const raw: number = Number(game.meta.komi);
  return Number.isFinite(raw) ? raw : 6.5;
}

function rulesOf(game: Game): string {
  const raw: string = (game.meta.ruleset ?? '').toLowerCase().trim();
  return RULESETS.has(raw) ? raw : 'japanese';
}

function initialStones(pos: Position): Array<[string, string]> {
  const stones: Array<[string, string]> = [];
  for (let i = 0; i < pos.stones.length; i++) {
    const stone: number = stoneAt(pos, i);
    if (stone !== 0) stones.push([stone === 1 ? 'B' : 'W', toGtp(pos, i)]);
  }
  return stones;
}

function parseArgs(argv: readonly string[]): {
  net: string; visits: number; ref: string; out: string; files: string[];
} {
  const flags = new Map<string, string>();
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags.set(argv[i].slice(2), argv[++i]);
    else files.push(argv[i]);
  }
  const net: string | undefined = flags.get('net');
  const ref: string | undefined = flags.get('ref');
  const out: string | undefined = flags.get('out');
  if (!net || !ref || !out || files.length === 0) {
    throw new Error('usage: backfill.ts --net <net> --visits <n> --ref <ref.jsonl> --out <file> <sgf...>');
  }
  return { net, ref, out, visits: Number(flags.get('visits') ?? 500), files };
}

async function main(): Promise<void> {
  const { net, visits, ref, out, files } = parseArgs(process.argv.slice(2));

  const unjudged: RefRecord[] = readFileSync(ref, 'utf8').trim().split('\n')
    .filter(Boolean).map((l) => JSON.parse(l) as RefRecord)
    .filter((r) => r.pointLoss === null);
  if (unjudged.length === 0) { console.error(`[backfill] ${basename(ref)}: nothing to repair`); return; }

  const games = new Map<string, Game>();
  for (const file of files) {
    const name: string = basename(file, '.sgf');
    if (!unjudged.some((r) => r.game === name)) continue;
    games.set(name, readGame(parse(readFileSync(file, 'utf8')) as GameTree[]));
  }

  const queries: object[] = [];
  const roots = new Map<string, number>();
  for (const [index, record] of unjudged.entries()) {
    const game: Game | undefined = games.get(record.game);
    if (!game) continue;
    const id = `q${index}`;
    roots.set(id, record.rootScoreLead);
    queries.push({
      id,
      initialStones: initialStones(game.initial),
      moves: game.moves.map((m) => [m.color === 1 ? 'B' : 'W', toGtp(game.initial, m.index)]),
      rules: rulesOf(game),
      komi: komiOf(game),
      boardXSize: game.cols,
      boardYSize: game.rows,
      analyzeTurns: [record.turn],
      maxVisits: visits,
      // The whole point: make the search look at the move it would ignore.
      allowMoves: [{ player: game.moves[record.turn].color === 1 ? 'B' : 'W',
                     moves: [record.played], untilDepth: 1 }],
    });
  }

  console.error(`[backfill] ${basename(ref)}: ${queries.length} positions to repair`);
  const katago: ChildProcessWithoutNullStreams = spawn(
    process.env.KATAGO ?? 'katago',
    ['analysis', '-config', CONFIG, '-model', net],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );

  const repaired: string[] = [];
  let seen = 0;
  await new Promise<void>((resolve) => {
    createInterface({ input: katago.stdout }).on('line', (line: string) => {
      const res = JSON.parse(line) as Response;
      if (res.isDuringSearch) return;
      seen++;
      const root: number | undefined = roots.get(res.id);
      const lead: number | undefined = res.moveInfos?.[0]?.scoreLead;
      if (root !== undefined && lead !== undefined && !res.error) {
        const index: number = Number(res.id.slice(1));
        const record: RefRecord = unjudged[index];
        repaired.push(JSON.stringify({
          game: record.game, turn: record.turn, played: record.played,
          pointLoss: root - lead, backfilled: true,
        }));
      }
      if (seen % 25 === 0) console.error(`[backfill] ${seen}/${queries.length}`);
      if (seen >= queries.length) resolve();
    });
    for (const query of queries) katago.stdin.write(JSON.stringify(query) + '\n');
    katago.stdin.end();
  });
  katago.kill();

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, repaired.join('\n') + '\n');
  console.error(`[backfill] wrote ${repaired.length} repaired positions to ${out}`);
}

await main();
