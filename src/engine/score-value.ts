/**
 * Score utility: how many points are worth how much, and the tables behind it.
 *
 * Upstream: `ScoreValue` in `cpp/neuralnet/nninputs.cpp`, and the
 * `DistributionTable` built in `cpp/search/search.cpp`. Both are pure
 * arithmetic over KataGo's own constants, which is why they live apart from
 * the search that uses them and can be tested without one.
 *
 * The unit throughout is *score value*: a smooth, bounded [-1, 1] reading of a
 * score difference, always from White's point of view. A search that ranked
 * moves by raw points would chase a hundredth of a point in a won game as hard
 * as a point in a close one; the arctangent flattens that out.
 *
 * These are transcriptions. Not one number here is ours to tune: every one of
 * them was fixed when the reference runs in `experiments/out/` were recorded,
 * and changing any of them changes what a point of loss means
 * (`docs/design-ai-scoring.md` §4.3).
 */

const TWO_OVER_PI = 0.63661977236758134308;

/**
 * The unscaled utility of a score difference, from White's point of view.
 *
 * Upstream: `whiteScoreValueOfScoreSmoothNoDrawAdjust`.
 */
export function scoreValueOfScore(
  whiteMinusBlack: number,
  center: number,
  scale: number,
  sqrtBoardArea: number,
): number {
  return Math.atan((whiteMinusBlack - center) / (scale * sqrtBoardArea)) * TWO_OVER_PI;
}

/**
 * Standard deviation of the score, given its mean and mean square.
 *
 * Upstream: `getScoreStdev`. Negative variance is possible from floating-point
 * noise and is clamped rather than trusted, as upstream does.
 */
export function scoreStdev(scoreMean: number, scoreMeanSq: number): number {
  const variance: number = scoreMeanSq - scoreMean * scoreMean;
  return variance <= 0 ? 0 : Math.sqrt(variance);
}

// Upstream: NNPos::MAX_BOARD_LEN (Board::MAX_LEN, 19 by default) and
// NNPos::EXTRA_SCORE_DISTR_RADIUS. The table is built at 19x19 whatever board
// is actually being searched; `expectedScoreValue` rescales into it.
const TABLE_BOARD_LEN = 19;
const EXTRA_SCORE_DISTR_RADIUS = 60;
const MEAN_RADIUS = TABLE_BOARD_LEN * TABLE_BOARD_LEN + EXTRA_SCORE_DISTR_RADIUS;
const MEAN_LEN = MEAN_RADIUS * 2;
const STDEV_LEN = TABLE_BOARD_LEN * TABLE_BOARD_LEN + EXTRA_SCORE_DISTR_RADIUS;

let expectedTable: Float64Array | null = null;

/**
 * Build the expected-score-value table by numeric integration.
 *
 * Upstream: `ScoreValue::initTables`, step for step — same 1/10-point grid,
 * same five-standard-deviation bound, same unnormalized Gaussian weights. It
 * is ~355k cells over 101 samples each, which is a few hundred milliseconds
 * once per process, so it is built on first use rather than at import: a caller
 * that never searches never pays for it.
 */
function buildTable(): Float64Array {
  const table = new Float64Array(MEAN_LEN * STDEV_LEN);

  const stepsPerUnit = 10;
  const boundStdevs = 5;
  const minStdevSteps = -boundStdevs * stepsPerUnit;
  const maxStdevSteps = boundStdevs * stepsPerUnit;

  const normalPdf = new Float64Array(maxStdevSteps - minStdevSteps + 1);
  for (let i = minStdevSteps; i <= maxStdevSteps; i++) {
    const xInStdevs: number = i / stepsPerUnit;
    normalPdf[i - minStdevSteps] = Math.exp(-0.5 * xInStdevs * xInStdevs);
  }

  const minSvSteps: number =
    -(MEAN_RADIUS * stepsPerUnit + stepsPerUnit / 2 + boundStdevs * STDEV_LEN * stepsPerUnit);
  const maxSvSteps: number = -minSvSteps;
  const svPrecomp = new Float64Array(maxSvSteps - minSvSteps + 1);
  for (let i = minSvSteps; i <= maxSvSteps; i++) {
    svPrecomp[i - minSvSteps] = scoreValueOfScore(i / stepsPerUnit, 0, 1, TABLE_BOARD_LEN);
  }

  for (let meanIdx = 0; meanIdx < MEAN_LEN; meanIdx++) {
    const meanSteps: number = (meanIdx - MEAN_RADIUS) * stepsPerUnit - stepsPerUnit / 2;
    for (let stdevIdx = 0; stdevIdx < STDEV_LEN; stdevIdx++) {
      let weightSum = 0;
      let weightedSvSum = 0;
      for (let i = minStdevSteps; i <= maxStdevSteps; i++) {
        const weight: number = normalPdf[i - minStdevSteps];
        weightSum += weight;
        weightedSvSum += weight * svPrecomp[meanSteps + stdevIdx * i - minSvSteps];
      }
      table[meanIdx * STDEV_LEN + stdevIdx] = weightedSvSum / weightSum;
    }
  }
  return table;
}

