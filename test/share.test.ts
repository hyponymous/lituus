/**
 * The URL fragment has to survive the trip to someone else's browser, so what
 * matters here is the round trip and the ways a link arrives damaged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode, decode } from '../src/share.ts';

const GAME = readFileSync(new URL('./fixtures/2024-07-09d.sgf', import.meta.url), 'utf8');

test('a record survives the round trip unchanged', async () => {
  assert.equal(await decode(await encode(GAME)), GAME);
});

test('the fragment is URL-safe', async () => {
  const fragment: string = await encode(GAME);
  assert.match(fragment, /^[A-Za-z0-9_-]+$/, 'fragment needs no escaping in a URL');
});

test('compression earns its keep', async () => {
  const fragment: string = await encode(GAME);
  assert.ok(fragment.length < GAME.length, `${fragment.length} vs ${GAME.length} bytes of SGF`);
});

test('an unparseable record is refused before it becomes a link', async () => {
  // Finding out on the recipient's machine is the worst place to find out.
  await assert.rejects(() => encode('not an sgf at all'));
});

test('a truncated fragment is reported as damaged, not thrown raw', async () => {
  const fragment: string = await encode(GAME);
  await assert.rejects(
    () => decode(fragment.slice(0, fragment.length - 20)),
    /damaged/,
  );
});

test('a fragment that is not base64url is reported as damaged', async () => {
  await assert.rejects(() => decode('not base64url!!'), /damaged/);
});

test('decompression stops at the size limit rather than filling memory', async () => {
  // A few hundred bytes of gzip can expand to gigabytes; the guard has to hold
  // while reading, not after.
  const big: string = `(;GB[1]C[${'x'.repeat(200_000)}])`;
  const fragment: string = await encode(big);
  assert.ok(fragment.length < 2000, 'a repetitive record compresses very small');
  await assert.rejects(() => decode(fragment, 1000), /more than 1000 bytes/);
});

test('the limit does not reject a record that fits', async () => {
  assert.equal(await decode(await encode(GAME), 1_000_000), GAME);
});
