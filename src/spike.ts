/**
 * Deployment spike for AI scoring — `#spike`.
 *
 * Everything measured in `docs/katago-feasibility.md` was served from
 * `localhost`. lituus is published to GitHub Pages under a base path, from a
 * host that cannot set a single response header, and the gap between those two
 * situations is where this feature can quietly fail. `docs/design-ai-scoring.md`
 * §10b.1 lists the questions; this page answers them on the real origin.
 *
 * Deliberately NOT gated on `import.meta.env.DEV`, unlike the `#dev` harness.
 * A diagnostic that only runs where the thing it diagnoses cannot fail is not a
 * diagnostic. It ships, it is reachable only by typing the fragment, and it
 * costs the ordinary bundle nothing because `main.ts` imports it dynamically.
 *
 * It stops short of evaluating a network. Parsing the header proves the bytes
 * arrived intact and in the format we think; a forward pass belongs to step 4.
 */

import { makeReport, type Step } from './report.ts';
import { parseKataGoModelV8 } from './engine/load-model-v8.ts';
import type { ParsedKataGoModelV8 } from './engine/model-types.ts';
import { NETWORK, networkUrl } from './engine/network.ts';
import type { SpikeWorkerReport } from './engine/spike-worker.ts';

export { SPIKE_HASH } from './engine/spike-hash.ts';

/** Where a downloaded network is kept between visits. */
const CACHE_NAME = 'lituus-nets-v1';

/** Gzip's two magic bytes. See `readNetwork` for why they are the real test. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

const bytes = (n: number): string => `${n.toLocaleString('en-US')} bytes`;

// ── The steps ────────────────────────────────────────────────────────────────

/**
 * Fetch the network, reporting progress, and hand back the raw bytes.
 *
 * The headers are printed rather than trusted. A static host may serve a `.gz`
 * with `Content-Encoding: gzip`, in which case the browser inflates it on the
 * way in and hides the header from us; or it may serve it as an opaque body, in
 * which case the bytes are still compressed. Both are legitimate, they need
 * opposite handling, and `localhost` will happily demonstrate only one of them.
 */
async function readNetwork(step: Step, url: string): Promise<Uint8Array> {
  step.detail(`GET ${url}`);
  const response: Response = await fetch(url);
  step.detail(`HTTP ${response.status} ${response.statusText}`);
  for (const header of ['content-type', 'content-encoding', 'content-length']) {
    step.detail(`${header}: ${response.headers.get(header) ?? '(absent)'}`);
  }
  if (!response.ok || !response.body) {
    throw new Error(`network not served: HTTP ${response.status}`);
  }

  const declared: number = Number(response.headers.get('content-length') ?? '0');
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    step.note(
      declared > 0
        ? `${Math.round((received / declared) * 100)}% — ${bytes(received)}`
        : bytes(received),
      'run',
    );
  }

  const all = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  step.detail(`received: ${bytes(received)}`);
  return all;
}

/**
 * Decompress, but only if the bytes are actually compressed.
 *
 * Sniffing the magic bytes rather than trusting the filename is the whole
 * point: it is correct whether or not the host inflated the body on the way in,
 * and it stays correct if the host changes its mind. Keying off `.gz` instead
 * would work on one of those hosts and throw on the other.
 */
