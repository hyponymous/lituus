/**
 * Which machine this is, and what the answer is used for.
 *
 * Both consumers are load-bearing in a way that is invisible on screen: the
 * setup view's warning about scoring on a phone, and the `device` an exported
 * result carries. A session that scored seventy-eight positions wrongly could
 * not say what it had run on, and establishing it was a phone meant asking the
 * person who played it.
 *
 * `navigator` is stubbed rather than mocked around: it is one global with two
 * fields read, and swapping it is closer to the thing being tested than an
 * injected seam would be.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMobile } from '../src/device.ts';

const real = globalThis.navigator;

function withNavigator(stub: unknown, body: () => void): void {
  Object.defineProperty(globalThis, 'navigator', { value: stub, configurable: true });
  try {
    body();
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: real, configurable: true });
  }
}

test('a phone is recognized from its user agent', () => {
  const agents: string[] = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36',
  ];
  for (const userAgent of agents) {
    withNavigator({ userAgent }, () => assert.equal(isMobile(), true, userAgent));
  }
});

test('a laptop is not', () => {
  withNavigator(
    { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15' },
    () => assert.equal(isMobile(), false),
  );
});

test('the client hint wins over the user agent where a browser offers it', () => {
  // It is the browser's own answer rather than a guess from a string, and the
  // string it would be guessing from is the one browsers lie in.
  withNavigator({ userAgent: 'Macintosh', userAgentData: { mobile: true } }, () =>
    assert.equal(isMobile(), true),
  );
  withNavigator({ userAgent: 'iPhone', userAgentData: { mobile: false } }, () =>
    assert.equal(isMobile(), false),
  );
});

test('an iPad reads as a desktop, and that is the safe direction', () => {
  // iPadOS has claimed to be a Macintosh since version 13. Recorded as a test
  // rather than a comment because it is a known wrong answer, and the reason it
  // is tolerated is that it under-warns instead of nagging every laptop.
  withNavigator(
    { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.0 Safari/605.1.15' },
    () => assert.equal(isMobile(), false),
  );
});
