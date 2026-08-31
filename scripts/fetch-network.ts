/**
 * Download the KataGo network into a built site, so it is served same-origin.
 *
 *   node scripts/fetch-network.ts dist
 *
 * Run after `vite build`, which empties `dist/`. The network is deliberately
 * *not* committed: 37 MB in git history is permanent and is paid by everyone
 * who ever clones the repository, whereas a build-time fetch is paid once per
 * deploy and is cacheable.
 *
 * Same-origin is not a preference either. See `network.ts` for the measurement
 * that forces it.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NETWORK, NETWORK_DIR } from '../src/engine/network.ts';

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const outDir: string = process.argv[2] ?? 'dist';
  const dir: string = join(outDir, NETWORK_DIR);
  const target: string = join(dir, NETWORK.file);

  const existing: number | null = await sizeOf(target);
  if (existing === NETWORK.bytes) {
    console.log(`${NETWORK.file} already present (${existing} bytes), skipping.`);
    return;
  }

  await mkdir(dir, { recursive: true });
  console.log(`Fetching ${NETWORK.label} from ${NETWORK.url}`);

  const response: Response = await fetch(NETWORK.url);
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }
  // Buffered rather than streamed. It is 37 MB on a build machine, and piping a
  // web stream into a Node one needs a cast that earns nothing here.
  await writeFile(target, new Uint8Array(await response.arrayBuffer()));

  const got: number | null = await sizeOf(target);
  // A truncated network parses as far as the truncation and then fails
  // somewhere unrelated-looking, so the size is checked here rather than
  // being discovered in the browser.
  if (got !== NETWORK.bytes) {
    throw new Error(`Expected ${NETWORK.bytes} bytes, got ${got}. Refusing a partial network.`);
  }
  console.log(`Wrote ${target} (${got} bytes).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
