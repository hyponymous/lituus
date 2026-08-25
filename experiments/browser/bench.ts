/**
 * In-browser KataGo throughput benchmark.
 *
 * Copied into the vendored web-katrain checkout at run time (see run.ts) so
 * it can import that project's engine directly. It measures two things per
 * configuration:
 *
 *   - visits/second through the full MCTS, which is what actually bounds a
 *     lituus session;
 *   - evals/second through a raw batched forward pass, which isolates the
 *     network cost from search overhead.
 *
 * Nothing here is lituus code — it exists only to put a number on "how slow
 * is a bigger network in a browser".
 */
import { getKataGoEngineClient, resetKataGoEngineClientForTests } from './engine/katago/client';

type Player = 'black' | 'white';
type Intersection = Player | null;

interface BenchPosition {
  readonly label: string;
  readonly board: Intersection[][];
  readonly currentPlayer: Player;
  readonly moveHistory: Array<{ x: number; y: number; player: Player }>;
}

interface Fixture {
  readonly boardSize: number;
  readonly komi: number;
  readonly positions: readonly BenchPosition[];
}

export interface BenchConfig {
  readonly modelUrl: string;
  readonly backend: 'webgpu' | 'wasm' | 'cpu';
  readonly visits: number;
  readonly warmupVisits: number;
  readonly positionsUrl: string;
  readonly evalRepeats: number;
  /**
   * How many times to walk the whole position set. One pass takes seconds,
   * which is far too short to provoke thermal throttling — the failure that
   * matters on a phone, where a session is tens of minutes of intermittent
   * load rather than one burst. Several rounds make it visible as a rising
   * trend across otherwise identical work.
   */
  readonly rounds?: number;
}

export interface BenchResult {
  readonly config: BenchConfig;
  readonly adapter: string;
  readonly backend: string | null;
  readonly loadMs: number;
  /**
   * Time for the first search. `init()` returns before the network is parsed
   * and uploaded — that work happens lazily on first use — so this, not
   * `loadMs`, is where the cost of a large network actually shows up.
   */
  readonly warmupMs: number;
  readonly perPosition: Array<{ label: string; round: number; ms: number; visits: number }>;
  /** Total time for each full pass, so throttling shows up as a rising series. */
  readonly perRoundMs: number[];
  readonly visitsPerSecond: number;
  readonly evalsPerSecond: number;
  readonly error?: string;
}

/**
 * Minimal shape of the WebGPU adapter, declared locally: the vendored
 * project's tsconfig does not pull in the WebGPU lib types, and the
 * alternative is `any`.
 */
interface AdapterLike {
  readonly isFallbackAdapter?: boolean;
  readonly info?: { vendor?: string; architecture?: string; device?: string; description?: string };
  requestAdapterInfo?: () => Promise<{ vendor?: string; architecture?: string; device?: string; description?: string }>;
}
interface GpuLike { requestAdapter: () => Promise<AdapterLike | null> }

/**
 * Which GPU actually answered. Worth reporting loudly: a headless browser
 * that quietly falls back to a software adapter produces timings that look
 * like a measurement and are worthless.
 */
async function describeAdapter(): Promise<string> {
  const gpu: GpuLike | undefined = (navigator as Navigator & { gpu?: GpuLike }).gpu;
  if (!gpu) return 'no navigator.gpu';
  const adapter: AdapterLike | null = await gpu.requestAdapter();
  if (!adapter) return 'no adapter';
  const info = adapter.info ?? (await adapter.requestAdapterInfo?.()) ?? {};
  const parts: string[] = [info.vendor, info.architecture, info.device, info.description]
    .filter((s): s is string => Boolean(s));
  const fallback: string = adapter.isFallbackAdapter ? ' FALLBACK(software)' : '';
  return (parts.join(' / ') || 'unnamed adapter') + fallback;
}

/**
 * Called as the run passes each boundary. A phone that runs out of memory
 * takes the whole tab with it, so nothing can be reported after the fact —
 * the caller persists these instead, and reads them back on the next load.
 */
export type StageReporter = (stage: string, detail?: string) => void;

