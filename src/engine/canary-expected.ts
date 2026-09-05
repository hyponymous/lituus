/**
 * What the canary's fixed input evaluates to on a device that is known to be
 * right — the load-time check that a device is computing this network the way
 * KataGo does, rather than merely computing it consistently.
 *
 * The distinction is the whole reason this file exists. `canary.ts` compares a
 * device with itself, which catches a GPU that goes wrong mid-session and
 * cannot catch one that was wrong before the first prompt. A phone did exactly
 * that: two sessions, two games, three days apart, produced bit-identical
 * numbers that were tens of points from the laptop's on the same build, right
 * from the empty board. Its drift was zero throughout.
 *
 * **Regenerate when `network.ts` changes.** These numbers are that network's
 * answer to that input and nothing else. `node experiments/browser/run-readback.ts`
 * prints the line to paste, and it must be run on a machine that has been shown
 * to agree with native KataGo — `experiments/katago/verify-forward.ts` is the
 * evidence, not the fact that the numbers look reasonable.
 */

/** Where these came from, quoted back to a reader comparing two devices. */
export const EXPECTED_ON = 'apple / metal-3, desktop (agrees with native KataGo to 1e-6)';

/** The board the input was built for. A different size is a different answer. */
export const EXPECTED_SIZE = 19;

/** `[win, loss, noResult, scoreMean, scoreStdev, lead, varTimeLeft, pass, policy sum]`. */
export const EXPECTED_HEADS: readonly number[] = [
  -1.69810569, 3.41083264, -0.0730214119, 2.6584487, 2.41927123, 1.90921175, -0.440561831,
  -2.98387194, -9373.55078,
];

/**
 * How far another device may land from those before its numbers are refused.
 *
 * Provisional, and deliberately loose. The reference machine reproduces its own
 * answer to the digit — drift exactly zero over hundreds of passes — and two
 * correct GPUs running the same graph should differ by float noise, of the
 * order of 1e-5 relative through fifteen residual blocks. The failure this
 * catches is nothing like that: it moves the policy's argmax and the score lead
 * by tens of points. A hundredth sits far above the noise and far below the
 * fault, which is the only place a threshold can honestly sit until a second
 * known-good device has been measured.
 */
export const EXPECTED_TOLERANCE = 1e-2;
