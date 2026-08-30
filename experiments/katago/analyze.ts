/**
 * Run one KataGo configuration over a corpus of SGFs and record, for every
 * position that lituus would prompt on, what the engine thought of the move
 * that was actually played.
 *
 * The output is one JSON object per analyzed position. Two runs with
 * different networks or visit counts produce two such files, and
 * `compare.ts` measures how far apart they are.
 *
 *   node experiments/katago/analyze.ts \
 *     --net <path/to/net.bin.gz> --visits 500 --label b6c96-v500 \
 *     --out experiments/out/b6c96-v500.jsonl corpus/*.sgf
 *
 * The engine binary is taken from $KATAGO, defaulting to `katago` on PATH.
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
import { stoneAt, toRowCol, type Position } from '../../src/rules.ts';
import { toGtp } from './coords.ts';

const CONFIG = 'experiments/katago/analysis.cfg';
const DEFAULT_KOMI = 6.5;

/** SGF `RU` values KataGo names differently, or not at all. */
const RULESETS = new Set([
  'japanese', 'chinese', 'tromp-taylor', 'aga', 'new-zealand', 'korean',
]);

interface MoveInfo {
  readonly move: string;
  readonly order: number;
  readonly visits: number;
  readonly prior: number;
  readonly scoreLead: number;
  readonly winrate: number;
  readonly pv?: readonly string[];
}

/**
 * How the search expects the game to go on after a move. Point loss says a
 * move cost four points; this says why, which is the difference between a
 * score and an explanation.
 *
 * Truncated deliberately. At 50 visits the variations run four to eight moves
 * and the tail is barely searched, so showing the whole line would imply a
 * confidence the search does not have. Six plies is enough to show why a move
 * was bad — the move, the punishment, and the shape it leaves — without
 * running past where the search has actually looked. The handful of moves
 * that deserve a longer line get one from `deepen.ts` instead.
 */
const PV_PLIES = 6;

function pvOf(info: MoveInfo | undefined): readonly string[] {
  return info?.pv?.slice(0, PV_PLIES) ?? [];
}

interface Response {
  readonly id: string;
  readonly turnNumber: number;
  readonly moveInfos?: readonly MoveInfo[];
  readonly rootInfo?: { readonly scoreLead: number; readonly visits: number };
  readonly error?: string;
  readonly warning?: string;
  readonly isDuringSearch?: boolean;
}

/** One prompted position, as this configuration saw it. */
interface Record_ {
  readonly game: string;
  readonly turn: number;
  readonly moveNumber: number;
  readonly color: 'B' | 'W';
  readonly played: string;
  /**
   * Points given up by the played move: the search's own estimate of the
   * position minus its estimate of the played move. Measured against
   * `rootInfo`, not against the top child — `order` ranks children by visits,
   * so a lightly visited sibling can carry a higher (and noisier) score lead
   * and make the difference come out negative.
   *
   * Null when the search never visited the played move at all, which is a
   * finding in its own right: no engine number can be shown for that guess.
   */
  readonly pointLoss: number | null;
  /** Null when the search never visited the played move at all. */
  readonly playedOrder: number | null;
  readonly playedPrior: number | null;
  readonly playedVisits: number | null;
  readonly best: string;
  readonly bestScoreLead: number;
  /** The first few plies the search expects after the played move, and after its own. */
  readonly playedPv: readonly string[];
  readonly bestPv: readonly string[];
  /**
   * What the network's intuition proposed before any reading, and what
   * reading then made of it. Where the most natural-looking move turns out
   * to lose, the position punishes intuition — which is a far better proxy
   * for difficulty than how concentrated the policy is.
   */
  readonly topPolicy: string;
  readonly topPolicyPrior: number;
  /** Points given up by the most natural-looking move. */
  readonly topPolicyLoss: number;
  /** Prior of the move search settled on: low means it had to be read. */
  readonly bestPrior: number;
  readonly rootScoreLead: number;
  readonly candidates: number;
  readonly rootVisits: number;
}

