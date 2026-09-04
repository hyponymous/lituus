/**
 * The KataGo v8 network as a TensorFlow.js graph.
 *
 * Upstream: `src/engine/katago/modelV8.ts` in web-katrain
 * (https://github.com/Sir-Teo/web-katrain), MIT. Like `features-v7.ts` this is
 * a transcription: the trunk, the two heads and the pooling formulas are fixed
 * by the file format, and every constant in them belongs to KataGo.
 *
 * This is the only module in `engine/` that imports TensorFlow.js. Everything
 * else — the parser, the board, the planes — runs under `node --test` with no
 * bundler and no GPU, which is what lets most of the engine be tested at all.
 *
 * Two divergences from upstream, both subtractive:
 *
 * **No ownership head.** lituus never shows an ownership map, so the head is
 * parsed (the file has to be read in order) and then not built. That is one
 * convolution and one weight tensor less per position, which is worth having on
 * a device whose ceiling is a memory high-water mark
 * (`docs/katago-feasibility.md` §7).
 *
 * **One forward method, not three.** Upstream offers policy-and-value,
 * value-only and everything. A search that needs the policy at every expansion
 * and the value at every leaf gets both from one call.
 */

import type * as TF from '@tensorflow/tfjs-core';
import type { ActivationKind, ParsedBatchNorm, ParsedConv2d, ParsedMatMul } from './bin-model-parser.ts';
import type { ParsedKataGoModelV8, ParsedTrunkBlock } from './model-types.ts';

/** Batch norm folded into a scale and a bias, as the parser leaves it. */
interface Norm {
  readonly scale: TF.Tensor4D;
  readonly bias: TF.Tensor4D;
}

interface Conv {
  readonly dilationY: number;
  readonly dilationX: number;
  readonly filter: TF.Tensor4D;
}

type Block =
  | {
      readonly kind: 'ordinary';
      readonly preBN: Norm;
      readonly preActivation: ActivationKind;
      readonly w1: Conv;
      readonly midBN: Norm;
      readonly midActivation: ActivationKind;
      readonly w2: Conv;
    }
  | {
      readonly kind: 'gpool';
      readonly preBN: Norm;
      readonly preActivation: ActivationKind;
      readonly w1a: Conv;
      readonly w1b: Conv;
      readonly gpoolBN: Norm;
      readonly gpoolActivation: ActivationKind;
      readonly w1r: TF.Tensor2D;
      readonly midBN: Norm;
      readonly midActivation: ActivationKind;
      readonly w2: Conv;
    }
  | {
      readonly kind: 'nested';
      readonly preBN: Norm;
      readonly preActivation: ActivationKind;
      readonly preConv: Conv;
      readonly blocks: readonly Block[];
      readonly postBN: Norm;
      readonly postActivation: ActivationKind;
      readonly postConv: Conv;
    };

/** What one forward pass yields. Logits throughout; postprocessing is separate. */
export interface Evaluation {
  /** Per-point policy logits, length `area`. */
  readonly policy: Float32Array;
  /** The logit for passing. */
  readonly policyPass: number;
  /** `[win, loss, noResult]` logits from the point of view of the player to move. */
  readonly value: Float32Array;
  /** `[scoreMean, scoreStdevPreSoftplus, lead, varTimeLeftPreSoftplus]`. */
  readonly scoreValue: Float32Array;
}

/**
 * What a dead readback looks like, and why anything has to look for it.
 *
 * `dataSync` on the WebGPU backend is not a readback at all: tfjs copies the
 * buffer into a pair of freshly made `OffscreenCanvas` WebGPU contexts and
 * recovers the bytes through `drawImage` and `getImageData`. When the device
 * has been lost that pipeline still runs — and returns **zeros**, with no
 * error anywhere.
 *
 * Zeros are not a bad evaluation, they are a silently ruinous one. Every value
 * logit equal makes win, loss and no-result each a third, so `winLossValue` is
 * 0 and every lead is 0; a flat policy makes every prior equal, so the search
 * visits points in board order and every tie-break in `search.ts` resolves to
 * the lowest index. The result reads as a fully searched verdict claiming that
 * A19 is the best move and that nothing anyone plays gives up a point — and it
 * is stored, so nothing later asks the question again. That is the failure
 * this exists to convert into an error (dogfood, 2026-09-03: 62 consecutive
 * prompts scored 0.00 with a best move of A19).
 *
 * The test is exact equality across all eight head outputs, plus a finiteness
 * check. A live network hits any one of them at zero often enough; hitting all
 * eight at once, bit for bit, is not something a float pipeline does.
 */