async function decompress(step: Step, raw: Uint8Array): Promise<Uint8Array> {
  const compressed: boolean = raw[0] === GZIP_MAGIC[0] && raw[1] === GZIP_MAGIC[1];
  step.detail(
    `first bytes: ${[...raw.slice(0, 2)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`,
  );

  if (!compressed) {
    step.note('already inflated by the host', 'warn');
    step.detail('No gzip magic — the server sent Content-Encoding and the browser decoded it.');
    step.detail('Correct, and worth knowing: a second inflate here would have thrown.');
    return raw;
  }

  const stream: ReadableStream<Uint8Array> = new Blob([raw as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  const inflated = new Uint8Array(await new Response(stream).arrayBuffer());
  step.note(`gzip → ${bytes(inflated.length)}`);
  step.detail(`ratio: ${(inflated.length / raw.length).toFixed(2)}x`);
  return inflated;
}

/** Read the header. Proves the bytes are a network and not an error page. */
function parseHeader(step: Step, data: Uint8Array): void {
  const model: ParsedKataGoModelV8 = parseKataGoModelV8(data);
  step.note(`${model.trunk.numBlocks}×${model.trunk.trunkNumChannels}`);
  step.detail(`name: ${model.modelName}`);
  step.detail(`version: ${model.modelVersion}`);
  step.detail(`input channels: ${model.numInputChannels} spatial, ${model.numInputGlobalChannels} global`);
  step.detail(`trunk: ${model.trunk.numBlocks} blocks x ${model.trunk.trunkNumChannels} channels`);
  step.detail(`blocks: ${model.trunk.blocks.map((block) => block.kind).join(', ')}`);
}

/**
 * Store the compressed bytes and read them back.
 *
 * The compressed form, deliberately: it is the smaller thing to keep, and the
 * inflate is cheap next to the download this exists to avoid repeating.
 */
async function roundTripCache(step: Step, url: string, raw: Uint8Array): Promise<void> {
  if (!('caches' in globalThis)) {
    step.note('Cache API unavailable', 'bad');
    return;
  }
  const cache: Cache = await caches.open(CACHE_NAME);
  await cache.put(url, new Response(raw as BlobPart));
  const stored: Response | undefined = await cache.match(url);
  if (!stored) {
    step.note('stored, but not readable back', 'bad');
    return;
  }
  const back = new Uint8Array(await stored.arrayBuffer());
  const same: boolean = back.length === raw.length && back[0] === raw[0] && back.at(-1) === raw.at(-1);
  step.note(same ? `${bytes(back.length)} back` : 'read back differs', same ? 'ok' : 'bad');
  step.detail(`cache "${CACHE_NAME}" holds the network; a second visit skips the download.`);
}

/** Spawn the worker and relay what it finds. Resolves when it stops reporting. */
function runWorker(step: Step): Promise<void> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      // `new URL(..., import.meta.url)` is the form Vite rewrites for the
      // deployed base path. A bare string would resolve against the domain
      // root, which works in dev and 404s under `/lituus/`.
      worker = new Worker(new URL('./engine/spike-worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch (error: unknown) {
      step.note('worker would not start', 'bad');
      step.detail(error instanceof Error ? error.message : String(error));
      resolve();
      return;
    }

    // The worker reports per stage and never says it is finished, so the last
    // stage to arrive ends it. A stall shows as a stage that never lands, which
    // is more useful than a timeout that hides which one.
    const settle = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        worker.terminate();
        resolve();
      }, 2000);
    };
    let timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      step.note('no response in 60s', 'bad');
      worker.terminate();
      resolve();
    }, 60_000);

    worker.addEventListener('message', (event: MessageEvent<SpikeWorkerReport>): void => {
      const { stage, ok, detail } = event.data;
      step.detail(`${ok ? '✓' : '✗'} ${stage}: ${detail}`);
      if (stage === 'compute' && ok) step.note('webgpu computes');
      else if (stage === 'failed' || !ok) step.note(`${stage} failed`, 'bad');
      settle();
    });
    worker.addEventListener('error', (event: ErrorEvent): void => {
      step.note('worker error', 'bad');
      step.detail(event.message);
      settle();
    });
  });
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function renderSpike(root: HTMLElement): Promise<void> {
  const add: (title: string) => Step = makeReport(
    root,
    'Engine deployment spike',
    'What the deployed site can actually do: fetch the network same-origin, ' +
      'decompress it, read its header, cache it, and reach a GPU from a worker.',
  );
  const url: string = networkUrl();

  const context: Step = add('Context');
  context.note('read');
  context.detail(`base: ${import.meta.env.BASE_URL}`);
  context.detail(`origin: ${location.origin}`);
  context.detail(`secure context: ${window.isSecureContext}`);
  context.detail(`cross-origin isolated: ${globalThis.crossOriginIsolated}`);
  context.detail(`network: ${NETWORK.label}, expecting ${bytes(NETWORK.bytes)}`);

  const fetched: Step = add(`Fetch ${NETWORK.file}`);
  let raw: Uint8Array;
  try {
    raw = await readNetwork(fetched, url);
    const expected: boolean = raw.length === NETWORK.bytes;
    fetched.note(bytes(raw.length), expected ? 'ok' : 'warn');
    if (!expected) {
      // Not necessarily wrong: a host that inflated the body on the way in
      // legitimately delivers more bytes than the compressed file has.
      fetched.detail(`expected ${bytes(NETWORK.bytes)} — see the next step.`);
    }
  } catch (error: unknown) {
    fetched.note('failed', 'bad');
    fetched.detail(error instanceof Error ? error.message : String(error));
    fetched.detail('Everything below this needs the network and is skipped.');
    await runWorker(add('Worker, TensorFlow.js and WebGPU'));
    return;
  }

  const inflated: Step = add('Decompress');
  let data: Uint8Array;
  try {
    data = await decompress(inflated, raw);
  } catch (error: unknown) {
    inflated.note('failed', 'bad');
    inflated.detail(error instanceof Error ? error.message : String(error));
    await runWorker(add('Worker, TensorFlow.js and WebGPU'));
    return;
  }

  const header: Step = add('Parse model header');
  try {
    parseHeader(header, data);
  } catch (error: unknown) {
    header.note('failed', 'bad');
    header.detail(error instanceof Error ? error.message : String(error));
  }

  const cached: Step = add('Cache API round trip');
  try {
    await roundTripCache(cached, url, raw);
  } catch (error: unknown) {
    cached.note('failed', 'bad');
    cached.detail(error instanceof Error ? error.message : String(error));
  }

  await runWorker(add('Worker, TensorFlow.js and WebGPU'));
}
