/**
 * What this device actually computes — asked in a worker, because that is where
 * the app asks it.
 *
 * Two phone sessions scored a game with numbers that were finite, stable, and
 * wrong: root leads tens of points from what the same build produces on a
 * laptop, and a taste for first-line moves that a reader can spot without any
 * of this machinery. The canary in `canary.ts` did not fire, and could not:
 * it asks whether a device still agrees with itself, and this one agreed with
 * itself bit for bit across two sessions three days apart.
 *
 * So the question here is not consistency but correctness, and it is asked in
 * three narrowing steps: can the GPU hand a known number back (`readback-check`
 * — the leading suspect, since `dataSync` recovers floats through a canvas);
 * does the network's forward pass land where a known-good device lands
 * (`canary-expected`); and if it does not, by how much and in which head.
 *
 * A worker rather than the page on purpose. The app scores in a worker, a
 * worker's canvas is an `OffscreenCanvas`, and if the difference lives in the
 * image pipeline then the page is the one place the bug might not appear.
 */

import type * as TF from '@tensorflow/tfjs-core';
import { Canary, canaryInputs, canaryHeads } from './canary.ts';
import {
  EXPECTED_HEADS,
  EXPECTED_ON,
  EXPECTED_SIZE,
  EXPECTED_TOLERANCE,
} from './canary-expected.ts';
import { loadNetworkBytes } from './net-cache.ts';
import { parseKataGoModelV8 } from './load-model-v8.ts';
import type { ParsedKataGoModelV8 } from './model-types.ts';
import { ModelV8, type Evaluation } from './model-v8.ts';
import { checkReadback, type ReadbackCheck } from './readback-check.ts';

export interface ProbeRequest {
  readonly networkUrl: string;
}

/** One finding at a time, so a hang is attributable to a step. */
export interface ProbeReport {
  readonly stage: 'backend' | 'readback' | 'network' | 'forward' | 'compare' | 'failed';
  readonly ok: boolean;
  readonly detail: string;
}

const scope = self as unknown as {
  postMessage(message: ProbeReport): void;
  onmessage: ((event: MessageEvent<ProbeRequest>) => void) | null;
};

const post = (report: ProbeReport): void => scope.postMessage(report);

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Full precision, because the whole point is to compare two machines' digits. */
const digits = (values: ArrayLike<number>): string =>
  Array.from(values, (value: number) => value.toPrecision(9)).join(', ');

async function probe(request: ProbeRequest): Promise<void> {
  // The baked answer was measured at one board size and is that size's answer.
  const size: number = EXPECTED_SIZE;

  const tf: typeof TF = await import('@tensorflow/tfjs-core');
  await import('@tensorflow/tfjs-backend-webgpu');
  if (!(await tf.setBackend('webgpu'))) throw new Error('no WebGPU in this worker');
  await tf.ready();
  post({ stage: 'backend', ok: true, detail: `backend: ${tf.getBackend()}` });

  /*
   * Before the network, deliberately. It needs no download and no model, so a
   * phone that cannot get past this line has already answered the question —
   * and 37MB later would be a slow way to learn it.
   */
  const readback: ReadbackCheck = await checkReadback(tf);
  const readbackOk: boolean = readback.syncWorst < 1e-6 && readback.betweenWorst < 1e-6;
  post({
    stage: 'readback',
    ok: readbackOk,
    detail:
      `${readback.count} known floats through the GPU\n` +
      `dataSync worst |d| ${readback.syncWorst.toExponential(3)}\n` +
      `await data() worst |d| ${readback.asyncWorst.toExponential(3)}\n` +
      `the two against each other ${readback.betweenWorst.toExponential(3)}\n` +
      (readbackOk
        ? 'both ways agree with what was uploaded'
        : `worst at index ${readback.syncWorstAt}: expected ${readback.expected.toPrecision(9)}, ` +
          `dataSync ${readback.gotSync.toPrecision(9)}, data() ${readback.gotAsync.toPrecision(9)}`),
  });

  const bytes: Uint8Array = await loadNetworkBytes(request.networkUrl);
  const parsed: ParsedKataGoModelV8 = parseKataGoModelV8(bytes);
  const model = new ModelV8(tf, parsed);
  post({ stage: 'network', ok: true, detail: `${parsed.modelName}, v${parsed.modelVersion}` });

  const canary = new Canary(model, size);
  const inputs = canaryInputs(size * size);
  const evaluation: Evaluation = model.evaluate(inputs.spatial, inputs.global, size);
  post({
    stage: 'forward',
    ok: true,
    detail:
      `heads at ${size}x${size} [win, loss, noResult, scoreMean, ` +
      `scoreStdev, lead, varTimeLeft, pass, policy sum]\n` +
      `${digits(canaryHeads(evaluation))}\n` +
      `drift against itself: ${canary.drift().toExponential(3)}`,
  });

  const off: number = canary.against(EXPECTED_HEADS);
  post({
    stage: 'compare',
    ok: off <= EXPECTED_TOLERANCE,
    detail:
      `against ${EXPECTED_ON}\n` +
      `worst relative difference ${off.toExponential(3)}, tolerance ` +
      `${EXPECTED_TOLERANCE.toExponential(0)}\n` +
      (off <= EXPECTED_TOLERANCE
        ? 'this device computes the network the same way'
        : 'THIS DEVICE COMPUTES THE NETWORK DIFFERENTLY — its point losses are not comparable'),
  });

  model.dispose();
}

scope.onmessage = (event: MessageEvent<ProbeRequest>): void => {
  void probe(event.data).catch((error: unknown) => {
    post({ stage: 'failed', ok: false, detail: message(error) });
  });
};