function komiOf(game: Game): number {
  const raw: number = Number(game.meta.komi);
  return Number.isFinite(raw) ? raw : DEFAULT_KOMI;
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

function buildQuery(
  id: string, game: Game, maxVisits: number, turns?: ReadonlySet<number>,
): object {
  const moves: Array<[string, string]> = game.moves.map((m) => [
    m.color === 1 ? 'B' : 'W',
    toGtp(game.initial, m.index),
  ]);
  // analyzeTurns[i] is the position *after* i moves, i.e. before moves[i] —
  // exactly the position a guesser is shown. Passes are replayed but never
  // prompted on, matching promptableMoves().
  const analyzeTurns: number[] = game.moves
    .map((m, i) => (m.index === null ? -1 : i))
    .filter((i) => i >= 0 && (turns === undefined || turns.has(i)));

  return {
    id,
    initialStones: initialStones(game.initial),
    moves,
    rules: rulesOf(game),
    komi: komiOf(game),
    boardXSize: game.cols,
    boardYSize: game.rows,
    analyzeTurns,
    maxVisits,
    includePolicy: false,
  };
}

function toRecord(game: Game, name: string, res: Response): Record_ | null {
  const infos: readonly MoveInfo[] = res.moveInfos ?? [];
  if (infos.length === 0) return null;

  const move = game.moves[res.turnNumber];
  const played: string = toGtp(game.initial, move.index);
  const best: MoveInfo = infos[0];
  const hit: MoveInfo | undefined = infos.find((m) => m.move === played);
  const root: number = res.rootInfo?.scoreLead ?? best.scoreLead;
  const topPolicy: MoveInfo = infos.reduce((a, b) => (b.prior > a.prior ? b : a));

  return {
    game: name,
    turn: res.turnNumber,
    moveNumber: move.number,
    color: move.color === 1 ? 'B' : 'W',
    played,
    pointLoss: hit ? root - hit.scoreLead : null,
    playedOrder: hit ? hit.order : null,
    playedPrior: hit ? hit.prior : null,
    playedVisits: hit ? hit.visits : null,
    best: best.move,
    bestScoreLead: best.scoreLead,
    playedPv: pvOf(hit),
    bestPv: pvOf(best),
    topPolicy: topPolicy.move,
    topPolicyPrior: topPolicy.prior,
    topPolicyLoss: root - topPolicy.scoreLead,
    bestPrior: best.prior,
    rootScoreLead: root,
    candidates: infos.length,
    rootVisits: res.rootInfo?.visits ?? 0,
  };
}

/**
 * A sample to analyze, as `sample.ts` wrote it: game name to selected turns.
 * Absent means every prompted position, which is what a screening run wants.
 */
function readPositions(path: string): Map<string, Set<number>> {
  const selected = new Map<string, Set<number>>();
  for (const line of readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)) {
    const { game, turn } = JSON.parse(line) as { game: string; turn: number };
    let turns: Set<number> | undefined = selected.get(game);
    if (!turns) { turns = new Set(); selected.set(game, turns); }
    turns.add(turn);
  }
  return selected;
}

function parseArgs(argv: readonly string[]): {
  net: string; visits: number; out: string; label: string;
  positions: string | undefined; files: string[];
} {
  const flags = new Map<string, string>();
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags.set(argv[i].slice(2), argv[++i]);
    else files.push(argv[i]);
  }
  const net: string | undefined = flags.get('net');
  const out: string | undefined = flags.get('out');
  if (!net || !out || files.length === 0) {
    throw new Error(
      'usage: analyze.ts --net <net> --visits <n> --out <file> [--label <s>]' +
      ' [--positions <sample.jsonl>] <sgf...>',
    );
  }
  return {
    net,
    visits: Number(flags.get('visits') ?? 500),
    out,
    label: flags.get('label') ?? basename(net),
    positions: flags.get('positions'),
    files,
  };
}

async function main(): Promise<void> {
  const { net, visits, out, label, positions, files } = parseArgs(process.argv.slice(2));
  const selected: Map<string, Set<number>> | undefined =
    positions === undefined ? undefined : readPositions(positions);

  const games = new Map<string, Game>();
  const queries: object[] = [];
  for (const file of files) {
    const name: string = basename(file, '.sgf');
    const turns: Set<number> | undefined = selected?.get(name);
    // A sampled run skips whole games the sample did not reach into.
    if (selected !== undefined && turns === undefined) continue;
    const trees: GameTree[] = parse(readFileSync(file, 'utf8'));
    const game: Game = readGame(trees);
    games.set(name, game);
    queries.push(buildQuery(name, game, visits, turns));
  }

  const expected: number = selected === undefined
    ? [...games.values()].reduce((n, g) => n + g.moves.filter((m) => m.index !== null).length, 0)
    : [...selected.values()].reduce((n, t) => n + t.size, 0);
  console.error(`[${label}] ${games.size} games, ${expected} positions, ${visits} visits`);

  const katago: Engine = spawn(
    process.env.KATAGO ?? 'katago',
    ['analysis', '-config', CONFIG, '-model', net],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );

  const records: Record_[] = [];
  const started: number = Date.now();
  const done: Promise<void> = new Promise((resolve, reject) => {
    const lines = createInterface({ input: katago.stdout });
    lines.on('line', (line: string) => {
      const res: Response = JSON.parse(line);
      if (res.error) return void console.error(`[${label}] error: ${res.error}`);
      if (res.isDuringSearch) return;

      const game: Game | undefined = games.get(res.id);
      if (!game) return;
      const record: Record_ | null = toRecord(game, res.id, res);
      if (record) records.push(record);

      if (records.length % 25 === 0 || records.length === expected) {
        const rate: string = (records.length / ((Date.now() - started) / 1000)).toFixed(2);
        console.error(`[${label}] ${records.length}/${expected} (${rate}/s)`);
      }
      if (records.length >= expected) lines.close();
    });
    lines.on('close', resolve);
    katago.on('error', reject);
  });

  for (const query of queries) katago.stdin.write(`${JSON.stringify(query)}\n`);
  katago.stdin.end();
  await done;
  katago.kill();

  records.sort((a, b) => a.game.localeCompare(b.game) || a.turn - b.turn);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const elapsed: number = (Date.now() - started) / 1000;
  console.error(`[${label}] wrote ${records.length} records to ${out} in ${elapsed.toFixed(1)}s`);
}

await main();
