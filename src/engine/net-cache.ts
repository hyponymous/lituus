/**
 * Getting the network into memory: cache, download, sniff, inflate.
 *
 * Everything here was established by the deployment spike (`src/spike.ts`,
 * `docs/design-ai-scoring.md` §10b.3) against the two hosts that actually serve
 * this file. It is the half of the engine that fails for reasons having nothing
 * to do with Go, and each of those reasons is a measurement rather than a
 * precaution.
 *
 * Deliberately free of TensorFlow.js and of the DOM, so the worker can import
 * it before deciding whether a GPU exists.
 */

import { NETWORK } from './network.ts';

/**
 * Where a downloaded network lives between visits.
 *
 * The Cache API rather than `localStorage`, which is the wrong size class by
 * three orders of magnitude and stores strings. Versioned in the name so that
 * changing what we store is a new cache rather than a migration.
 */
const CACHE_NAME = 'lituus-nets-v1';

/** Gzip's magic bytes. The reason they are checked is in `inflate`. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

/** How far along a download is. `total` is null when the host declares no length. */
export interface Progress {
  readonly received: number;
  readonly total: number | null;
}

export interface FetchOptions {
  readonly onProgress?: (progress: Progress) => void;
  readonly signal?: AbortSignal;
}

/**
 * Inflate the bytes, but only if they are actually compressed.
 *
 * **Sniff, never assume.** The spike measured two hosts disagreeing: `vite
 * preview` sends `Content-Encoding: gzip`, so the browser inflates on the way
 * in and hands us 39,776,212 bytes beginning `67 31`; GitHub Pages sends no
 * such header even when the request advertises gzip, so the bytes stay
 * compressed at 36,948,927 beginning `1f 8b`. Neither host is misconfigured.
 * Keying off the `.gz` extension passes its own tests on one of them and throws
 * on the other, and the failure only appears in production.
 */
export async function inflate(raw: Uint8Array): Promise<Uint8Array> {
  if (raw[0] !== GZIP_MAGIC[0] || raw[1] !== GZIP_MAGIC[1]) return raw;
  const stream: ReadableStream<Uint8Array> = new Blob([raw as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Read a whole response body, reporting progress as it arrives. */
async function readWithProgress(
  response: Response,
  onProgress?: (progress: Progress) => void,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());

  const declared: number = Number(response.headers.get('content-length') ?? '0');
  /*
   * A byte count that exceeds the declared length is not an error, and the
   * spike is why this is worth saying. A host that inflates on the way in sends
   * the *compressed* Content-Length with the *inflated* body, so the fraction
   * legitimately passes 1. Treating that as corruption would have rejected a
   * perfectly good download on the first host tried.
   */
  const total: number | null = declared > 0 ? declared : null;

  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.({ received, total });
  }

  const all = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return all;
}

async function openCache(): Promise<Cache | null> {
  // Absent in a private window in some browsers, and in any non-secure context.
  // Missing it costs a re-download, not a failure.
  if (!('caches' in globalThis)) return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

/**
 * The network's bytes, inflated and ready to parse.
 *
 * Cached in the form it arrived in rather than inflated: the compressed form is
 * the smaller thing to keep, and an inflate is milliseconds against a download
 * this exists to avoid repeating. A cache hit still reports progress, once, at
 * 100% — a caller drawing a bar should not have to special-case the fast path.
 */
export async function loadNetworkBytes(
  url: string,
  options: FetchOptions = {},
): Promise<Uint8Array> {
  const cache: Cache | null = await openCache();

  const hit: Response | undefined = await cache?.match(url).catch(() => undefined);
  if (hit) {
    const raw = new Uint8Array(await hit.arrayBuffer());
    try {
      const data: Uint8Array = checked(await inflate(raw), url);
      options.onProgress?.({ received: raw.length, total: raw.length });
      return data;
    } catch {
      // Something unusable is in the cache. Evict it and download again rather
      // than failing identically on every future visit — a poisoned cache that
      // survives a reload is the worst version of this bug, because the obvious
      // remedy makes no difference.
      await cache?.delete(url).catch(() => false);
    }
  }

  /*
   * A failed `fetch` throws a bare `TypeError: Failed to fetch`, which tells a
   * user nothing and reads like a bug in the page. What actually happened is
   * almost always one of two ordinary things — the connection dropped, or the
   * network file is not where the deploy put it — so say that instead.
   */
  let response: Response;
  try {
    response = await fetch(url, { signal: options.signal });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('The engine download did not complete. Check your connection and try again.');
  }
  if (!response.ok) {
    throw new Error(`The engine is not available from this site (HTTP ${response.status}).`);
  }
  /*
   * A dev server, and many static hosts, answer an unknown path with the app's
   * own `index.html` and a **200**. So "the file is missing" arrives looking
   * exactly like "the file is here", and the first thing to notice is the model
   * parser several layers away, complaining `Invalid int token: html>`. Catch it
   * at the door, where the URL is still in scope and can be named.
   */
  if ((response.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error(
      `The engine is not being served from this site: ${url} returned a web page. ` +
        'Run `npm run fetch:net:dev` to put the network where the dev server can find it.',
    );
  }

  let raw: Uint8Array;
  try {
    raw = await readWithProgress(response, options.onProgress);
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('The engine download was interrupted before it finished.');
  }

  // Checked *before* it is stored. Caching first and validating after would put
  // an error page in the cache and keep it there.
  const data: Uint8Array = checked(await inflate(raw), url);

  // Store the compressed form: it is the smaller thing to keep, and an inflate
  // is milliseconds against a download this exists to avoid repeating. A cache
  // failure never fails the load — a full quota means the next visit downloads
  // again, which is slow rather than broken.
  try {
    await cache?.put(url, new Response(raw as BlobPart));
  } catch {
    // Ignored on purpose. See above.
  }

  return data;
}

/**
 * A last look before the bytes go to the parser.
 *
 * A KataGo `.bin` opens with its own name as an ASCII token — `g170-b15c192-…`
 * — so anything that does not is not a network, whatever the status code said.
 * Worth its own check rather than trusting the content type: a host can serve
 * an error page as `application/octet-stream`, and the parser's own complaint
 * about the eleventh byte is not a message anyone can act on.
 */
function checked(data: Uint8Array, url: string): Uint8Array {
  const opening: string = new TextDecoder().decode(data.subarray(0, 64));
  if (!/^[\w.-]+\s/.test(opening)) {
    throw new Error(
      `What ${url} returned is not a KataGo network. ` +
        'The site may be serving an error page in its place.',
    );
  }
  return data;
}

/** Whether this network is already cached, so a caller can say "ready" honestly. */
export async function isNetworkCached(url: string): Promise<boolean> {
  const cache: Cache | null = await openCache();
  if (!cache) return false;
  try {
    return (await cache.match(url)) !== undefined;
  } catch {
    return false;
  }
}

/** Forget the cached network. For a diagnostic or a stuck download, not for normal use. */
export async function forgetNetwork(url: string): Promise<void> {
  const cache: Cache | null = await openCache();
  await cache?.delete(url).catch(() => false);
}

/** The size the download is expected to be, for copy written before it starts. */
export const NETWORK_BYTES: number = NETWORK.bytes;
