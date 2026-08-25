/**
 * Hand-driven version of the benchmark, for devices we cannot attach a
 * driver to — principally a phone.
 *
 * Reports what the device can actually do before running anything, because
 * the interesting failure is silent: without a secure context there is no
 * `navigator.gpu`, TensorFlow.js quietly falls back to CPU, and the numbers
 * look entirely reasonable while measuring the wrong hardware.
 */
import { runBench, type BenchConfig, type BenchResult } from './lituus-bench';

/**
 * Breadcrumbs persisted across a tab crash. Running out of memory on iOS
 * kills the tab outright — no exception, no console, nothing to report — so
 * the only way to learn where a run died is to write each boundary down as
 * it is passed and read it back on the next load.
 */
const CRUMBS = 'lituus-bench-crumbs';

interface Crumb { readonly stage: string; readonly detail?: string; readonly atMs: number }

function readCrumbs(): Crumb[] {
  try { return JSON.parse(localStorage.getItem(CRUMBS) ?? '[]') as Crumb[]; } catch { return []; }
}

function writeCrumb(stage: string, detail?: string): void {
  const list: Crumb[] = readCrumbs();
  list.push({ stage, detail, atMs: Math.round(performance.now()) });
  try { localStorage.setItem(CRUMBS, JSON.stringify(list)); } catch { /* storage full or blocked */ }
}

interface Capabilities {
  readonly userAgent: string;
  readonly secureContext: boolean;
  readonly crossOriginIsolated: boolean;
  readonly sharedArrayBuffer: boolean;
  readonly webgpu: boolean;
  readonly adapter: string;
  readonly hardwareConcurrency: number;
  readonly screen: string;
  readonly devicePixelRatio: number;
}

interface AdapterLike {
  readonly isFallbackAdapter?: boolean;
  readonly info?: { vendor?: string; architecture?: string; device?: string; description?: string };
  requestAdapterInfo?: () => Promise<{ vendor?: string; architecture?: string; device?: string; description?: string }>;
}
interface GpuLike { requestAdapter: () => Promise<AdapterLike | null> }

