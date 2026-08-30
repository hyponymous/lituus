/**
 * Replace identifiers in analysis output and game records with opaque ones.
 *
 *   node experiments/katago/anonymize.ts --map <map.json> <results.jsonl>...
 *   node experiments/katago/anonymize.ts --players <players.json> <game.sgf>...
 *
 * `analyze.ts` names each game after its SGF file, which is what you want
 * while working. But those filenames carry the handles of real players whose
 * games are being dissected move by move, and this repository is intended to
 * become public. The identifier is only ever used to group records, so
 * nothing analytical is lost by making it opaque.
 *
 * The records themselves carry more than the handles. A game fetched from a
 * server arrives with `PB`/`PW`, a `PC` link straight back to the original,
 * and — in over half of them — `C` properties holding the players' in-game
 * chat, which is where actual personal names turn up rather than handles.
 * None of that survives here: chat and the back-link are dropped outright,
 * and the handles are replaced.
 *
 * This matters beyond the repository, because a game record is not only an
 * input. `lituus` embeds the whole record in the result it exports at the end
 * of a playthrough, so anything left in the record travels with every export.
 *
 * Both mappings are written alongside and reused on later runs, so
 * identifiers stay stable as more configurations are added. Keep them out of
 * version control — they are the thing that undoes the anonymization. Note
 * that a corpus filename may still carry the server's game id; the mapping
 * from an anonymized record back to its origin is the manifest, which is
 * local for the same reason.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parse, type GameTree, type Props } from '../../src/sgf-parser.ts';
import { serialize } from '../../src/sgf-writer.ts';

/** Properties dropped rather than replaced: they identify, and none is used. */
const DROPPED = ['C', 'PC'];

interface Record_ { game: string }

function parseArgs(argv: readonly string[]): {
  map: string | undefined; players: string | undefined; files: string[];
} {
  const flags = new Map<string, string>();
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags.set(argv[i].slice(2), argv[++i]);
    else files.push(argv[i]);
  }
  if (files.length === 0) {
    throw new Error(
      'usage: anonymize.ts --map <map.json> <results.jsonl>...\n' +
      '       anonymize.ts --players <players.json> <game.sgf>...',
    );
  }
  return { map: flags.get('map'), players: flags.get('players'), files };
}

function loadMapping(path: string): Map<string, string> {
  return new Map(existsSync(path)
    ? Object.entries(JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>)
    : []);
}

function saveMapping(path: string, mapping: ReadonlyMap<string, string>): void {
  writeFileSync(path, JSON.stringify(Object.fromEntries(mapping), null, 2) + '\n');
}

/**
 * Hands out `<prefix>-NN` on first sight, and the same one every time after.
 *
 * An id already handed out maps to itself, so that running twice over the
 * same files is a no-op rather than a second round of renaming — which would
 * quietly break the mapping back to the original.
 */
function idFor(mapping: Map<string, string>, name: string, prefix: string): string {
  const existing: string | undefined = mapping.get(name);
  if (existing !== undefined) return existing;
  if (assigned(mapping).has(name)) return name;
  const id = `${prefix}-${String(mapping.size + 1).padStart(2, '0')}`;
  mapping.set(name, id);
  return id;
}

function assigned(mapping: ReadonlyMap<string, string>): Set<string> {
  return new Set(mapping.values());
}

function anonymizeResults(mapPath: string, files: readonly string[]): void {
  const mapping: Map<string, string> = loadMapping(mapPath);

  const parsed = new Map<string, Record_[]>();
  const names = new Set<string>();
  for (const file of files) {
    const rows: Record_[] = readFileSync(file, 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record_);
    parsed.set(file, rows);
    for (const row of rows) names.add(row.game);
  }

  // Sorted, so the assignment does not depend on which files were passed.
  for (const name of [...names].sort()) idFor(mapping, name, 'game');

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

  saveMapping(mapPath, mapping);
  console.error(`${rewritten} of ${files.length} files rewritten, ${mapping.size} games, map at ${mapPath}`);
}

function anonymizeRecords(mapPath: string, files: readonly string[]): void {
  const mapping: Map<string, string> = loadMapping(mapPath);

  // Every handle in the batch, assigned in sorted order so that the ids do
  // not depend on which files were passed or in what order.
  const parsed = new Map<string, GameTree[]>();
  const handles = new Set<string>();
  for (const file of files) {
    const trees: GameTree[] = parse(readFileSync(file, 'utf8'));
    parsed.set(file, trees);
    const root: Props | undefined = trees[0]?.nodes[0]?.props;
    for (const key of ['PB', 'PW']) {
      const value: string | undefined = root?.[key]?.[0];
      if (value) handles.add(value);
    }
  }
  for (const handle of [...handles].sort()) idFor(mapping, handle, 'player');

  let chat = 0;
  function scrub(tree: GameTree): void {
    for (const node of tree.nodes) {
      for (const key of DROPPED) {
        if (node.props[key] !== undefined) { if (key === 'C') chat++; delete node.props[key]; }
      }
    }
    for (const variation of tree.variations) scrub(variation);
  }

  for (const [file, trees] of parsed) {
    for (const tree of trees) scrub(tree);
    const root: Props | undefined = trees[0]?.nodes[0]?.props;
    if (root) {
      for (const key of ['PB', 'PW']) {
        const value: string | undefined = root[key]?.[0];
        // A record with no handle to begin with is left alone rather than
        // given one, so that "anonymous" and "player-07" stay distinguishable.
        if (value) root[key] = [idFor(mapping, value, 'player')];
      }
      if (root.GN !== undefined) root.GN = [`${root.PB?.[0] ?? '?'} vs. ${root.PW?.[0] ?? '?'}`];
    }
    writeFileSync(file, serialize(trees));
  }

  saveMapping(mapPath, mapping);
  console.error(
    `${files.length} records rewritten, ${handles.size} handles seen ` +
    `(${mapping.size} known), ${chat} chat properties dropped, map at ${mapPath}`,
  );
}

const { map, players, files } = parseArgs(process.argv.slice(2));
const sgf: string[] = files.filter((f) => f.toLowerCase().endsWith('.sgf'));
const results: string[] = files.filter((f) => !f.toLowerCase().endsWith('.sgf'));

if (sgf.length > 0) {
  if (!players) throw new Error('--players <players.json> is required to anonymize .sgf records');
  anonymizeRecords(players, sgf);
}
if (results.length > 0) {
  if (!map) throw new Error('--map <map.json> is required to anonymize result files');
  anonymizeResults(map, results);
}
