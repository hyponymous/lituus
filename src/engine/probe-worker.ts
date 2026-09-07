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
import { forgetNetwork, isNetworkCached, loadNetworkBytes } from './net-cache.ts';
import { NETWORK } from './network.ts';
import { checkWeights, weightsFingerprint, type WeightsCheck } from './weights-check.ts';
import { parseKataGoModelV8 } from './load-model-v8.ts';
import type { ParsedKataGoModelV8 } from './model-types.ts';
import { ModelV8, type Evaluation, type TraceStage } from './model-v8.ts';
import { readBackend } from './aligned-read.ts';
import { discoverHeadLayout, type HeadLayout } from './head-layout.ts';
import { checkOps, OP_TOLERANCE, type OpResult } from './op-check.ts';
import {
  checkReadback,
  READBACK_TOLERANCE,
  type LengthCheck,
  type ReadbackCheck,
} from './readback-check.ts';

export interface ProbeRequest {
  readonly networkUrl: string;
}

/**
 * What a step concluded. Three states rather than two, because a device can
 * behave badly in a way this build is built to step around — and colouring
 * that red would say the app is broken here when it is not.
 */
export type ProbeStatus = 'ok' | 'warn' | 'bad';

/** One finding at a time, so a hang is attributable to a step. */
export interface ProbeReport {
  readonly stage:
    | 'backend'
    | 'readback'
    | 'ops'
    | 'packing'
    | 'network'
    | 'parsed'
    | 'forward'
    | 'trace'
    | 'compare'
    | 'failed';
  readonly status: ProbeStatus;
  /** The word shown beside the step's title. */
  readonly note: string;
  readonly detail: string;
}

const scope = self as unknown as {
  postMessage(message: ProbeReport): void;
  onmessage: ((event: MessageEvent<ProbeRequest>) => void) | null;
};

const post = (report: ProbeReport): void => scope.postMessage(report);

/** The ordinary verdict: it agrees, or it does not. */
const verdict = (ok: boolean): { status: ProbeStatus; note: string } =>
  ok ? { status: 'ok', note: 'ok' } : { status: 'bad', note: 'differs' };

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * What the backend is holding, in the same terms the engine's own failures
 * report it: live GPU bytes, tensors, and every byte the buffer pool has
 * allocated. See `reportMemory` in `worker.ts` for why the two byte figures.
 */
