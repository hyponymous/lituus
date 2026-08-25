/**
 * Replace game identifiers in analysis output with opaque ones.
 *
 * `analyze.ts` names each game after its SGF file, which is what you want
 * while working. But those filenames carry the handles of real players whose
 * games are being dissected move by move, and this repository is intended to
 * become public. The identifier is only ever used to group records, so
 * nothing analytical is lost by making it opaque.
 *
 *   node experiments/katago/anonymize.ts --map <map.json> <results.jsonl>...
 *
 * The mapping is written alongside and reused on later runs, so identifiers
 * stay stable as more configurations are added. Keep it out of version
 * control — it is the thing that undoes the anonymization.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

interface Record_ { game: string }

function parseArgs(argv: readonly string[]): { map: string; files: string[] } {
  const mapIndex: number = argv.indexOf('--map');
  if (mapIndex < 0) throw new Error('usage: anonymize.ts --map <map.json> <results.jsonl>...');
  const files: string[] = argv.filter((_, i) => i !== mapIndex && i !== mapIndex + 1);
  if (files.length === 0) throw new Error('no result files given');
  return { map: argv[mapIndex + 1], files };
}

const { map: mapPath, files } = parseArgs(process.argv.slice(2));

// name → opaque id. Loaded first so that ids already handed out are kept.
const mapping: Map<string, string> = new Map(
  existsSync(mapPath) ? Object.entries(JSON.parse(readFileSync(mapPath, 'utf8')) as Record<string, string>) : [],
);

const parsed = new Map<string, Record_[]>();
const names = new Set<string>();
for (const file of files) {
  const rows: Record_[] = readFileSync(file, 'utf8')
    .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record_);
  parsed.set(file, rows);
  for (const row of rows) names.add(row.game);
}

// Sorted, so the assignment does not depend on which files were passed.
for (const name of [...names].sort()) {
  if (mapping.has(name)) continue;
  mapping.set(name, `game-${String(mapping.size + 1).padStart(2, '0')}`);
}

let rewritten = 0;
for (const [file, rows] of parsed) {
  let touched = false;
  for (const row of rows) {
    const id: string | undefined = mapping.get(row.game);
    if (id && id !== row.game) { row.game = id; touched = true; }
  }
  if (!touched) continue;
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  rewritten++;
}

writeFileSync(mapPath, JSON.stringify(Object.fromEntries(mapping), null, 2) + '\n');
console.error(`${rewritten} of ${files.length} files rewritten, ${mapping.size} games, map at ${mapPath}`);