export function isDegenerate(evaluation: Evaluation): boolean {
  const heads: readonly number[] = [
    ...evaluation.value,
    ...evaluation.scoreValue,
    evaluation.policyPass,
  ];
  return heads.every((x: number) => x === 0) || heads.some((x: number) => !Number.isFinite(x));
}

/**
 * What the user is told when the readback dies. Phrased as the engine stopping
 * rather than as a bug, because that is what it is from the outside, and it
 * reaches the status line through the worker's per-move error path.
 */
export const DEAD_READBACK =
  'The GPU stopped returning results, so scoring cannot continue.';

export class ModelV8 {
  readonly name: string;
  readonly version: number;
  readonly postProcess: ParsedKataGoModelV8['postProcessParams'];

  private readonly tf: typeof TF;
  private readonly tensors: TF.Tensor[] = [];

  private readonly conv1: Conv;
  private readonly ginput: TF.Tensor2D;
  private readonly blocks: readonly Block[];
  private readonly tipBN: Norm;
  private readonly tipActivation: ActivationKind;

  private readonly p1: Conv;
  private readonly g1: Conv;
  private readonly g1BN: Norm;
  private readonly g1Activation: ActivationKind;
  private readonly gpoolToBias: TF.Tensor2D;
  private readonly p1BN: Norm;
  private readonly p1Activation: ActivationKind;
  private readonly p2: Conv;
  private readonly passMul: TF.Tensor2D;
  private readonly passBias?: TF.Tensor2D;
  private readonly passActivation?: ActivationKind;
  private readonly passMul2?: TF.Tensor2D;

  private readonly v1: Conv;
  private readonly v1BN: Norm;
  private readonly v1Activation: ActivationKind;
  private readonly v2: TF.Tensor2D;
  private readonly v2Bias: TF.Tensor2D;
  private readonly v2Activation: ActivationKind;
  private readonly v3: TF.Tensor2D;
  private readonly v3Bias: TF.Tensor2D;
  private readonly sv3: TF.Tensor2D;
  private readonly sv3Bias: TF.Tensor2D;

