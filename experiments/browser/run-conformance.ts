/**
 * §9.1: does our search agree with native KataGo about what a move cost?
 *
 *   node experiments/browser/run-conformance.ts \
 *     [--game test/fixtures/2024-07-09d.sgf] \
 *     [--ref experiments/out/fixture] \
 *     [--visits 50] [--turns 0,1,40,79,120,199] [--limit 20]
 *
 * This is the only instrument that finds a mistranscribed constant. Every
 * accuracy figure in `docs/katago-feasibility.md` came from native KataGo; the
 * browser numbers so far are throughput only. A hand-written search that is
 * fast, correct in its own terms, and differently calibrated would produce
 * point losses that look entirely reasonable and mean something else — and
 * nothing on screen would show it (`docs/design-ai-scoring.md` §11, §9.1).
 *
 * **The bar is not move-for-move agreement.** Two PUCT searches with different
 * floating-point orderings will diverge, and the reference runs used eight
 * search threads whose visit interleaving KataGo cannot reproduce either. The
 * bar is that a point loss lands on the same side of the thresholds the PRD
 * quotes, which is what the summary below reports.
 *
 * Runs headed, for the reason `README.md` gives: a headless Chromium answers
 * `requestAdapter()` with a *software* adapter and returns plausible timings
 * that measure the CPU. The adapter is printed for every run.
 *
 * Regenerating the reference for the committed fixture needs a KataGo binary
 * and the network, and is documented in
 * `docs/exploration-forward-pass-parity.md` §8 — `analyze.ts` writes
 * `ref.jsonl` and `backfill.ts` repairs the moves the root search skipped.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { BEAT_MARGIN, BLUNDER_LOSS, MISLEADING_LOSS } from '../../src/analysis.ts';
import { NETWORK } from '../../src/engine/network.ts';
import { joinRecorded, type RecordedRow } from '../../src/replay.ts';
import type { ConformanceRequest, ConformanceResult, ConformanceRow } from './conformance/main.ts';

const HERE: string = fileURLToPath(new URL('.', import.meta.url));
const REPO: string = resolve(HERE, '../..');
const PORT = 5198;

/** A slow position at 50 visits is seconds, not minutes; this is a hang detector. */
const EVAL_TIMEOUT_MS = 60 * 60 * 1000;

interface Options {
  readonly game: string;
  readonly refDir: string;
  readonly visits: number;
  readonly turns: number[] | null;
  readonly limit: number | null;
}

function parseArgs(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) flags.set(argv[i].replace(/^--/, ''), argv[i + 1]);
  const turns: string | undefined = flags.get('turns');
  const limit: string | undefined = flags.get('limit');
  return {
    game: flags.get('game') ?? 'test/fixtures/2024-07-09d.sgf',
    refDir: flags.get('ref') ?? 'experiments/out/fixture',
    visits: Number(flags.get('visits') ?? 50),
    turns: turns ? turns.split(',').map(Number) : null,
    limit: limit ? Number(limit) : null,
  };
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line: string) => line.trim() !== '')
    .map((line: string) => JSON.parse(line) as T);
}

