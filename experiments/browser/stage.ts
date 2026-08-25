/**
 * Copy the benchmark pages into the vendored web-katrain checkout and expose
 * the networks to its dev server. Shared by the desktop driver (`run.ts`)
 * and the LAN server used for phone testing (`serve.ts`).
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ROOT: string = resolve(import.meta.dirname, '../..');
export const VENDOR: string = `${ROOT}/experiments/vendor/web-katrain`;
export const NETS: string = `${ROOT}/experiments/nets`;

/** Staged into the checkout; `src/` files are importable by the pages there. */
const PAGES: ReadonlyArray<readonly [string, string]> = [
  ['bench.ts', 'src/lituus-bench.ts'],
  ['mobile.ts', 'src/lituus-mobile.ts'],
  ['bench.html', 'bench.html'],
  ['mobile.html', 'mobile.html'],
  ['vite.mobile.config.ts', 'vite.mobile.config.ts'],
];

/** Returns the available network filenames, newest-format first by name. */
export function stage(): string[] {
  if (!existsSync(VENDOR)) {
    throw new Error(`vendored checkout missing: ${VENDOR} (see experiments/browser/README.md)`);
  }
  for (const [from, to] of PAGES) copyFileSync(`${ROOT}/experiments/browser/${from}`, `${VENDOR}/${to}`);

  const target = `${VENDOR}/public/nets`;
  rmSync(target, { recursive: true, force: true });
  mkdirSync(`${VENDOR}/public`, { recursive: true });
  symlinkSync(NETS, target);

  const nets: string[] = readdirSync(NETS).filter((f) => f.endsWith('.bin.gz')).sort();
  if (nets.length === 0) throw new Error(`no networks in ${NETS}`);
  // The hand-driven page has no other way to know what is on offer.
  writeFileSync(`${VENDOR}/public/lituus-nets.json`, JSON.stringify(nets));
  return nets;
}

export function shortName(net: string): string {
  return net.replace(/^g170e?-/, '').replace(/-s\d+-d\d+\.bin\.gz$/, '');
}
