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

/**
 * A fingerprint of the weights as they end up in memory, not as they sit on
 * disk.
 *
 * The file hashes correctly on a device whose forward pass is wrong, which
 * leaves one step between the bytes and the arithmetic that has never been
 * checked: the parse. It reads binary floats out of the file, merges each batch
 * norm's mean, variance, scale and bias into a scale and a bias, and hands the
 * result to the GPU. All of that is ordinary JavaScript, and it runs on the
 * device — a different engine, a different `Math.sqrt` result, an alignment
 * assumption that holds on one platform and not another, and the weights differ
 * while the file does not.
 *
 * Not a cryptographic hash. `crypto.subtle` cannot be fed incrementally and the
 * weights are ten million floats; this only has to distinguish two machines,
 * and FNV-1a over the float bits does that. The order of the walk is fixed by
 * sorting keys, so two devices visit the same numbers in the same sequence.
 */
export function weightsFingerprint(parsed: unknown): { hex: string; floats: number } {
  // 64 bits as two 32-bit halves, since a 32-bit fingerprint over ten million
  // floats collides more often than a reader would credit.
  let a = 0x811c9dc5;
  let b = 0x01000193;
  let floats = 0;
  const bits = new DataView(new ArrayBuffer(4));

  const mix = (values: Float32Array): void => {
    floats += values.length;
    for (let i = 0; i < values.length; i++) {
      bits.setFloat32(0, values[i]);
      const word: number = bits.getUint32(0);
      a = Math.imul(a ^ word, 0x01000193) >>> 0;
      b = Math.imul(b ^ (word + i), 0x85ebca6b) >>> 0;
    }
  };

  const walk = (node: unknown): void => {
    if (node instanceof Float32Array) {
      mix(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node !== null && typeof node === 'object') {
      const keys: string[] = Object.keys(node as Record<string, unknown>).sort();
      for (const key of keys) walk((node as Record<string, unknown>)[key]);
    }
  };

  walk(parsed);
  return { hex: `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`, floats };
}
