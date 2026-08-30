/**
 * The anonymizer is the only thing standing between a corpus of real people's
 * games and a public repository, and its failure mode is silence: a record
 * that still carries a handle looks exactly like one that never had one.
 *
 * These run the script as a script rather than importing pieces of it, so
 * that what is tested is the thing the corpus is actually put through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT: string = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT: string = join(ROOT, 'experiments/katago/anonymize.ts');

/** A record shaped like the ones OGS hands back, chat and all. */
const RECORD = `(;FF[4]CA[UTF-8]GM[1]SZ[19]KM[6.5]RU[Japanese]
DT[2025-08-05]PC[OGS: https://online-go.com/game/78005648]
GN[Yoshi1080 vs. 0x10F2C]PB[Yoshi1080]PW[0x10F2C]BR[22k]WR[22k]RE[B+R]
;B[qq]C[Real Name: hi]
;W[pd]C[Other Person: hello]
;B[cp])
`;

function run(dir: string, files: readonly string[]): string {
  return execFileSync(
    process.execPath,
    [SCRIPT, '--players', join(dir, 'players.json'), ...files.map((f) => join(dir, f))],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function fixture(): { dir: string; sgf: () => string } {
  const dir: string = mkdtempSync(join(tmpdir(), 'anon-'));
  writeFileSync(join(dir, 'game.sgf'), RECORD);
  return { dir, sgf: () => readFileSync(join(dir, 'game.sgf'), 'utf8') };
}

test('anonymize: handles, chat and back-link do not survive', () => {
  const { dir, sgf } = fixture();
  run(dir, ['game.sgf']);
  const out: string = sgf();

  for (const secret of ['Yoshi1080', '0x10F2C', 'Real Name', 'Other Person', 'online-go.com']) {
    assert.ok(!out.includes(secret), `${secret} survived anonymization`);
  }
  assert.match(out, /PB\[player-\d\d\]/);
  assert.match(out, /PW\[player-\d\d\]/);
  assert.match(out, /GN\[player-\d\d vs\. player-\d\d\]/);
});

test('anonymize: the moves and the rules are untouched', () => {
  const { dir, sgf } = fixture();
  run(dir, ['game.sgf']);
  const out: string = sgf();

  assert.equal((out.match(/;[BW]\[/g) ?? []).length, 3);
  assert.ok(out.includes('KM[6.5]'));
  assert.ok(out.includes('RU[Japanese]'));
  assert.ok(out.includes('BR[22k]'));
});

test('anonymize: running twice does not rename a second time', () => {
  const { dir, sgf } = fixture();
  run(dir, ['game.sgf']);
  const once: string = sgf();
  run(dir, ['game.sgf']);
  assert.equal(sgf(), once);

  // A second pass must not grow the mapping either, or the ids handed out
  // would drift away from the records that already carry them.
  const map = JSON.parse(readFileSync(join(dir, 'players.json'), 'utf8')) as Record<string, string>;
  assert.equal(Object.keys(map).length, 2);
});

test('anonymize: the same handle gets the same id across files', () => {
  const { dir } = fixture();
  // Same black player, a different opponent: the shared handle must land
  // on the same id in both files.
  writeFileSync(join(dir, 'other.sgf'), RECORD.replace('PW[0x10F2C]', 'PW[Someone]'));
  run(dir, ['game.sgf', 'other.sgf']);

  const map = JSON.parse(readFileSync(join(dir, 'players.json'), 'utf8')) as Record<string, string>;
  const first: string = readFileSync(join(dir, 'game.sgf'), 'utf8');
  const second: string = readFileSync(join(dir, 'other.sgf'), 'utf8');
  const id = (s: string): string => s.match(/PB\[(player-\d\d)\]/)?.[1] ?? '';
  assert.equal(id(first), map['Yoshi1080']);
  assert.equal(id(first), id(second));
});