async function startDevServer(): Promise<ChildProcess> {
  const server: ChildProcess = spawn(
    'npx',
    [
      'vite', '--config', 'experiments/browser/vite.conformance.config.ts',
      '--port', String(PORT), '--strictPort',
    ],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('vite did not start in 60s')), 60_000);
    server.stdout?.on('data', (chunk: Buffer) => {
      const text: string = chunk.toString();
      process.stderr.write(text);
      if (text.includes('ready in') || text.includes('Local:')) {
        clearTimeout(timer);
        resolveReady();
      }
    });
  });
  return server;
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms / 1000}s`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Where a loss falls relative to the thresholds the product actually quotes. */
function band(loss: number): string {
  if (loss >= BLUNDER_LOSS) return 'blunder';
  if (loss >= MISLEADING_LOSS) return 'costly';
  if (loss > BEAT_MARGIN) return 'loose';
  return 'fine';
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

async function main(): Promise<void> {
  const options: Options = parseArgs(process.argv.slice(2));
  const sgf: string = readFileSync(join(REPO, options.game), 'utf8');

  const reference: RecordedRow[] = joinRecorded(
    readJsonl(join(REPO, options.refDir, 'ref.jsonl')),
    [],
    readJsonl(join(REPO, options.refDir, 'backfill.jsonl')),
  );
  if (reference.length === 0) {
    throw new Error(
      `No reference rows in ${options.refDir}. See the header of this file for how to make them.`,
    );
  }
  // The reference files carry a turn per row; `joinRecorded` keeps move numbers,
  // so re-read the turns from the raw analysis rows to line the two up.
  const turnsOf: number[] = readJsonl<{ turn: number }>(
    join(REPO, options.refDir, 'ref.jsonl'),
  ).map((row) => row.turn);

  let wanted: Array<{ turn: number; row: RecordedRow }> = turnsOf.map((turn, i) => ({
    turn,
    row: reference[i],
  }));
  if (options.turns) {
    const keep = new Set(options.turns);
    wanted = wanted.filter(({ turn }) => keep.has(turn));
  }
  if (options.limit !== null) wanted = wanted.slice(0, options.limit);

  console.log(
    `comparing ${wanted.length} positions at ${options.visits} visits, ` +
      `${NETWORK.label}, against ${options.refDir}`,
  );

  const server: ChildProcess = await startDevServer();
  const browser: Browser = await chromium.launch({ headless: false });
  let result: ConformanceResult;
  try {
    const page: Page = await browser.newPage();
    page.on('console', (message) => console.error(`[page] ${message.text()}`));
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__lituusConformance !== undefined);

    const request: ConformanceRequest = {
      modelUrl: `/${NETWORK.file}`,
      sgf,
      visits: options.visits,
      turns: wanted.map(({ turn, row }) => ({ turn, played: row.played })),
    };
    result = await withTimeout(
      page.evaluate(
        (payload: ConformanceRequest) => window.__lituusConformance!(payload),
        request,
      ),
      EVAL_TIMEOUT_MS,
      'conformance run',
    );
  } finally {
    await browser.close();
    server.kill();
  }

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }

  console.log(`\nadapter: ${result.adapter}`);
  console.log(`backend: ${result.backend}, model: ${result.model}, load ${result.loadMs.toFixed(0)}ms`);
  if (/software|swiftshader|llvmpipe|lavapipe/i.test(result.adapter)) {
    console.log('WARNING: software adapter — these timings measure the CPU and are void');
  }
  console.log();

  const byTurn = new Map(wanted.map(({ turn, row }) => [turn, row]));
  const lossDeltas: number[] = [];
  const rootDeltas: number[] = [];
  let bestAgreed = 0;
  let bandChanged = 0;
  let compared = 0;

  console.log(
    'turn  played  ours      theirs    Δloss    root Δ   best        ms',
  );
  for (const row of result.rows) {
    const ref: RecordedRow | undefined = byTurn.get(row.turn);
    if (!ref || ref.pointLoss === null || row.pointLoss === null) continue;
    compared += 1;
    const lossDelta: number = row.pointLoss - ref.pointLoss;
    const rootDelta: number = row.rootScoreLead - ref.rootScoreLead;
    lossDeltas.push(Math.abs(lossDelta));
    rootDeltas.push(Math.abs(rootDelta));
    const agreed: boolean = row.best === ref.best;
    if (agreed) bestAgreed += 1;
    const sameBand: boolean = band(row.pointLoss) === band(ref.pointLoss);
    if (!sameBand) bandChanged += 1;
    console.log(
      `${String(row.turn).padStart(4)}  ${row.played.padEnd(6)}  ` +
        `${row.pointLoss.toFixed(3).padStart(8)}  ${ref.pointLoss.toFixed(3).padStart(8)}  ` +
        `${lossDelta.toFixed(3).padStart(7)}  ${rootDelta.toFixed(3).padStart(7)}  ` +
        `${(agreed ? `${row.best}` : `${row.best}/${ref.best}`).padEnd(10)}  ` +
        `${row.ms.toFixed(0).padStart(5)}` +
        `${sameBand ? '' : `  BAND ${band(ref.pointLoss)} -> ${band(row.pointLoss)}`}`,
    );
  }

  lossDeltas.sort((a, b) => a - b);
  rootDeltas.sort((a, b) => a - b);
  console.log(`\ncompared ${compared} positions`);
  console.log(
    `point loss  |Δ| median ${quantile(lossDeltas, 0.5).toFixed(3)}  ` +
      `p90 ${quantile(lossDeltas, 0.9).toFixed(3)}  ` +
      `max ${(lossDeltas[lossDeltas.length - 1] ?? NaN).toFixed(3)}`,
  );
  console.log(
    `root lead   |Δ| median ${quantile(rootDeltas, 0.5).toFixed(3)}  ` +
      `p90 ${quantile(rootDeltas, 0.9).toFixed(3)}  ` +
      `max ${(rootDeltas[rootDeltas.length - 1] ?? NaN).toFixed(3)}`,
  );
  console.log(`best move agreed on ${bestAgreed}/${compared}`);
  console.log(
    `verdict band changed on ${bandChanged}/${compared} ` +
      `(fine <${BEAT_MARGIN}, costly >=${MISLEADING_LOSS}, blunder >=${BLUNDER_LOSS})`,
  );
  console.log(
    '\nThe band count is the figure that matters. Two searches disagreeing by a\n' +
      'tenth of a point is expected; one of them calling a move a blunder that the\n' +
      'other calls fine is a transcription bug.',
  );
}

await main();
