/**
 * Are these the weights we think they are?
 *
 * The last input to the engine that nothing vouched for. A phone computes this
 * network deterministically and differently from a laptop; its readback is
 * exact, and every operation the model uses agrees with its own CPU to 1e-7.
 * Same code, same input, correct arithmetic, different answer — which leaves
 * the numbers being multiplied.
 *
 * `net-cache.ts` checked a completed download by its compressed length and by
 * the first sixty-four bytes looking like a KataGo header. A body damaged after
 * byte sixty-four passes both, parses, and evaluates; and because the result is
 * kept in the Cache API, a damaged copy is re-read on every later visit, which
 * would explain two sessions three days apart agreeing bit for bit.
 */

import { NETWORK } from './network.ts';

export interface WeightsCheck {
  readonly bytes: number;
  readonly sha256: string;
  readonly matches: boolean;
}

/** Hex, because that is how the constant is written and how a reader compares. */
function hex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte: number) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/**
 * Hash the inflated weights and say whether they are the expected ones.
 *
 * `crypto.subtle` needs a secure context, which the engine needs anyway —
 * WebGPU is not exposed without one — so there is no case where this is the
 * thing that cannot run.
 */
export async function checkWeights(data: Uint8Array): Promise<WeightsCheck> {
  // A fresh copy: `subtle.digest` will not take a view whose buffer may be
  // detached or shared, and a 40MB copy once at load is not worth avoiding.
  const digest: ArrayBuffer = await crypto.subtle.digest('SHA-256', data.slice().buffer);
  const sha256: string = hex(digest);
  return {
    bytes: data.length,
    sha256,
    matches: sha256 === NETWORK.sha256 && data.length === NETWORK.inflatedBytes,
  };
}