  constructor(tf: typeof TF, parsed: ParsedKataGoModelV8) {
    this.tf = tf;
    this.name = parsed.modelName;
    this.version = parsed.modelVersion;
    this.postProcess = parsed.postProcessParams;

    const keep = <T extends TF.Tensor>(tensor: T): T => {
      this.tensors.push(tensor);
      return tensor;
    };
    const norm = (bn: ParsedBatchNorm): Norm => ({
      scale: keep(tf.tensor4d(bn.mergedScale, [1, 1, 1, bn.channels])),
      bias: keep(tf.tensor4d(bn.mergedBias, [1, 1, 1, bn.channels])),
    });
    // File weights are [kY, kX, inC, outC], which is already tf.conv2d's filter
    // layout — no transpose, and none should ever be added.
    const conv = (c: ParsedConv2d): Conv => ({
      dilationY: c.dilationY,
      dilationX: c.dilationX,
      filter: keep(tf.tensor4d(c.weights, [c.kernelY, c.kernelX, c.inChannels, c.outChannels])),
    });
    const mat = (m: ParsedMatMul): TF.Tensor2D =>
      keep(tf.tensor2d(m.weights, [m.inChannels, m.outChannels]));
    const bias = (b: { channels: number; weights: Float32Array }): TF.Tensor2D =>
      keep(tf.tensor2d(b.weights, [1, b.channels]));

    const block = (b: ParsedTrunkBlock): Block => {
      if (b.kind === 'ordinary') {
        return {
          kind: 'ordinary',
          preBN: norm(b.preBN),
          preActivation: b.preActivation,
          w1: conv(b.w1),
          midBN: norm(b.midBN),
          midActivation: b.midActivation,
          w2: conv(b.w2),
        };
      }
      if (b.kind === 'gpool') {
        return {
          kind: 'gpool',
          preBN: norm(b.preBN),
          preActivation: b.preActivation,
          w1a: conv(b.w1a),
          w1b: conv(b.w1b),
          gpoolBN: norm(b.gpoolBN),
          gpoolActivation: b.gpoolActivation,
          w1r: mat(b.w1r),
          midBN: norm(b.midBN),
          midActivation: b.midActivation,
          w2: conv(b.w2),
        };
      }
      return {
        kind: 'nested',
        preBN: norm(b.preBN),
        preActivation: b.preActivation,
        preConv: conv(b.preConv),
        blocks: b.blocks.map(block),
        postBN: norm(b.postBN),
        postActivation: b.postActivation,
        postConv: conv(b.postConv),
      };
    };

    this.conv1 = conv(parsed.trunk.conv1);
    this.ginput = mat(parsed.trunk.ginput);
    this.blocks = parsed.trunk.blocks.map(block);
    this.tipBN = norm(parsed.trunk.tipBN);
    this.tipActivation = parsed.trunk.tipActivation;

    this.p1 = conv(parsed.policy.p1);
    this.g1 = conv(parsed.policy.g1);
    this.g1BN = norm(parsed.policy.g1BN);
    this.g1Activation = parsed.policy.g1Activation;
    this.gpoolToBias = mat(parsed.policy.gpoolToBias);
    this.p1BN = norm(parsed.policy.p1BN);
    this.p1Activation = parsed.policy.p1Activation;
    this.p2 = conv(parsed.policy.p2);
    this.passMul = mat(parsed.policy.passMul);
    this.passBias = parsed.policy.passBias ? bias(parsed.policy.passBias) : undefined;
    this.passActivation = parsed.policy.passActivation;
    this.passMul2 = parsed.policy.passMul2 ? mat(parsed.policy.passMul2) : undefined;

    this.v1 = conv(parsed.value.v1);
    this.v1BN = norm(parsed.value.v1BN);
    this.v1Activation = parsed.value.v1Activation;
    this.v2 = mat(parsed.value.v2);
    this.v2Bias = bias(parsed.value.v2Bias);
    this.v2Activation = parsed.value.v2Activation;
    this.v3 = mat(parsed.value.v3);
    this.v3Bias = bias(parsed.value.v3Bias);
    this.sv3 = mat(parsed.value.sv3);
    this.sv3Bias = bias(parsed.value.sv3Bias);
  }

  // ── Primitives ─────────────────────────────────────────────────────────────

  private activate<T extends TF.Tensor>(x: T, kind: ActivationKind): T {
    if (kind === 'identity') return x;
    if (kind === 'relu') return this.tf.relu(x);
    // mish: x * tanh(softplus(x))
    return this.tf.mul(x, this.tf.tanh(this.tf.softplus(x))) as T;
  }

  private normAct(x: TF.Tensor4D, norm: Norm, kind: ActivationKind): TF.Tensor4D {
    return this.activate(
      this.tf.add(this.tf.mul(x, norm.scale), norm.bias) as TF.Tensor4D,
      kind,
    );
  }

  private conv(x: TF.Tensor4D, c: Conv): TF.Tensor4D {
    return this.tf.conv2d(x, c.filter, 1, 'same', 'NHWC', [c.dilationY, c.dilationX]);
  }

  /**
   * KataGo's global pooling: the channel mean, the mean scaled by board size,
   * and the channel max, concatenated.
   *
   * The board-size term is how one network serves 9x9 and 19x19: it tells the
   * pooled statistics how much board they were averaged over.
   */
  private poolGlobal(x: TF.Tensor4D): TF.Tensor2D {
    const tf = this.tf;
    const size: number = x.shape[1];
    const mean = tf.mean(x, [1, 2]) as TF.Tensor2D;
    const max = tf.max(x, [1, 2]) as TF.Tensor2D;
    return tf.concat([mean, tf.mul(mean, (size - 14) * 0.1), max], 1) as TF.Tensor2D;
  }