async function capabilities(): Promise<Capabilities> {
  const gpu: GpuLike | undefined = (navigator as Navigator & { gpu?: GpuLike }).gpu;
  let adapter = 'none';
  if (gpu) {
    const got: AdapterLike | null = await gpu.requestAdapter().catch(() => null);
    if (got) {
      const info = got.info ?? (await got.requestAdapterInfo?.()) ?? {};
      const parts: string[] = [info.vendor, info.architecture, info.device, info.description]
        .filter((s): s is string => Boolean(s));
      adapter = (parts.join(' / ') || 'unnamed') + (got.isFallbackAdapter ? ' FALLBACK(software)' : '');
    } else {
      adapter = 'requestAdapter() returned null';
    }
  }
  return {
    userAgent: navigator.userAgent,
    secureContext: window.isSecureContext,
    crossOriginIsolated: window.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    webgpu: Boolean(gpu),
    adapter,
    hardwareConcurrency: navigator.hardwareConcurrency,
    screen: `${window.screen.width}x${window.screen.height}`,
    devicePixelRatio: window.devicePixelRatio,
  };
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, text?: string, attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

async function main(): Promise<void> {
  const app = document.getElementById('app') ?? document.body;
  const caps: Capabilities = await capabilities();

  app.append(el('h1', 'lituus engine benchmark'));

  // Anything left over means the previous run never reached 'complete'.
  const previous: Crumb[] = readCrumbs();
  if (previous.length > 0 && previous.at(-1)?.stage !== 'complete') {
    const died = el('p', '', { class: 'bad' });
    died.textContent = `Previous run died after: ${previous.at(-1)?.stage}` +
      ` (${previous.map((c) => c.stage + (c.detail ? ` ${c.detail}` : '')).join(' → ')})`;
    app.append(died);
  }

  // Lead with the thing that invalidates everything else.
  const verdict = el('p', '', { class: caps.webgpu ? 'ok' : 'bad' });
  verdict.textContent = caps.webgpu
    ? `WebGPU available — ${caps.adapter}`
    : `NO WebGPU${caps.secureContext ? '' : ' (page is not a secure context — use the https:// URL)'}. ` +
      'Results would measure the CPU fallback and are not comparable.';
  app.append(verdict);

  const capsBox = el('pre', JSON.stringify(caps, null, 2), { class: 'caps' });
  app.append(capsBox);

  const nets: string[] = await fetch('/lituus-nets.json').then((r) => r.json()).catch(() => []);
  const netSelect = el('select');
  for (const net of nets) netSelect.append(el('option', net, { value: net }));
  const visitsSelect = el('select');
  for (const v of ['10', '25', '50', '100', '200']) visitsSelect.append(el('option', v, { value: v }));
  visitsSelect.value = '50';
  const backendSelect = el('select');
  for (const b of ['webgpu', 'wasm', 'cpu']) backendSelect.append(el('option', b, { value: b }));
  const roundsSelect = el('select');
  for (const r of ['1', '5', '15', '40']) roundsSelect.append(el('option', r, { value: r }));
  const boardSelect = el('select');
  boardSelect.append(el('option', '19x19', { value: 'lituus-positions.json' }));
  boardSelect.append(el('option', '9x9', { value: 'lituus-positions-9x9.json' }));

  const controls = el('div', undefined, { class: 'controls' });
  for (const [label, node] of [['net', netSelect], ['visits', visitsSelect], ['rounds', roundsSelect], ['backend', backendSelect], ['board', boardSelect]] as const) {
    const wrap = el('label');
    wrap.append(el('span', label), node);
    controls.append(wrap);
  }
  const runButton = el('button', 'Run benchmark');
  const copyButton = el('button', 'Copy results JSON', { disabled: '' });
  controls.append(runButton, copyButton);
  app.append(controls);

  const status = el('p', 'Idle.', { class: 'status' });
  const output = el('pre', '', { class: 'out' });
  app.append(status, output);

  const results: Array<BenchResult & { capabilities: Capabilities; crumbs: Crumb[] }> = [];

  runButton.addEventListener('click', async () => {
    runButton.disabled = true;
    const config: BenchConfig = {
      modelUrl: `/nets/${netSelect.value}`,
      backend: backendSelect.value as BenchConfig['backend'],
      visits: Number(visitsSelect.value),
      warmupVisits: 8,
      positionsUrl: `/${boardSelect.value}`,
      evalRepeats: 10,
      rounds: Number(roundsSelect.value),
    };
    status.textContent = `Running ${netSelect.value} · ${config.visits} visits · ${config.backend} … this can take minutes.`;
    localStorage.removeItem(CRUMBS);
    writeCrumb('run-start', `${netSelect.value} v${config.visits} r${config.rounds}`);
    const started: number = performance.now();
    const result: BenchResult = await runBench(config, (stage, detail) => {
      writeCrumb(stage, detail);
      status.textContent = `${stage}${detail ? ` — ${detail}` : ''} …`;
    });
    results.push({ ...result, capabilities: caps, crumbs: readCrumbs() });

    status.textContent = result.error
      ? `Failed after ${((performance.now() - started) / 1000).toFixed(1)}s`
      : `Done in ${((performance.now() - started) / 1000).toFixed(1)}s — ` +
        `${result.visitsPerSecond.toFixed(1)} visits/s, ${result.evalsPerSecond.toFixed(1)} evals/s` +
        (result.perRoundMs.length > 1
          ? ` · rounds ${result.perRoundMs.map((ms) => (ms / 1000).toFixed(1)).join('s ')}s`
          : '');
    output.textContent = JSON.stringify(results, null, 2);
    copyButton.removeAttribute('disabled');
    runButton.disabled = false;
  });

  copyButton.addEventListener('click', async () => {
    const text: string = JSON.stringify(results, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      copyButton.textContent = 'Copied';
    } catch {
      // Clipboard access can be refused; selecting the text is the fallback.
      copyButton.textContent = 'Copy failed — select the text below';
      const range = document.createRange();
      range.selectNodeContents(output);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }
    setTimeout(() => { copyButton.textContent = 'Copy results JSON'; }, 3000);
  });
}

void main();
