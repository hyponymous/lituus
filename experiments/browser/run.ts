/**
 * Drive the in-browser benchmark and print the results.
 *
 * Stages the benchmark page into the vendored web-katrain checkout, exposes
 * the networks over its dev server, then runs each configuration in a real
 * Chromium and reports throughput.
 *
 *   node experiments/browser/run.ts [--visits 100] [--backends webgpu,wasm]
 *
 * Runs headed by default: headless Chromium can fall back to a software
 * WebGPU adapter, which produces numbers that look real and mean nothing.
 * The adapter is reported for every run so that failure is visible.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { chromium, type Browser, type Page } from 'playwright';
import { stage, shortName, VENDOR } from './stage.ts';

const PORT = 5199;

/**
 * Long enough for a slow WASM run to finish rather than look like a hang.
 * `page.evaluate` has no timeout of its own, so an engine that wedges would
 * otherwise hang the harness indefinitely.
 */
const EVAL_TIMEOUT_MS = 15 * 60 * 1000;

declare global {
  interface Window {
    __lituusBench?: (config: {
      modelUrl: string; backend: string; visits: number;
      warmupVisits: number; positionsUrl: string; evalRepeats: number;
    }) => Promise<BenchResult>;
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms / 1000}s`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer)) as Promise<T>;
}

interface BenchResult {
  readonly adapter: string;
  readonly backend: string | null;
  readonly loadMs: number;
  readonly warmupMs: number;
  readonly perPosition: Array<{ label: string; round: number; ms: number; visits: number }>;
  readonly perRoundMs: number[];
  readonly visitsPerSecond: number;
  readonly evalsPerSecond: number;
  readonly error?: string;
}

async function startDevServer(): Promise<ChildProcess> {
  const server: ChildProcess = spawn(
    'npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'],
    { cwd: VENDOR, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((ready, fail) => {
    const timer = setTimeout(() => fail(new Error('dev server did not start in 60s')), 60_000);
    const lines = createInterface({ input: server.stdout! }); // stdio is 'pipe' above
    lines.on('line', (line: string) => {
      if (line.includes(`localhost:${PORT}`)) { clearTimeout(timer); ready(); }
    });
    server.on('exit', (code) => fail(new Error(`dev server exited early (${code})`)));
  });
  return server;
}

function parseArgs(argv: readonly string[]): {
  visits: number; backends: Array<'webgpu' | 'wasm' | 'cpu'>; headed: boolean;
  only: string; positions: string; rounds: number;
} {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) flags.set(argv[i].slice(2), argv[i + 1] ?? '');
  return {
    visits: Number(flags.get('visits') ?? 100),
    backends: (flags.get('backends') ?? 'webgpu').split(',') as Array<'webgpu' | 'wasm' | 'cpu'>,
    headed: !argv.includes('--headless'),
    only: flags.get('only') ?? '',
    positions: flags.get('positions') ?? 'lituus-positions.json',
    rounds: Number(flags.get('rounds') ?? 1),
  };
}

async function main(): Promise<void> {
  const { visits, backends, headed, only, positions, rounds } = parseArgs(process.argv.slice(2));
  const nets: string[] = stage().filter((n) => n.includes(only));
  if (nets.length === 0) throw new Error(`no networks matched --only ${only}`);
  console.log(`nets: ${nets.map(shortName).join(', ')}`);
  console.log(`visits: ${visits}   backends: ${backends.join(', ')}   positions: ${positions}   headed: ${headed}\n`);

  const server: ChildProcess = await startDevServer();
  const browser: Browser = await chromium.launch({
    headless: !headed,
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
  });

  const rows: Array<{ net: string; backend: string; result: BenchResult }> = [];
  try {
    const page: Page = await browser.newPage();
    page.on('pageerror', (e) => console.error(`  page exception: ${e.message}`));
    page.on('response', (r) => {
      if (r.status() >= 400) console.error(`  ${r.status()} ${r.url()}`);
    });

    // Vite pre-bundles the engine's dependencies on first sight and then
    // full-reloads, which destroys any evaluate() in flight. Load once to
    // trigger that, settle, then reload onto the optimized bundle.
    const open = async (): Promise<void> => {
      await page.goto(`http://localhost:${PORT}/bench.html`, { waitUntil: 'networkidle' });
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForFunction(() => Boolean(window.__lituusBench), null, { timeout: 60_000 });
    };
    await open();

    for (const backend of backends) {
      for (const net of nets) {
        process.stdout.write(`running ${shortName(net)} on ${backend} ... `);
        const args = {
          modelUrl: `/nets/${net}`, backend, visits, warmupVisits: 8,
          positionsUrl: `/${positions}`, evalRepeats: 20, rounds,
        };
        const measure = (): Promise<BenchResult> => withTimeout(
          page.evaluate(
            // Non-null assertion: waitForFunction above established it exists.
            async (config) => window.__lituusBench!(config),
            args,
          ),
          EVAL_TIMEOUT_MS,
          `${shortName(net)} on ${backend}`,
        );

        // Vite can re-optimize and full-reload at any point, which destroys
        // the execution context mid-run. Reopen and take the measurement
        // again rather than losing the cell.
        let result: BenchResult;
        try {
          result = await measure();
        } catch (err) {
          if (!String(err).includes('Execution context was destroyed')) throw err;
          console.log('(context lost — reopening)');
          await open();
          result = await measure();
        }
        console.log(result.error ? `FAILED (${result.error})` : `${result.visitsPerSecond.toFixed(1)} visits/s`);
        rows.push({ net: shortName(net), backend, result });
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n${'net'.padEnd(10)} ${'backend'.padEnd(8)} ${'load'.padStart(8)} ${'warmup'.padStart(8)} ${'visits/s'.padStart(9)} ${'evals/s'.padStart(8)}  rounds@${visits}v`);
  for (const { net, backend, result } of rows) {
    if (result.error) { console.log(`${net.padEnd(10)} ${backend.padEnd(8)} ${result.error}`); continue; }
    const perPos: string = result.perRoundMs.map((ms) => `${(ms / 1000).toFixed(1)}s`).join(' ');
    console.log(`${net.padEnd(10)} ${(result.backend ?? backend).padEnd(8)} ` +
      `${(result.loadMs / 1000).toFixed(1).padStart(7)}s ${(result.warmupMs / 1000).toFixed(1).padStart(7)}s ` +
      `${result.visitsPerSecond.toFixed(1).padStart(9)} ` +
      `${result.evalsPerSecond.toFixed(1).padStart(8)}  ${perPos}`);
  }
  console.log(`\nadapter: ${rows[0]?.result.adapter ?? 'unknown'}`);
}

await main();
