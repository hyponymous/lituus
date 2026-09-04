/**
 * A dev server for the readback benchmark.
 *
 * The same three departures `vite.conformance.config.ts` explains, for the same
 * three reasons: `base: '/'` because a throwaway harness has no published
 * prefix, `publicDir` pointed at the local networks so the 37MB `.bin.gz` is
 * served same origin without being copied, and its own entry point so nothing
 * here can reach production.
 */
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here: string = dirname(fileURLToPath(import.meta.url));
const repo: string = resolve(here, '../..');

export default defineConfig({
  root: resolve(here, 'readback'),
  base: '/',
  publicDir: resolve(repo, 'experiments/nets'),
  server: { fs: { allow: [repo] } },
});