function memoryLine(tf: typeof TF): string {
  // The WebGPU backend's own additions to `MemoryInfo`; see `worker.ts`.
  const info = tf.memory() as {
    numTensors: number;
    numBytesInGPU?: number;
    numBytesAllocatedInGPU?: number;
  };
  const mb = (bytes: number | undefined): string => `${Math.round((bytes ?? 0) / 1e6)}MB`;
  return (
    `holding ${mb(info.numBytesInGPU)} on the GPU in ${info.numTensors} tensors, ` +
    `${mb(info.numBytesAllocatedInGPU)} ever allocated`
  );
}

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
  post({ stage: 'backend', ...verdict(true), detail: `backend: ${tf.getBackend()}` });

  /*
   * Before the network, deliberately. It needs no download and no model, so a
   * phone that cannot get past this line has already answered the question —
   * and 37MB later would be a slow way to learn it.
   */
  const readback: ReadbackCheck = await checkReadback(tf);
  const suspect = (one: LengthCheck): boolean =>
    one.syncWorst >= READBACK_TOLERANCE || one.asyncWorst >= READBACK_TOLERANCE;
  post({
    stage: 'readback',
    /*
     * A device that fails only the two-cycle lengths is not marked bad. It is
     * the known fault, every read this build makes is padded past it, and the
     * compare step at the end is what says whether that worked. Red is kept for
     * a device that gets a whole-row read wrong, which nothing here can dodge.
     */
    status: readback.ok ? (readback.losesSecondCycle ? 'warn' : 'ok') : 'bad',
    note: readback.ok ? (readback.losesSecondCycle ? 'known fault' : 'ok') : 'differs',
    detail:
      'known floats through the GPU, at lengths either side of a whole ' +
      'canvas row\n' +
      'floats  cycles  dataSync   await data()\n' +
      readback.lengths
        .map(
          (one: LengthCheck) =>
            `${String(one.count).padStart(5)}  ${String(one.passes).padStart(6)}  ` +
            `${one.syncWorst.toExponential(2)}  ${one.asyncWorst.toExponential(2)}` +
            (suspect(one)
              ? `  WRONG at ${one.syncWorstAt}: expected ${one.expected.toPrecision(9)}, ` +
                `got ${one.gotSync.toPrecision(9)}` +
                (one.tailRepeatsHead ? ' — and the tail repeats the head' : '')
              : ''),
        )
        .join('\n') +
      (readback.losesSecondCycle
        ? '\nTHIS DEVICE LOSES THE SECOND CYCLE. Every read that fills whole ' +
          'rows comes back exactly, every read that does not comes back with ' +
          'its tail repeating its head, and the asynchronous read is right ' +
          'throughout. The model pads every read to whole rows, so none of ' +
          'them take that path — the last step is where that is checked.'
        : readback.ok
          ? '\nevery length comes back exactly, both ways'
          : '\nA READ THAT FILLS WHOLE ROWS IS WRONG HERE, which no padding ' +
            'can step around'),
  });

  /*
   * Still before the network: every case here is a small tensor, and an
   * operation that disagrees with this device's own CPU is the answer on its
   * own. The CPU backend is imported for this and nothing else.
   */
  await import('@tensorflow/tfjs-backend-cpu');
  const ops: OpResult[] = await checkOps(tf);
  const differs = (op: OpResult): boolean => op.worst > OP_TOLERANCE;
  const broken: OpResult[] = ops.filter(differs);
  post({
    stage: 'ops',
    ...verdict(broken.length === 0),
    detail:
      `${ops.length} operations, this GPU against this CPU\n` +
      ops
        .map(
          (op: OpResult) =>
            `${differs(op) ? 'DIFFERS' : '   ok  '} ${op.worst.toExponential(2)}  ${op.name}` +
            `${differs(op) ? ` (gpu ${op.gpu.toPrecision(6)}, cpu ${op.cpu.toPrecision(6)})` : ''}`,
        )
        .join('\n'),
  });

  /*
   * The packed heads, read back and looked at. Every stage of the network can
   * agree and the answer still come out wrong if this buffer does not contain
   * what was put in it — which is how the value, score and pass slots came back
   * holding policy numbers on a phone.
   */
  // Policy, pass, value, score. The last two are this network's head widths,
  // written out because the packing is asked about before the network is
  // loaded — deliberately, so a phone that fails here does not download 37MB
  // first. `ModelV8` measures the real lengths from the weights it parsed.
  const sizes: readonly number[] = [EXPECTED_SIZE * EXPECTED_SIZE, 1, 3, 4];
  const layout: HeadLayout | null = discoverHeadLayout(readBackend(tf), sizes);
  const tight: readonly number[] = sizes.map((_size, which) =>
    sizes.slice(0, which).reduce((a: number, b: number) => a + b, 0),
  );
  post({
    stage: 'packing',
    ...verdict(layout !== null),
    detail:
      layout === null
        ? 'THE SEGMENTS ARE NOT IN THE PACKED BUFFER — the packed read does ' +
          'not come back intact on this device, and the heads are read one at ' +
          'a time instead'
        : `${layout.length} floats, ${sizes.reduce((a: number, b: number) => a + b, 0)} of them data\n` +
          `policy, pass, value, score start at ${layout.offsets.join(', ')}\n` +
          `packed tightly they would be at    ${tight.join(', ')}\n` +
          (layout.tight
            ? 'every head intact and where the arithmetic says'
            : 'PADDED — the offsets are measured rather than assumed, and the ' +
              'heads are read from where they actually are'),
  });

  /*
   * The weights, hashed. Everything above says the machine is fine: the bytes
   * come back off the GPU exactly, and every operation agrees with the device's
   * own CPU. What is left is what is being multiplied — and until now the only
   * check on a 37MB download was its compressed length and a plausible-looking
   * first sixty-four bytes.
   *
   * If the hash is wrong, the cached copy is evicted and the network fetched
   * again, and both hashes are reported. A second wrong hash is a download or
   * decompression that damages the file on this device; a right one after a
   * wrong one is a poisoned cache, which every visit was re-reading.
   */
  const cached: boolean = await isNetworkCached(request.networkUrl);
  let bytes: Uint8Array = await loadNetworkBytes(request.networkUrl);
  let weights: WeightsCheck = await checkWeights(bytes);
  let detail: string =
    `${cached ? 'from the cache' : 'freshly downloaded'}\n` +
    `${weights.bytes.toLocaleString('en-US')} bytes inflated, expected ` +
    `${NETWORK.inflatedBytes.toLocaleString('en-US')}\n` +
    `sha256 ${weights.sha256}\n` +
    `expect ${NETWORK.sha256}`;

  if (!weights.matches) {
    await forgetNetwork(request.networkUrl);
    bytes = await loadNetworkBytes(request.networkUrl);
    const again: WeightsCheck = await checkWeights(bytes);
    detail +=
      `\nWEIGHTS ARE NOT THE EXPECTED ONES. re-downloaded:\n` +
      `${again.bytes.toLocaleString('en-US')} bytes, sha256 ${again.sha256}\n` +
      (again.matches
        ? 'the fresh copy is correct — the cached one was damaged'
        : again.sha256 === weights.sha256
          ? 'the same wrong bytes again — this device damages the file on the way in'
          : 'wrong a second time, and differently — the damage is not repeatable');
    weights = again;
  }

  const parsed: ParsedKataGoModelV8 = parseKataGoModelV8(bytes);
  const model = new ModelV8(tf, parsed);
  post({
    stage: 'network',
    ...verdict(weights.matches),
    detail: `${parsed.modelName}, v${parsed.modelVersion}\n${detail}`,
  });

  /*
   * The weights as the parser leaves them. The file hashing correctly does not
   * mean the arrays handed to the GPU match: between the two sits a parse that
   * reads binary floats and merges each batch norm, in JavaScript, on this
   * device. Compare this line between two machines before blaming the GPU.
   */
  const fingerprint = weightsFingerprint(parsed);
  post({
    stage: 'parsed',
    ...verdict(true),
    detail:
      `${fingerprint.floats.toLocaleString('en-US')} floats\n` +
      `fingerprint ${fingerprint.hex}`,
  });

  const canary = new Canary(model, size);
  const inputs = canaryInputs(size * size);
  const evaluation: Evaluation = model.evaluate(inputs.spatial, inputs.global, size);
  post({
    stage: 'forward',
    ...verdict(true),
    detail:
      `heads at ${size}x${size} [win, loss, noResult, scoreMean, ` +
      `scoreStdev, lead, varTimeLeft, pass, policy sum]\n` +
      `${digits(canaryHeads(evaluation))}\n` +
      `drift against itself: ${canary.drift().toExponential(3)}\n` +
      // What a 15-block network and one pass cost to hold, which is the
      // question behind every worker a phone kills without a word.
      memoryLine(tf),
  });

  /*
   * Stage by stage, so the first place two machines part can be named. Printed
   * unconditionally rather than only on a mismatch: the healthy machine's
   * numbers are the thing a failing one has to be compared against, and they
   * have to come from somewhere.
   */
  const trace: TraceStage[] = model.traceForward(inputs.spatial, inputs.global, size);
  post({
    stage: 'trace',
    ...verdict(true),
    detail: trace
      .map(
        (one: TraceStage) =>
          `${one.label.padEnd(22)} mean ${one.mean.toPrecision(8).padStart(13)}  ` +
          `min ${one.min.toPrecision(8).padStart(13)}  max ${one.max.toPrecision(8).padStart(13)}`,
      )
      .join('\n'),
  });

  const off: number = canary.against(EXPECTED_HEADS);
  post({
    stage: 'compare',
    ...verdict(off <= EXPECTED_TOLERANCE),
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
    post({ stage: 'failed', status: 'bad', note: 'failed', detail: message(error) });
  });
};