  /** The value head's pooling: three scalings of the mean, and no max. */
  private poolValue(x: TF.Tensor4D): TF.Tensor2D {
    const tf = this.tf;
    const size: number = x.shape[1];
    const base: number = size - 14;
    const mean = tf.mean(x, [1, 2]) as TF.Tensor2D;
    return tf.concat(
      [mean, tf.mul(mean, base * 0.1), tf.mul(mean, base * base * 0.01 - 0.1)],
      1,
    ) as TF.Tensor2D;
  }

  /** Add a per-channel bias, broadcast across the board. */
  private addChannelBias(x: TF.Tensor4D, bias: TF.Tensor2D): TF.Tensor4D {
    return this.tf.add(x, this.tf.reshape(bias, [bias.shape[0], 1, 1, bias.shape[1]])) as TF.Tensor4D;
  }

  private stack(trunk: TF.Tensor4D, blocks: readonly Block[]): TF.Tensor4D {
    const tf = this.tf;
    let out: TF.Tensor4D = trunk;

    for (const block of blocks) {
      const pre = this.normAct(out, block.preBN, block.preActivation);

      if (block.kind === 'ordinary') {
        const mid = this.normAct(this.conv(pre, block.w1), block.midBN, block.midActivation);
        out = tf.add(out, this.conv(mid, block.w2)) as TF.Tensor4D;
        continue;
      }

      if (block.kind === 'gpool') {
        const regular = this.conv(pre, block.w1a);
        const pooled = this.normAct(
          this.conv(pre, block.w1b),
          block.gpoolBN,
          block.gpoolActivation,
        );
        const biased = this.addChannelBias(
          regular,
          tf.matMul(this.poolGlobal(pooled), block.w1r) as TF.Tensor2D,
        );
        const mid = this.normAct(biased, block.midBN, block.midActivation);
        out = tf.add(out, this.conv(mid, block.w2)) as TF.Tensor4D;
        continue;
      }

      const inner = this.stack(this.conv(pre, block.preConv), block.blocks);
      const post = this.normAct(inner, block.postBN, block.postActivation);
      out = tf.add(out, this.conv(post, block.postConv)) as TF.Tensor4D;
    }
    return out;
  }

  // ── Forward ────────────────────────────────────────────────────────────────

