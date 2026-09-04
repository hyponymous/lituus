/**
 * Drive the readback benchmark and print what it found.
 *
 *   node experiments/browser/run-readback.ts \
 *     [--game test/fixtures/2024-07-09d.sgf] [--turn 79] \
 *     [--evals 40] [--reads 40] [--visits 50] \
 *     [--save experiments/out/readback-before.json] [--label before]
 *
 * The point of the `--save`/`--label` pair is that this is a *before and after*
 * instrument: one run means very little, and two runs on the same machine, the
 * same adapter and the same position mean a great deal. Save one before
 * changing anything, and diff.
 *
 * Runs headed. A headless Chromium answers `requestAdapter()` with a software
 * adapter, and the timings then measure the CPU while looking entirely
 * plausible — the trap `README.md` documents. The adapter is printed, and a
 * software one voids the run loudly.
 *
 * Do not run this while a KataGo sweep or the conformance run is going: they
 * contend for the same GPU and both sets of timings become fiction.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { NETWORK } from '../../src/engine/network.ts';
import type { ReadbackRequest, ReadbackResult, Timing } from './readback/main.ts';

const HERE: string = fileURLToPath(new URL('.', import.meta.url));
const REPO: string = resolve(HERE, '../..');
const PORT = 5199;

/** Loading 37MB and compiling shaders is the slow part; the rest is seconds. */
const RUN_TIMEOUT_MS = 20 * 60 * 1000;

interface Options {
  readonly game: string;
  readonly turn: number;
  readonly evals: number;
  readonly reads: number;
  readonly visits: number;
  readonly save: string | null;
  readonly label: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) flags.set(argv[i].replace(/^--/, ''), argv[i + 1]);
  return {
    game: flags.get('game') ?? 'test/fixtures/2024-07-09d.sgf',
    // Mid-game by default: an empty board is the cheapest position there is and
    // the least like the ones a session spends its time on.
    turn: Number(flags.get('turn') ?? 79),
    evals: Number(flags.get('evals') ?? 40),
    reads: Number(flags.get('reads') ?? 40),
    visits: Number(flags.get('visits') ?? 50),
    save: flags.get('save') ?? null,
    label: flags.get('label') ?? null,
  };
}

async function startDevServer(): Promise<ChildProcess> {
  const server: ChildProcess = spawn(
    'npx',
    [
      'vite', '--config', 'experiments/browser/vite.readback.config.ts',
      '--port', String(PORT), '--strictPort',
    ],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((ready, reject) => {
    const timer = setTimeout(() => reject(new Error('vite did not start in 60s')), 60_000);
    server.stdout?.on('data', (chunk: Buffer) => {
      const text: string = chunk.toString();
      process.stderr.write(text);
      if (text.includes('ready in') || text.includes('Local:')) {
        clearTimeout(timer);
        ready();
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

const line = (what: string, timing: Timing): string =>
  `${what.padEnd(34)} ${timing.meanMs.toFixed(2).padStart(7)}  ` +
  `${timing.medianMs.toFixed(2).padStart(7)}  ` +
  `${timing.minMs.toFixed(2).padStart(7)}  ${timing.maxMs.toFixed(2).padStart(7)}`;

async function main(): Promise<void> {
  const options: Options = parseArgs(process.argv.slice(2));
  const sgf: string = readFileSync(join(REPO, options.game), 'utf8');

  console.log(
    `${NETWORK.label}, ${options.game} turn ${options.turn}, ` +
      `${options.evals} passes, ${options.reads} reads` +
      `${options.label ? ` — ${options.label}` : ''}`,
  );

  const server: ChildProcess = await startDevServer();
  const browser: Browser = await chromium.launch({ headless: false });
  let result: ReadbackResult;
  try {
    const page: Page = await browser.newPage();
    page.on('console', (message) => console.error(`[page] ${message.text()}`));
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__lituusReadback !== undefined);

    const request: ReadbackRequest = {
      modelUrl: `/${NETWORK.file}`,
      sgf,
      turn: options.turn,
      evals: options.evals,
      reads: options.reads,
      visits: options.visits,
    };
    result = await withTimeout(
      page.evaluate((payload: ReadbackRequest) => window.__lituusReadback!(payload), request),
      RUN_TIMEOUT_MS,
      'readback run',
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
  console.log(`backend: ${result.backend}, model: ${result.model}`);
  if (/software|swiftshader|llvmpipe|lavapipe/i.test(result.adapter)) {
    console.log('WARNING: software adapter — these timings measure the CPU and are void');
  }
  console.log(`load ${(result.loadMs / 1000).toFixed(1)}s, first pass ${result.warmupMs.toFixed(0)}ms\n`);

  console.log(`${''.padEnd(34)}    mean   median      min      max`);
  console.log(line('forward pass', result.evaluate));
  for (const read of result.reads) console.log(line(`read ${read.label}`, read.timing));

  // One read as a share of one pass. Deliberately per *read* rather than per
  // pass: how many reads a pass makes is what the code decides and what a
  // change to it moves, so this line stays true on both sides of one.
  const perPass: number = result.evaluate.meanMs;
  console.log();
  for (const read of result.reads) {
    const share: number = (100 * read.timing.meanMs) / perPass;
    console.log(`one read ${read.label} is ${share.toFixed(1)}% of a forward pass`);
  }
  /*
   * The split between what a read costs to *make* and what it costs to carry,
   * from the two sizes measured. A straight line through two points is a crude
   * model and the right one here: the question is only whether the intercept is
   * large, because the intercept is what is paid per call and therefore all
   * that collapsing four calls into one can win back. The payload term is the
   * same bytes either way.
   */
  if (result.reads.length === 2) {
    const [big, small] = result.reads;
    const perFloat: number =
      (big.timing.medianMs - small.timing.medianMs) / (big.floats - small.floats);
    const fixed: number = small.timing.medianMs - perFloat * small.floats;
    console.log(
      `\nfitted: ${fixed.toFixed(2)}ms per call + ${(perFloat * 1000).toFixed(3)}us per float`,
    );
    console.log(
      `each read avoided is worth about ${fixed.toFixed(2)}ms, ` +
        `${((100 * fixed) / perPass).toFixed(1)}% of a forward pass`,
    );
  }
  if (result.promptMs !== null) {
    console.log(
      `\none prompt at ${result.promptVisits} visits: ${(result.promptMs / 1000).toFixed(2)}s ` +
        '(root search plus two forced searches)',
    );
  }

  if (options.save) {
    const saved = { label: options.label, options, result, when: new Date().toISOString() };
    writeFileSync(join(REPO, options.save), `${JSON.stringify(saved, null, 2)}\n`);
    console.log(`\nsaved to ${options.save}`);
  }
}

await main();
