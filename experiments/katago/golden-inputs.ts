/**
 * Extract KataGo's own golden `fillRowV7` dumps into a fixture we can test against.
 *
 *   node experiments/katago/golden-inputs.ts > test/fixtures/golden-v7.json
 *
 * KataGo's test suite checks its input encoder against committed expected
 * output: `cpp/tests/results/runOutputTests.txt` holds, for a battery of
 * positions, every input plane printed as a grid with the board drawn beside
 * it, plus every global feature. That file is a specification of `fillRowV7`
 * in a form a machine can read, which is exactly what our port needs and what
 * we were otherwise going to synthesize by hand.
 *
 * This reads it rather than KataGo's source, so it needs no compiler, no GPU,
 * and no network — and it is version-pinned to the checkout, so a KataGo
 * upgrade that changes the encoding shows up as a fixture diff.
 *
 * Only VERSION 7 records are kept; the file also covers input versions 3-6,
 * which lituus does not implement.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const SOURCE: string =
  process.env.KATAGO_SRC ?? `${homedir()}/src/katago`;
const RESULTS = `${SOURCE}/cpp/tests/results/runOutputTests.txt`;

/** One position's expected planes and globals, as KataGo printed them. */
export interface GoldenRecord {
  /** The test case that produced it, e.g. "NN Inputs V3V4V5V6 Basic". */
  readonly section: string;
  /** Index of this record within its section, since a case may print many. */
  readonly index: number;
  /** `NNInputs::getHash`, where the case printed one. */
  readonly hash?: string;
  /** Spatial planes by channel, each row-major and `width` wide. */
  readonly planes: Record<number, readonly (readonly number[])[]>;
  /** Global features by channel, where the case printed them singly. */
  readonly globals: Record<number, number>;
  /**
   * The board as printed beside channel 0 — stones, and the last five moves
   * marked with their age. Present only where a case printed a plane.
   */
  readonly board?: readonly string[];
  /**
   * Cases that sweep many rulesets print globals as unlabelled blocks: one
   * row per global channel, one column per variant within that block.
   */
  readonly blocks?: readonly (readonly (readonly number[])[])[];
}

const DASHES = /^-{10,}$/;
const HASH = /^[0-9A-F]{32}$/;
const CHANNEL = /^Channel: (\d+)$/;
const GLOBAL = /^Channel: (\d+): (\S+)$/;
const NUMERIC = /^-?[\d.]+( -?[\d.]+)*\s*$/;

/**
 * Split a printed plane row into its numbers and the board drawn beside it.
 *
 * The two are separated by a double space, which is unambiguous: within each
 * half the separator is a single space.
 */
function splitRow(line: string): { values: number[]; board: string } {
  const at: number = line.indexOf('  ');
  const numbers: string = at === -1 ? line : line.slice(0, at);
  const board: string = at === -1 ? '' : line.slice(at + 2);
  return { values: numbers.trim().split(/\s+/).map(Number), board: board.trimEnd() };
}

/** A mutable record under construction, before it is frozen into a GoldenRecord. */
interface Building {
  section: string;
  index: number;
  hash?: string;
  planes: Record<number, number[][]>;
  globals: Record<number, number>;
  board?: string[];
  blocks?: number[][][];
  /** Which plane's rows the board was taken from; it is the same beside each. */
  boardFrom?: number;
}

function finish(building: Building | null, into: GoldenRecord[]): void {
  if (!building) return;
  const { section, index, hash, planes, globals, board, blocks } = building;
  into.push({ section, index, hash, planes, globals, board, blocks });
}

export function parseGolden(text: string): GoldenRecord[] {
  const lines: string[] = text.split('\n');
  const records: GoldenRecord[] = [];

  let section = '';
  let building: Building | null = null;
  let counter = 0;
  let channel = -1;
  let open = false;

  for (let i = 0; i < lines.length; i++) {
    const line: string = lines[i].trimEnd();

    // A section header is a name fenced by rules above and below.
    if (DASHES.test(line) && DASHES.test(lines[i + 2]?.trimEnd() ?? '')) {
      finish(building, records);
      building = null;
      section = lines[i + 1].trim();
      counter = 0;
      i += 2;
      continue;
    }

    if (line.startsWith('VERSION ')) {
      finish(building, records);
      building =
        line === 'VERSION 7'
          ? { section, index: counter++, planes: {}, globals: {} }
          : null;
      channel = -1;
      open = false;
      continue;
    }
    if (!building) continue;

    if (HASH.test(line)) {
      building.hash = line;
      continue;
    }

    const global = GLOBAL.exec(line);
    if (global) {
      building.globals[Number(global[1])] = Number(global[2]);
      channel = -1;
      continue;
    }

    const spatial = CHANNEL.exec(line);
    if (spatial) {
      channel = Number(spatial[1]);
      building.planes[channel] = [];
      continue;
    }

    if (line === '') {
      channel = -1;
      open = false;
      continue;
    }

    // A plane row carries its numbers and the board drawn beside it, so it is
    // only numeric up to the double space. Test the whole line for the matrix
    // case alone, where there is nothing but numbers.
    if (channel >= 0) {
      const { values, board } = splitRow(line);
      building.planes[channel].push(values);
      // The board is identical beside every channel, so keep only the copy
      // printed beside the first one and let a record carry its position once.
      if (board) {
        building.boardFrom ??= channel;
        if (building.boardFrom === channel) (building.board ??= []).push(board);
      }
      continue;
    }

    if (!NUMERIC.test(line)) continue;

    // Unlabelled rows belong to a ruleset sweep: one row per global feature,
    // one column per variant. A blank line ends one sweep and starts the next,
    // so they are kept apart rather than run together.
    if (!open) {
      (building.blocks ??= []).push([]);
      open = true;
    }
    building.blocks?.[building.blocks.length - 1].push(line.trim().split(/\s+/).map(Number));
  }

  finish(building, records);
  return records;
}

/**
 * The cases worth keeping, and why the others are not.
 *
 * These two print every plane and every global for a single position on a
 * square board, with the board drawn beside them — enough to rebuild the
 * position and check what we derive from it. The rest of the file is left
 * behind deliberately: several cases dump dozens of positions in one block
 * with no marker between them, "7x7 embedded in 9x9" exercises the padding
 * lituus does not do, and the encore and area cases cover planes that
 * territory scoring never reaches. Adding one back means teaching the parser
 * that case's own layout, not relaxing a filter.
 */
const KEEP: readonly string[] = ['NN Inputs V3V4V5V6 Basic', 'NN Inputs V3V4V5V6 7x7'];

function main(): void {
  const text: string = readFileSync(RESULTS, 'utf8');
  const records: GoldenRecord[] = parseGolden(text).filter(
    (record) => KEEP.includes(record.section) && record.board !== undefined,
  );
  if (records.length !== KEEP.length) {
    throw new Error(`Expected ${KEEP.length} golden records, parsed ${records.length}.`);
  }
  process.stdout.write(`${JSON.stringify({ records }, null, 1)}\n`);
}

if (process.argv[1]?.endsWith('golden-inputs.ts')) main();