  /**
   * One position through the network.
   *
   * `spatial` is `[1, size, size, 22]` and `global` is `[1, 19]`, as
   * `features-v7.ts` builds them. Everything comes back as logits: converting
   * them into a win probability and a score lead is `postprocess`'s job, and
   * keeping the two apart is what let the graph be checked against KataGo's own
   * numbers without a search in the way.
   */
  evaluate(spatial: Float32Array, global: Float32Array, size: number): Evaluation {
    const tf = this.tf;

    const [policy, policyPass, value, scoreValue] = tf.tidy(() => {
      const input = tf.tensor4d(spatial, [1, size, size, 22]);
      const globals = tf.tensor2d(global, [1, global.length]);

      let trunk = this.conv(input, this.conv1);
      trunk = this.addChannelBias(trunk, tf.matMul(globals, this.ginput) as TF.Tensor2D);
      trunk = this.stack(trunk, this.blocks);
      trunk = this.normAct(trunk, this.tipBN, this.tipActivation);

      // Policy head. The pooled statistics bias the per-point head and also
      // produce the pass logit, which is why they are computed once here.
      const pooled = this.poolGlobal(
        this.normAct(this.conv(trunk, this.g1), this.g1BN, this.g1Activation),
      );
      const biased = this.addChannelBias(
        this.conv(trunk, this.p1),
        tf.matMul(pooled, this.gpoolToBias) as TF.Tensor2D,
      );
      const policyOut = this.conv(
        this.normAct(biased, this.p1BN, this.p1Activation),
        this.p2,
      );

      let pass = tf.matMul(pooled, this.passMul) as TF.Tensor2D;
      if (this.passBias && this.passActivation && this.passMul2) {
        pass = this.activate(tf.add(pass, this.passBias) as TF.Tensor2D, this.passActivation);
        pass = tf.matMul(pass, this.passMul2) as TF.Tensor2D;
      }

      // Value head.
      const v1Out = this.normAct(this.conv(trunk, this.v1), this.v1BN, this.v1Activation);
      const v2Out = this.activate(
        tf.add(tf.matMul(this.poolValue(v1Out), this.v2) as TF.Tensor2D, this.v2Bias) as TF.Tensor2D,
        this.v2Activation,
      );
      const valueOut = tf.add(tf.matMul(v2Out, this.v3) as TF.Tensor2D, this.v3Bias) as TF.Tensor2D;
      let scoreOut = tf.add(tf.matMul(v2Out, this.sv3) as TF.Tensor2D, this.sv3Bias) as TF.Tensor2D;
      // Later networks carry extra score outputs we do not read.
      if (scoreOut.shape[1] > 4) scoreOut = tf.slice(scoreOut, [0, 0], [1, 4]) as TF.Tensor2D;

      // Channel 0 of the policy head is the move policy; later channels are
      // auxiliary targets from training that nothing here uses.
      const flat = tf.reshape(policyOut, [size * size, policyOut.shape[3]]);
      return [
        tf.slice(flat, [0, 0], [size * size, 1]),
        tf.slice(pass, [0, 0], [1, 1]),
        valueOut,
        scoreOut,
      ];
    });

    const result: Evaluation = {
      policy: policy.dataSync() as Float32Array,
      policyPass: (policyPass.dataSync() as Float32Array)[0],
      value: value.dataSync() as Float32Array,
      scoreValue: scoreValue.dataSync() as Float32Array,
    };
    tf.dispose([policy, policyPass, value, scoreValue]);
    // Checked here rather than in the search: this is the one place a GPU
    // buffer becomes a number, and a fake network in a test cannot fail this way.
    if (isDegenerate(result)) throw new Error(DEAD_READBACK);
    return result;
  }

  /** Release the weights. The model is unusable afterwards. */
  dispose(): void {
    this.tf.dispose(this.tensors);
    this.tensors.length = 0;
  }
}

/** A win probability and a score, from the player-to-move's point of view. */
export interface Judgement {
  readonly winrate: number;
  readonly scoreLead: number;
  readonly scoreMean: number;
  readonly scoreStdev: number;
  readonly noResult: number;
}

const softplus = (x: number): number => {
  if (x > 20) return x;
  if (x < -20) return Math.exp(x);
  return Math.log1p(Math.exp(x));
};

/**
 * Logits into the numbers the product quotes.
 *
 * Upstream: `evalV8.ts`. Kept separate from the graph because it is arithmetic
 * with no GPU in it, and because the multipliers are per-network values read
 * out of the file rather than constants anyone may tune.
 *
 * Everything here stays in the player-to-move's frame. KataGo's analysis engine
 * reports the same way, which is what makes the two directly comparable — and
 * every point loss in this project is a difference between two such figures, so
 * the frame cancels out anyway.
 */
export function postprocess(
  value: Float32Array,
  scoreValue: Float32Array,
  params: ParsedKataGoModelV8['postProcessParams'],
): Judgement {
  const scale: number = params.outputScaleMultiplier;
  const win: number = value[0] * scale;
  const loss: number = value[1] * scale;
  const none: number = value[2] * scale;

  const highest: number = Math.max(win, loss, none);
  const winExp: number = Math.exp(win - highest);
  const lossExp: number = Math.exp(loss - highest);
  const noneExp: number = Math.exp(none - highest);
  const total: number = winExp + lossExp + noneExp;

  const winrate: number = winExp / total;
  const noResult: number = noneExp / total;

  const stdev: number = softplus(scoreValue[1] * scale) * params.scoreStdevMultiplier;
  // Made unconditional on the game actually finishing, which is what KataGo
  // reports and therefore what a comparison against it has to reproduce.
  const alive: number = 1 - noResult;

  return {
    winrate,
    scoreLead: scoreValue[2] * scale * params.leadMultiplier * alive,
    scoreMean: scoreValue[0] * scale * params.scoreMeanMultiplier * alive,
    scoreStdev: stdev,
    noResult,
  };
}