export async function runBench(config: BenchConfig, onStage: StageReporter = () => {}): Promise<BenchResult> {
  const adapter: string = await describeAdapter();
  const base = {
    config, adapter, backend: null, loadMs: 0, warmupMs: 0,
    perPosition: [], perRoundMs: [], visitsPerSecond: 0, evalsPerSecond: 0,
  };

  try {
    // A fresh worker per configuration: a reused one keeps the previous
    // model and backend warm, which is exactly what we are trying to time.
    resetKataGoEngineClientForTests();
    const client = getKataGoEngineClient();

    const fixture: Fixture = await (await fetch(config.positionsUrl)).json();

    // Pull the network down separately first. If the tab dies here it is the
    // raw download and decompression that cannot be afforded; if it survives
    // this and dies in init, the cost is parsing and uploading to the
    // backend. The worker's own fetch should then be served from cache.
    onStage('fetch-start');
    const raw: ArrayBuffer = await (await fetch(config.modelUrl)).arrayBuffer();
    onStage('fetch-done', `${(raw.byteLength / 1e6).toFixed(1)} MB`);
    const shared = { modelUrl: config.modelUrl, backend: config.backend, komi: fixture.komi, rules: 'japanese' as const };

    onStage('init-start');
    const loadStart: number = performance.now();
    await client.init(config.modelUrl, config.backend);
    const loadMs: number = performance.now() - loadStart;
    onStage('init-done', `${(loadMs / 1000).toFixed(1)}s`);

    const first: BenchPosition = fixture.positions[0];
    const warmupStart: number = performance.now();
    await client.analyze({
      ...shared, board: first.board, currentPlayer: first.currentPlayer,
      moveHistory: first.moveHistory, visits: config.warmupVisits,
      nnRandomize: false, reuseTree: false,
    });
    const warmupMs: number = performance.now() - warmupStart;
    onStage('warmup-done', `${(warmupMs / 1000).toFixed(1)}s`);

    const perPosition: Array<{ label: string; round: number; ms: number; visits: number }> = [];
    const perRoundMs: number[] = [];
    const rounds: number = Math.max(1, config.rounds ?? 1);
    for (let round = 1; round <= rounds; round++) {
      const roundStart: number = performance.now();
      for (const position of fixture.positions) {
        // Per position, not just per round: memory that grows with tree size
        // kills the tab partway through a round, and which position it
        // reaches says whether the cost tracks board occupancy.
        onStage(`round-${round}-${position.label}`);
        const start: number = performance.now();
        await client.analyze({
          ...shared, board: position.board, currentPlayer: position.currentPlayer,
          moveHistory: position.moveHistory, visits: config.visits,
          nnRandomize: false, reuseTree: false,
        });
        perPosition.push({ label: position.label, round, ms: performance.now() - start, visits: config.visits });
      }
      perRoundMs.push(performance.now() - roundStart);
      onStage(`round-${round}`, `${((performance.now() - roundStart) / 1000).toFixed(2)}s`);
    }

    const totalMs: number = perPosition.reduce((s, p) => s + p.ms, 0);
    const totalVisits: number = perPosition.reduce((s, p) => s + p.visits, 0);

    const evalStart: number = performance.now();
    for (let i = 0; i < config.evalRepeats; i++) {
      await client.evaluateBatch({
        modelUrl: config.modelUrl, backend: config.backend, rules: 'japanese',
        positions: fixture.positions.map((p) => ({
          board: p.board, currentPlayer: p.currentPlayer,
          moveHistory: p.moveHistory, komi: fixture.komi,
        })),
      });
    }
    const evalMs: number = performance.now() - evalStart;
    onStage('complete');
    const evals: number = config.evalRepeats * fixture.positions.length;

    return {
      config, adapter, backend: client.getEngineInfo().backend, loadMs, warmupMs, perPosition, perRoundMs,
      visitsPerSecond: (1000 * totalVisits) / totalMs,
      evalsPerSecond: (1000 * evals) / evalMs,
    };
  } catch (err) {
    onStage('error', err instanceof Error ? err.message : String(err));
    return { ...base, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

declare global {
  interface Window { __lituusBench?: (config: BenchConfig) => Promise<BenchResult> }
}
window.__lituusBench = runBench;
