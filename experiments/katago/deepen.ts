/**
 * Search the handful of moves that actually matter, harder and further.
 *
 *   node experiments/katago/deepen.ts --net <net> --visits 4000 \
 *     --play <playthrough.json> --stem experiments/out/dogfood/<name> \
 *     experiments/corpus/<band>/<game>.sgf
 *
 * Every other pass spends the same budget on every move, and truncates the
 * line to six plies, because a hundred positions at high visits is an hour and
 * a barely-searched tail is a lie. But the three or four moves a review is
 * actually about deserve better: a refutation two moves long says a move was
 * punished without ever showing the punishment landing.
 *
 * So this re-searches only the biggest mistakes — both the move the game
 * played and the move the player guessed — and keeps the whole variation.
 *
 * Only the lines are kept. The scores from this pass would be measured at a
 * different budget from every other number in the review, and two point-loss
 * figures for one move that disagree by a point is worse than one figure.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/** stdin and stdout are pipes; stderr is inherited, so it is null here. */
type Engine = ChildProcessByStdio<Writable, Readable, null>;
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse, type GameTree } from '../../src/sgf-parser.ts';
import { readGame, type Game } from '../../src/game.ts';
import { stoneAt, type Position } from '../../src/rules.ts';
import { toGtp } from './coords.ts';

const CONFIG = 'experiments/katago/analysis.cfg';
const RULESETS = new Set(['japanese', 'chinese', 'tromp-taylor', 'aga', 'new-zealand', 'korean']);
/** How many positions get the deep treatment. */
const DEEPEN = 3;
/** Long enough to show a sequence resolving, short enough to still be read. */
const PLIES = 12;

interface PlayRow {
  readonly move: number; readonly guess: string; readonly actual: string; readonly hit: boolean;
}
interface RefRow { readonly turn: number; readonly pointLoss: number | null }
interface GuessRow { readonly turn: number; readonly guessLoss: number }

interface Response {
  readonly id: string;
  readonly moveInfos?: ReadonlyArray<{ readonly move: string; readonly pv?: readonly string[] }>;
  readonly error?: string;
  readonly isDuringSearch?: boolean;
}

const load = <T,>(path: string): T[] =>
  readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);

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
  net: string; visits: number; play: string; stem: string; count: number; file: string;
} {
  const flags = new Map<string, string>();
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags.set(argv[i].slice(2), argv[++i]);
    else files.push(argv[i]);
  }
  const net: string | undefined = flags.get('net');
  const play: string | undefined = flags.get('play');
  const stem: string | undefined = flags.get('stem');
  if (!net || !play || !stem || files.length !== 1) {
    throw new Error(
      'usage: deepen.ts --net <net> --visits <n> --play <play.json> --stem <stem>' +
      ' [--count <n>] <game.sgf>',
    );
  }
  return {
    net, play, stem, visits: Number(flags.get('visits') ?? 4000),
    count: Number(flags.get('count') ?? DEEPEN), file: files[0],
  };
}

async function main(): Promise<void> {
  const { net, visits, play, stem, count, file } = parseArgs(process.argv.slice(2));

  const game: Game = readGame(parse(readFileSync(file, 'utf8')) as GameTree[]);
  const rows: readonly PlayRow[] = JSON.parse(readFileSync(play, 'utf8')).moves;

  const played = new Map<number, number>();
  for (const r of load<RefRow>(`${stem}-ref.jsonl`)) {
    if (r.pointLoss !== null) played.set(r.turn, r.pointLoss);
  }
  // The backfill is the trusted figure wherever it exists, as in `review.ts`.
  for (const r of load<{ turn: number; pointLoss: number }>(`${stem}-backfill.jsonl`)) {
    played.set(r.turn, r.pointLoss);
  }
  const guessed = new Map(load<GuessRow>(`${stem}-guesses.jsonl`).map((r) => [r.turn, r.guessLoss]));

  // A position is worth deepening if either move played there was expensive:
  // the reader wants the long line under whichever one went wrong.
  const worst = rows
    .map((r) => {
      const turn: number = r.move - 1;
      const a: number = played.get(turn) ?? 0;
      const b: number = guessed.get(turn) ?? 0;
      return { row: r, turn, weight: Math.max(a, b) };
    })
    .filter((r) => Number.isFinite(r.weight) && r.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, count);

  const queries: object[] = [];
  const pending: Array<{ turn: number; which: 'played' | 'guess' }> = [];
  for (const { row, turn } of worst) {
    const move = game.moves[turn];
    if (!move || move.index === null) continue;
    const player: string = move.color === 1 ? 'B' : 'W';
    const wants: Array<['played' | 'guess', string]> = row.hit
      ? [['played', row.actual]]
      : [['played', row.actual], ['guess', row.guess]];
    for (const [which, gtp] of wants) {
      queries.push({
        id: `q${pending.length}`,
        initialStones: initialStones(game.initial),
        moves: game.moves.map((m) => [m.color === 1 ? 'B' : 'W', toGtp(game.initial, m.index)]),
        rules: rulesOf(game),
        komi: komiOf(game),
        boardXSize: game.cols,
        boardYSize: game.rows,
        analyzeTurns: [turn],
        maxVisits: visits,
        allowMoves: [{ player, moves: [gtp], untilDepth: 1 }],
      });
      pending.push({ turn, which });
    }
  }

  if (queries.length === 0) {
    console.error('[deepen] nothing worth deepening');
    return;
  }
  console.error(`[deepen] ${worst.length} positions, ${queries.length} lines at ${visits} visits`);

  const katago: Engine = spawn(
    process.env.KATAGO ?? 'katago',
    ['analysis', '-config', CONFIG, '-model', net],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );

  const lines = new Map<number, { playedPv?: readonly string[]; guessPv?: readonly string[] }>();
  let seen = 0;
  await new Promise<void>((resolve) => {
    createInterface({ input: katago.stdout }).on('line', (line: string) => {
      const res = JSON.parse(line) as Response;
      if (res.isDuringSearch) return;
      seen++;
      const { turn, which } = pending[Number(res.id.slice(1))];
      const pv: readonly string[] | undefined = res.moveInfos?.[0]?.pv?.slice(0, PLIES);
      if (pv && !res.error) {
        const entry = lines.get(turn) ?? {};
        lines.set(turn, which === 'played' ? { ...entry, playedPv: pv } : { ...entry, guessPv: pv });
      }
      if (seen >= queries.length) resolve();
    });
    for (const query of queries) katago.stdin.write(JSON.stringify(query) + '\n');
    katago.stdin.end();
  });
  katago.kill();

  const out = `${stem}-deep.jsonl`;
  const records: string[] = [...lines.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([turn, pvs]) => JSON.stringify({ turn, visits, ...pvs }));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, records.join('\n') + '\n');
  console.error(`[deepen] wrote ${records.length} deepened positions to ${out}`);
}

await main();
