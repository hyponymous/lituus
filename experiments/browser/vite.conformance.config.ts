/**
 * A dev server for the conformance run.
 *
 * Three departures from the app's own config, each forced:
 *
 * - `base: '/'`. The published site lives under `/lituus/`, which is what makes
 *   `networkUrl()` worth having, but a throwaway harness has no such prefix and
 *   hardcoding one only adds a way for the driver's URLs to be wrong.
 * - `publicDir` is the local network directory, so the 37MB `.bin.gz` is served
 *   **same origin** at `/<filename>` without being copied anywhere. Same origin
 *   is not a nicety: neither host that publishes KataGo networks sends
 *   `Access-Control-Allow-Origin` (`src/engine/network.ts`).
 * - The conformance page is its own entry point, so the app's `index.html` is
 *   untouched and nothing in this file can reach production.
 */
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here: string = dirname(fileURLToPath(import.meta.url));
const repo: string = resolve(here, '../..');

export default defineConfig({
  root: resolve(here, 'conformance'),
  base: '/',
  publicDir: resolve(repo, 'experiments/nets'),
  server: { fs: { allow: [repo] } },
});