/**
 * The expected score value of a roughly normal score distribution.
 *
 * Upstream: `ScoreValue::expectedWhiteScoreValue`, including its bilinear
 * interpolation and its index clamping. The interpolation is part of the
 * answer, not an implementation detail — reading the exact integral instead
 * would disagree with the reference runs in the fourth decimal.
 */
export function expectedScoreValue(
  scoreMean: number,
  stdev: number,
  center: number,
  scale: number,
  sqrtBoardArea: number,
): number {
  const table: Float64Array = expectedTable ?? (expectedTable = buildTable());

  const scaleFactor: number = TABLE_BOARD_LEN / (scale * sqrtBoardArea);
  const meanScaled: number = (scoreMean - center) * scaleFactor;
  const stdevScaled: number = stdev * scaleFactor;

  const meanRounded: number = Math.round(meanScaled);
  const stdevFloored: number = Math.floor(stdevScaled);
  let meanIdx0: number = meanRounded + MEAN_RADIUS;
  let stdevIdx0: number = stdevFloored;
  let meanIdx1: number = meanIdx0 + 1;
  let stdevIdx1: number = stdevIdx0 + 1;

  if (meanIdx0 < 0) {
    meanIdx0 = 0;
    meanIdx1 = 0;
  }
  if (meanIdx1 >= MEAN_LEN) {
    meanIdx0 = MEAN_LEN - 1;
    meanIdx1 = MEAN_LEN - 1;
  }
  if (stdevIdx1 >= STDEV_LEN) {
    stdevIdx0 = STDEV_LEN - 1;
    stdevIdx1 = STDEV_LEN - 1;
  }

  const lambdaMean: number = meanScaled - meanRounded + 0.5;
  const lambdaStdev: number = stdevScaled - stdevFloored;

  const a00: number = table[meanIdx0 * STDEV_LEN + stdevIdx0];
  const a01: number = table[meanIdx0 * STDEV_LEN + stdevIdx1];
  const a10: number = table[meanIdx1 * STDEV_LEN + stdevIdx0];
  const a11: number = table[meanIdx1 * STDEV_LEN + stdevIdx1];

  const b0: number = a00 + lambdaStdev * (a01 - a00);
  const b1: number = a10 + lambdaStdev * (a11 - a10);
  return b0 + lambdaMean * (b1 - b0);
}

// Upstream: VALUE_WEIGHT_DEGREES_OF_FREEDOM in `search.cpp`, and the
// DistributionTable's own bounds and resolution.
const T_DEGREES_OF_FREEDOM = 3;
const CDF_MIN_Z = -50;
const CDF_MAX_Z = 50;
const CDF_SIZE = 2000;

/**
 * The Student-t CDF at three degrees of freedom.
 *
 * Upstream computes this with a general incomplete-beta continued fraction.
 * At exactly ν=3 the CDF has a closed form, so this is a different route to the
 * same number rather than a different number. With x = z/sqrt(3) it is
 * 1/2 + (x/(1+x^2) + atan(x))/pi. `test/score-value.test.ts` checks it against
 * a numeric integration of the density.
 */
function tDistCdf3(z: number): number {
  const x: number = z / Math.sqrt(T_DEGREES_OF_FREEDOM);
  return 0.5 + (x / (1 + x * x) + Math.atan(x)) / Math.PI;
}

let cdfTable: Float64Array | null = null;

function buildCdfTable(): Float64Array {
  const table = new Float64Array(CDF_SIZE);
  for (let i = 0; i < CDF_SIZE; i++) {
    if (i === 0) table[i] = 0;
    else if (i === CDF_SIZE - 1) table[i] = 1;
    else table[i] = tDistCdf3(CDF_MIN_Z + (i * (CDF_MAX_Z - CDF_MIN_Z)) / (CDF_SIZE - 1));
  }
  return table;
}

/**
 * The value-weight CDF, read the way upstream reads it.
 *
 * Upstream: `DistributionTable::getCdf`. The table has 2000 points over
 * [-50, 50] and is linearly interpolated, so this is deliberately *not* the
 * exact CDF: matching the reference runs means matching the interpolation too.
 */
export function valueWeightCdf(z: number): number {
  const table: Float64Array = cdfTable ?? (cdfTable = buildCdfTable());
  const d: number = ((CDF_SIZE - 1) * (z - CDF_MIN_Z)) / (CDF_MAX_Z - CDF_MIN_Z);
  if (d <= 0) return 0;
  const idx: number = Math.floor(d);
  if (idx >= CDF_SIZE - 1) return 1;
  const lambda: number = d - idx;
  return table[idx] + lambda * (table[idx + 1] - table[idx]);
}
