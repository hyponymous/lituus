/**
 * Deployment spike: does TensorFlow.js reach a real GPU from a built,
 * base-pathed, GitHub-Pages-served module worker?
 *
 * This answers what a laptop running `npm run dev` cannot. Worker construction,
 * code splitting and dynamic import all resolve differently once Vite has
 * rewritten them for `/lituus/`, and `navigator.gpu` is absent outside a secure
 * context — so the only honest place to ask is the deployed site.
 *
 * It does not evaluate a network. Parsing is the page's job and needs no GPU;
 * this establishes that the backend exists and computes, which is the half that
 * fails invisibly.
 *
 * Temporary in intent, not in care: this is the lifecycle the real analysis
 * worker will have, minus the search.
 */

import type * as TF from '@tensorflow/tfjs-core';

/** Progress, one stage at a time, so a hang is attributable to a stage. */
export interface SpikeWorkerReport {
  readonly stage: 'adapter' | 'import' | 'backend' | 'compute' | 'failed';
  readonly ok: boolean;
  readonly detail: string;
}

/*
 * Under the DOM lib `self` types as a `Window`, whose `postMessage` demands a
 * target origin it has no business having here. Pulling in the WebWorker lib
 * instead would collide with DOM across the rest of the project, so the
 * worker's global is narrowed in the one file that needs it.
 */
const scope = self as unknown as { postMessage(message: SpikeWorkerReport): void };

const post = (report: SpikeWorkerReport): void => scope.postMessage(report);

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * What the browser actually gives us, asked directly rather than through
 * TensorFlow.js.
 *
 * Worth asking separately: a software adapter answers `requestAdapter()`
 * perfectly happily and then measures the CPU, which is the trap
 * `experiments/browser/README.md` documents. Reporting the adapter is how a
 * fallback gets noticed rather than quietly benchmarked.
 */
async function describeAdapter(): Promise<string> {
  if (!('gpu' in navigator)) {
    return 'navigator.gpu absent — not a secure context, or no WebGPU here';
  }
  const adapter: GPUAdapter | null = await navigator.gpu.requestAdapter();
  if (!adapter) return 'requestAdapter() returned null';

  // `info` is the current shape and `requestAdapterInfo()` the older one, still
  // shipping in some browsers. Neither is guaranteed to be present.
  const either = adapter as GPUAdapter & {
    readonly info?: GPUAdapterInfo;
    readonly requestAdapterInfo?: () => Promise<GPUAdapterInfo>;
  };
  const info: GPUAdapterInfo | undefined = either.info ?? (await either.requestAdapterInfo?.());
  if (!info) return 'adapter present, no info API';

  const parts: string[] = [info.vendor, info.architecture, info.device, info.description].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  );
  return parts.length > 0 ? parts.join(' / ') : 'adapter present, no details exposed';
}

/**
 * All-ones convolution, checked against the count of taps that land on the
 * board.
 *
 * A convolution rather than a matmul because it is what the trunk is made of.
 * Checking the total matters more than it looks: selecting a backend proves
 * nothing, and a backend that returns confident garbage is exactly the failure
 * that would otherwise travel all the way to a point-loss figure.
 */
function conv2dChecksum(tf: typeof TF): { sum: Promise<number>; expected: number; dispose: () => void } {
  const channels = 32;
  const size = 19;
  const input: TF.Tensor4D = tf.ones([1, size, size, channels]);
  const filter: TF.Tensor4D = tf.ones([3, 3, channels, channels]);
  const output: TF.Tensor4D = tf.conv2d(input, filter, 1, 'same');

  // Each output is `channels` times the number of in-bounds filter taps. Summed
  // over the board that count factorizes: interior rows see three taps, the two
  // edge rows see two, and the same for columns.
  const taps: number = (3 * (size - 2) + 2 * 2) ** 2;
  return {
    // `tf.sum` rather than `output.sum()`: the chained-ops surface lives
    // behind a separate tfjs-core import that nothing else here needs.
    sum: tf.sum(output).data().then((values: TF.TypedArray) => values[0]),
    expected: channels * channels * taps,
    dispose: () => tf.dispose([input, filter, output]),
  };
}

async function run(): Promise<void> {
  try {
    post({ stage: 'adapter', ok: true, detail: await describeAdapter() });
  } catch (error: unknown) {
    post({ stage: 'adapter', ok: false, detail: message(error) });
  }

  let tf: typeof TF;
  try {
    // Dynamic, and reached only from this worker. That is what keeps a session
    // with AI scoring off from downloading any of it — PRD §4.
    // `tfjs-core` and the one backend, not the `tfjs` umbrella package: the
    // KataGo graph uses core ops only, and layers/converter/data would be a
    // few hundred KB of bundle nobody here calls.
    tf = await import('@tensorflow/tfjs-core');
    await import('@tensorflow/tfjs-backend-webgpu');
    post({ stage: 'import', ok: true, detail: `tfjs-core ${tf.version_core}` });
  } catch (error: unknown) {
    post({ stage: 'failed', ok: false, detail: `import: ${message(error)}` });
    return;
  }

  try {
    const accepted: boolean = await tf.setBackend('webgpu');
    await tf.ready();
    const backend: string = tf.getBackend();
    // A refused `setBackend` leaves the previous backend in place rather than
    // throwing, so the name it reports afterwards is the fact worth printing.
    post({
      stage: 'backend',
      ok: accepted && backend === 'webgpu',
      detail: backend === 'webgpu' ? 'webgpu' : `${backend} — webgpu unavailable`,
    });
  } catch (error: unknown) {
    post({ stage: 'failed', ok: false, detail: `setBackend: ${message(error)}` });
    return;
  }

  try {
    const started: number = performance.now();
    const check = conv2dChecksum(tf);
    const sum: number = await check.sum;
    const elapsed: number = performance.now() - started;
    check.dispose();

    post({
      stage: 'compute',
      ok: Math.abs(sum - check.expected) < check.expected * 1e-4,
      detail:
        `conv2d in ${elapsed.toFixed(0)}ms — checksum ${sum}, ` +
        `expected ${check.expected}`,
    });
  } catch (error: unknown) {
    post({ stage: 'failed', ok: false, detail: `compute: ${message(error)}` });
  }
}

void run();
