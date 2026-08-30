/**
 * Analyze a playthrough: locate the record, judge the played moves, judge the
 * guesses.
 *
 *   node experiments/katago/dogfood.ts experiments/out/dogfood/*-play.json
 *
 * Everything else in this directory judges the move a game played. The point
 * of a playthrough is the move the *player* guessed, which needs the played
 * move as its comparison — so this runs the three stages together and names
 * their outputs after the export rather than after a band.
 *
 * Stage order is forced by the arithmetic, not by taste. Point loss is
 * measured against the root of an unrestricted search, so the forced queries
 * in stages two and three cannot run until stage one has produced those roots.
 *
 * The record is found by fingerprinting its moves rather than by reading its
 * metadata. Anonymizing a corpus rewrites the handles and drops the link back
 * to the original, which is the whole point of it, and would leave an export
 * with nothing to match on. Moves survive that, and identify a game at least
 * as well as a name did.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
import { parse, type GameTree } from '../../src/sgf-parser.ts';
import { readGame, type Game } from '../../src/game.ts';

const CORPUS = 'experiments/corpus';
/** What the handful of deepened positions get, whatever the rest of the run used. */
const DEEP_VISITS = 4000;

const NETS: Readonly<Record<string, { net: string; visits: number }>> = {
  // What §5 of the feasibility notes settles on, and what a session would run.
  product: { net: 'experiments/nets/g170e-b15c192-s1672170752-d466197061.bin.gz', visits: 50 },
  // The yardstick the product configuration is graded against.
  reference: { net: '/opt/homebrew/share/katago/g170-b40c256x2-s5095420928-d1229425124.bin.gz', visits: 500 },
};

/**
 * Identity of a record is its move sequence. Metadata can be rewritten — and
 * in this repository deliberately is — but the moves are the game.
 */
function fingerprint(sgf: string): string {
  const game: Game = readGame(parse(sgf) as GameTree[]);
  const body: string = game.moves.map((m) => `${m.color}${m.index ?? 'p'}`).join(',');
  return createHash('sha256').update(body).digest('hex').slice(0, 12);
}

/** Every corpus record, by fingerprint. Picks are copies, so bands win. */
function index(): Map<string, string> {
  const found = new Map<string, string>();
  for (const band of readdirSync(CORPUS)) {
    if (band === 'picks') continue;
    let entries: string[];
    try { entries = readdirSync(join(CORPUS, band)); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith('.sgf')) continue;
      const path: string = join(CORPUS, band, entry);
      found.set(fingerprint(readFileSync(path, 'utf8')), path);
    }
  }
  return found;
}

function run(script: string, args: readonly string[]): void {
  const result = spawnSync(process.execPath, [`experiments/katago/${script}`, ...args], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.status !== 0) throw new Error(`${script} exited ${result.status}`);
}

function parseArgs(argv: readonly string[]): { configs: string[]; force: boolean; plays: string[] } {
  const flags = new Map<string, string>();
  const plays: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--force') flags.set('force', 'yes');
    else if (argv[i].startsWith('--')) flags.set(argv[i].slice(2), argv[++i]);
    else plays.push(argv[i]);
  }
  const named: string = flags.get('config') ?? 'both';
  const configs: string[] = named === 'both' ? ['product', 'reference'] : [named];
  for (const name of configs) {
    if (!(name in NETS)) throw new Error(`unknown config ${name}; use product, reference or both`);
  }
  if (plays.length === 0) {
    throw new Error('usage: dogfood.ts [--config product|reference|both] [--force] <playthrough.json>...');
  }
  return { configs, force: flags.get('force') !== undefined, plays };
}

const { configs, force, plays } = parseArgs(process.argv.slice(2));
const corpus: Map<string, string> = index();
console.error(`[dogfood] ${corpus.size} records indexed, ${plays.length} playthrough(s)`);

for (const play of plays) {
  const doc = JSON.parse(readFileSync(play, 'utf8')) as { sgf: string; prompts?: number };
  const mark: string = fingerprint(doc.sgf);
  const sgf: string | undefined = corpus.get(mark);
  if (!sgf) {
    console.error(`[dogfood] ${basename(play)}: no corpus record matches ${mark} — skipped`);
    continue;
  }
  const stem: string = join('experiments/out/dogfood', basename(play).replace(/(-play)?\.json$/, ''));
  console.error(`\n[dogfood] ${basename(play)} -> ${sgf} (${doc.prompts ?? '?'} prompts)`);

  for (const name of configs) {
    const { net, visits } = NETS[name];
    // The product configuration is the interesting one to keep separate: its
    // whole purpose is to be compared against the reference, not merged with it.
    const out = `${stem}${name === 'reference' ? '' : `-${name}`}`;
    if (!force && existsSync(`${out}-guesses.jsonl`)) {
      console.error(`[dogfood] ${name}: already done, skipping (--force to redo)`);
      continue;
    }
    console.error(`[dogfood] ${name}: ${basename(net)} @ ${visits}`);
    run('analyze.ts', ['--net', net, '--visits', String(visits),
      '--label', `${basename(out)}-${name}`, '--out', `${out}-ref.jsonl`, sgf]);
    run('backfill.ts', ['--net', net, '--visits', String(visits),
      '--ref', `${out}-ref.jsonl`, '--out', `${out}-backfill.jsonl`, sgf]);
    run('guesses.ts', ['--net', net, '--visits', String(visits),
      '--play', play, '--ref', `${out}-ref.jsonl`, '--out', `${out}-guesses.jsonl`, sgf]);
    // A few positions only, so the extra budget costs seconds and buys the
    // review the one thing a truncated line cannot give it: the sequence
    // that punishes the mistake, played out to where it resolves.
    run('deepen.ts', ['--net', net, '--visits', String(DEEP_VISITS),
      '--play', play, '--stem', out, sgf]);
  }
}
console.error('\n[dogfood] done');
