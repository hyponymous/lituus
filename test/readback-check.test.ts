/**
 * Reading a table of lengths as a verdict about a device.
 *
 * The table below is not invented: it is what an iPhone printed on 2026-09-06,
 * transcribed from the probe. Every read that filled whole rows of the readback
 * canvas came back exactly; every read that did not came back with its tail
 * repeating its head; and the asynchronous read was right throughout. That
 * device is not broken for this build's purposes — every read it makes is
 * padded to whole rows — and a probe that calls it broken teaches the reader to
 * ignore the probe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readbackVerdict, type LengthCheck } from '../src/engine/readback-check.ts';

const clean = (count: number, passes: number): LengthCheck => ({
  count,
  passes,
  syncWorst: 0,
  asyncWorst: 0,
  syncWorstAt: -1,
  expected: 0,
  gotSync: 0,
  gotAsync: 0,
  tailRepeatsHead: false,
});

const lostCycle = (count: number, worst: number, at: number): LengthCheck => ({
  ...clean(count, 2),
  syncWorst: worst,
  syncWorstAt: at,
  tailRepeatsHead: true,
});

/** The phone, 2026-09-06, after the reads were padded. */
const PHONE: readonly LengthCheck[] = [
  clean(4, 1),
  clean(256, 1),
  lostCycle(257, 5.9e-2, 256),
  lostCycle(361, 3.2e38, 265),
  lostCycle(369, 3.2e38, 265),
  clean(512, 1),
  lostCycle(513, 1.11e-1, 512),
  lostCycle(1000, 2.86e38, 777),
  clean(4096, 1),
  lostCycle(4097, 5.0e-1, 4096),
];

test('a device that only fails the two-cycle lengths is sound for what we read', () => {
  const verdict = readbackVerdict(PHONE);

  assert.equal(verdict.ok, true);
  assert.equal(verdict.losesSecondCycle, true);
});

test('a device that gets every length right says so plainly', () => {
  const laptop: readonly LengthCheck[] = PHONE.map((one: LengthCheck) => clean(one.count, one.passes));
  const verdict = readbackVerdict(laptop);

  assert.equal(verdict.ok, true);
  assert.equal(verdict.losesSecondCycle, false);
});

test('a whole-row read that comes back wrong is not something padding fixes', () => {
  const broken: LengthCheck[] = [...PHONE];
  broken[9] = { ...clean(4096, 1), syncWorst: 1e-3, syncWorstAt: 12 };

  assert.equal(readbackVerdict(broken).ok, false);
});

test('an asynchronous read that comes back wrong is refused at any length', () => {
  // The padded read is still a `dataSync`, and `data()` being wrong would mean
  // the fault is not the canvas at all — nothing here would be trustworthy.
  const broken: LengthCheck[] = [...PHONE];
  broken[3] = { ...broken[3], asyncWorst: 1e-3 };

  assert.equal(readbackVerdict(broken).ok, false);
});
