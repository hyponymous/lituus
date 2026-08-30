/**
 * Give a verdict to the moves the player guessed, not just the ones played.
 *
 *   node experiments/katago/guesses.ts --net <net> --visits 500 \
 *     --play <playthrough.json> \
 *     --ref experiments/out/<band>-ref.jsonl \
 *     --out experiments/out/<band>-guesses.jsonl \
 *     experiments/corpus/<band>/<game>.sgf
 *
 * Everything measured so far is the move the game actually played. The
 * product's claim is about the move the *user* guessed, which is a different
 * move and usually a worse one, and no run has ever evaluated it.
 *
 * A guess is even less likely than a played move to appear in an unrestricted
 * search — it is one amateur's idea, not a strong player's — so this forces
 * every guess with `allowMoves` rather than hoping search visited it. Forcing
 * is also the more accurate option: a forced query spends the full visit
 * budget on that one move, where an unrestricted search might have given it
 * three visits before moving on.
 *
 * As in `backfill.ts`, a restricted query treats its own move as best, so its
 * root is meaningless. Loss is measured against the root of the unrestricted
 * reference query, read from `--ref`.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/** stdin and stdout are pipes; stderr is inherited, so it is null here. */
type Engine = ChildProcessByStdio<Writable, Readable, null>;
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { parse, type GameTree } from '../../src/sgf-parser.ts';
import { readGame, type Game } from '../../src/game.ts';
import { stoneAt, type Position } from '../../src/rules.ts';
import { toGtp } from './coords.ts';

const CONFIG = 'experiments/katago/analysis.cfg';
/** Matches `analyze.ts`, so a guess carries the same length of line. */
const PV_PLIES = 6;
const RULESETS = new Set(['japanese', 'chinese', 'tromp-taylor', 'aga', 'new-zealand', 'korean']);

/** One prompted move, as the summary screen exports it. */
interface PlayRow {
  readonly move: number;
  readonly phase: string;
  readonly guess: string;
  readonly actual: string;
  readonly hit: boolean;
  readonly ms: number;
}

interface RefRecord {
  readonly game: string;
  readonly turn: number;
  readonly rootScoreLead: number;
}

interface Response {
  readonly id: string;
  readonly moveInfos?: ReadonlyArray<{
    readonly move: string; readonly scoreLead: number; readonly pv?: readonly string[];
  }>;
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
  net: string; visits: number; play: string; ref: string; out: string; file: string;
} {
  const flags = new Map<string, string>();
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags.set(argv[i].slice(2), argv[++i]);
    else files.push(argv[i]);
  }
  const net: string | undefined = flags.get('net');
  const play: string | undefined = flags.get('play');
  const ref: string | undefined = flags.get('ref');
  const out: string | undefined = flags.get('out');
  if (!net || !play || !ref || !out || files.length !== 1) {
    throw new Error(
      'usage: guesses.ts --net <net> --visits <n> --play <playthrough.json>' +
      ' --ref <ref.jsonl> --out <file> <game.sgf>',
    );
  }
  return { net, play, ref, out, visits: Number(flags.get('visits') ?? 500), file: files[0] };
}

async function main(): Promise<void> {
  const { net, visits, play, ref, out, file } = parseArgs(process.argv.slice(2));

  const name: string = basename(file, '.sgf');
  const game: Game = readGame(parse(readFileSync(file, 'utf8')) as GameTree[]);
  const rows: readonly PlayRow[] = JSON.parse(readFileSync(play, 'utf8')).moves;

  const roots = new Map<number, number>();
  for (const line of readFileSync(ref, 'utf8').trim().split('\n').filter(Boolean)) {
    const r = JSON.parse(line) as RefRecord;
    if (r.game === name) roots.set(r.turn, r.rootScoreLead);
  }

  // The export carries the move the game played at each prompt. If that
  // disagrees with the SGF we are joining the wrong game, and every number
  // downstream would be quietly wrong rather than obviously missing.
  const queries: object[] = [];
  const pending: PlayRow[] = [];
  let mismatched = 0;
  for (const row of rows) {
    const turn: number = row.move - 1;
    const move = game.moves[turn];
    if (!move || move.index === null || toGtp(game.initial, move.index) !== row.actual) {
      mismatched++;
      continue;
    }
    const root: number | undefined = roots.get(turn);
    if (root === undefined) continue;
    const id = `q${pending.length}`;
    pending.push(row);
    queries.push({
      id,
      initialStones: initialStones(game.initial),
      moves: game.moves.map((m) => [m.color === 1 ? 'B' : 'W', toGtp(game.initial, m.index)]),
      rules: rulesOf(game),
      komi: komiOf(game),
      boardXSize: game.cols,
      boardYSize: game.rows,
      analyzeTurns: [turn],
      maxVisits: visits,
      allowMoves: [{ player: move.color === 1 ? 'B' : 'W',
                     moves: [row.guess], untilDepth: 1 }],
    });
  }
  if (mismatched > 0) {
    throw new Error(`[guesses] ${mismatched} of ${rows.length} rows disagree with ${name}.sgf`);
  }

  console.error(`[guesses] ${name}: ${queries.length} guesses to evaluate at ${visits} visits`);
  const katago: Engine = spawn(
    process.env.KATAGO ?? 'katago',
    ['analysis', '-config', CONFIG, '-model', net],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );

  const done: string[] = [];
  let seen = 0;
  await new Promise<void>((resolve) => {
    createInterface({ input: katago.stdout }).on('line', (line: string) => {
      const res = JSON.parse(line) as Response;
      if (res.isDuringSearch) return;
      seen++;
      const row: PlayRow = pending[Number(res.id.slice(1))];
      const info = res.moveInfos?.[0];
      const lead: number | undefined = info?.scoreLead;
      const root: number | undefined = roots.get(row.move - 1);
      if (lead !== undefined && root !== undefined && !res.error) {
        done.push(JSON.stringify({
          game: name, turn: row.move - 1, moveNumber: row.move, phase: row.phase,
          guess: row.guess, played: row.actual, hit: row.hit, ms: row.ms,
          guessLoss: root - lead, rootScoreLead: root,
          // Why the guess is worth what it is worth, not only how much.
          guessPv: info?.pv?.slice(0, PV_PLIES) ?? [],
        }));
      }
      if (seen % 25 === 0) console.error(`[guesses] ${seen}/${queries.length}`);
      if (seen >= queries.length) resolve();
    });
    for (const query of queries) katago.stdin.write(JSON.stringify(query) + '\n');
    katago.stdin.end();
  });
  katago.kill();

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, done.join('\n') + '\n');
  console.error(`[guesses] wrote ${done.length} evaluated guesses to ${out}`);
}

await main();
