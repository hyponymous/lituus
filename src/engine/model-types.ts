/**
 * The shape of a parsed KataGo V8 model, independent of how it is evaluated.
 *
 * Upstream: the type declarations at the top of `src/engine/katago/modelV8.ts`
 * in web-katrain (https://github.com/Sir-Teo/web-katrain), MIT.
 *
 * Split out from the TensorFlow.js graph on purpose. `loadModelV8.ts` produces
 * one of these and imports nothing that needs a GPU or a DOM, so a network can
 * be fetched and structurally validated — which is most of what the deployment
 * spike does — without pulling in TensorFlow.js at all.
 */

import type {
  ActivationKind,
  ParsedBatchNorm,
  ParsedConv2d,
  ParsedMatBias,
  ParsedMatMul,
} from './bin-model-parser.ts';

export type ParsedTrunkBlock =
  | {
      kind: 'ordinary';
      preBN: ParsedBatchNorm;
      preActivation: ActivationKind;
      w1: ParsedConv2d;
      midBN: ParsedBatchNorm;
      midActivation: ActivationKind;
      w2: ParsedConv2d;
    }
  | {
      kind: 'gpool';
      preBN: ParsedBatchNorm;
      preActivation: ActivationKind;
      w1a: ParsedConv2d;
      w1b: ParsedConv2d;
      gpoolBN: ParsedBatchNorm;
      gpoolActivation: ActivationKind;
      w1r: ParsedMatMul;
      midBN: ParsedBatchNorm;
      midActivation: ActivationKind;
      w2: ParsedConv2d;
    }
  | {
      kind: 'nested_bottleneck';
      numBlocks: number;
      preBN: ParsedBatchNorm;
      preActivation: ActivationKind;
      preConv: ParsedConv2d;
      blocks: ParsedTrunkBlock[];
      postBN: ParsedBatchNorm;
      postActivation: ActivationKind;
      postConv: ParsedConv2d;
    };

export type ParsedKataGoModelV8 = {
  modelName: string;
  modelVersion: number;
  numInputChannels: number;
  numInputGlobalChannels: number;
  metaEncoderVersion: number;
  postProcessParams: {
    tdScoreMultiplier: number;
    scoreMeanMultiplier: number;
    scoreStdevMultiplier: number;
    leadMultiplier: number;
    varianceTimeMultiplier: number;
    shorttermValueErrorMultiplier: number;
    shorttermScoreErrorMultiplier: number;
    outputScaleMultiplier: number;
  };
  policyOutChannels: number;
  scoreValueChannels: number;
  trunk: {
    numBlocks: number;
    trunkNumChannels: number;
    midNumChannels: number;
    regularNumChannels: number;
    gpoolNumChannels: number;
    conv1: ParsedConv2d;
    ginput: ParsedMatMul;
    blocks: ParsedTrunkBlock[];
    tipBN: ParsedBatchNorm;
    tipActivation: ActivationKind;
  };
  policy: {
    p1: ParsedConv2d;
    g1: ParsedConv2d;
    g1BN: ParsedBatchNorm;
    g1Activation: ActivationKind;
    gpoolToBias: ParsedMatMul;
    p1BN: ParsedBatchNorm;
    p1Activation: ActivationKind;
    p2: ParsedConv2d;
    passMul: ParsedMatMul;
    passBias?: ParsedMatBias;
    passActivation?: ActivationKind;
    passMul2?: ParsedMatMul;
  };
  value: {
    v1: ParsedConv2d;
    v1BN: ParsedBatchNorm;
    v1Activation: ActivationKind;
    v2: ParsedMatMul;
    v2Bias: ParsedMatBias;
    v2Activation: ActivationKind;
    v3: ParsedMatMul;
    v3Bias: ParsedMatBias;
    sv3: ParsedMatMul;
    sv3Bias: ParsedMatBias;
    ownership: ParsedConv2d;
  };
};
