/**
 * The search's constants, and where each of them came from.
 *
 * **None of these are ours.** Every one is a KataGo default, and changing any
 * of them changes what a point of loss means relative to the corpus the PRD's
 * thresholds were calibrated against (`docs/design-ai-scoring.md` §4.3). They
 * are copied with their upstream names intact so that a future reader can tell
 * a transcription from a decision.
 *
 * **Where the defaults live, which is not where it looks.** `SearchParams()` in
 * `cpp/search/searchparams.h` is a set of deliberately conservative values kept
 * fixed to preserve old test behaviour; it is *not* what the analysis engine
 * runs. `cpp/command/analysis.cpp` calls
 * `Setup::loadSingleParams(cfg, SETUP_FOR_ANALYSIS, ...)`, and `setup.cpp`
 * supplies its own default for every key the config file leaves unset. The
 * configs that produced `experiments/out/` set only threading and FP32 flags,
 * so everything below is `setup.cpp`'s answer, not the header's. Reading the
 * header instead would have produced a plausible search calibrated against
 * nothing — the §11 risk arriving through a door the design doc did not name.
 *
 * Line references are to `cpp/program/setup.cpp` at tag **v1.13.2**, the
 * version of KataGo that recorded `experiments/out/`. That is worth stating
 * because a checkout is easy to read at the wrong tag: every value below was
 * diffed between v1.13.2 and v1.18.2 and none of them changed, but the line
 * numbers moved by about eighty, and so did those of `searchresults.cpp`.
 *
 * The search functions themselves were diffed the same way. `getExploreScaling`,
 * `getExploreSelectionValueOfChild`, `getFpuValueForChildrenAssumeVisited`,
 * `getReducedPlaySelectionWeight`, `addLeafValue`, `recomputeNodeStats`,
 * `downweightBadChildrenAndNormalizeWeight`, `pruneNoiseWeight`,
 * `getSelfUtilityLCBAndRadius`, `getPlaySelectionValues` and `AnalysisData`'s
 * ordering are unchanged in substance across the two versions; what differs is
 * the plumbing for the human-SL policy and the eval cache, both of which are
 * off here, and a refactor that passes `sqrtBoardArea` where a `Board&` used to
 * go. So reading the newer sources was safe — but only because it was checked.
 */

/** Utility of winning, on a [-1, 1] win/loss value. setup.cpp: always 1.0. */
export const WIN_LOSS_UTILITY_FACTOR = 1.0;
/** Weight on score utility centred at zero. setup.cpp:432 (header says 0.3). */
export const STATIC_SCORE_UTILITY_FACTOR = 0.1;
/** Weight on score utility centred at the recent estimate. setup.cpp:435 (header says 0.0). */
export const DYNAMIC_SCORE_UTILITY_FACTOR = 0.3;
/** How far towards zero to pull the dynamic centre. setup.cpp:445. */
export const DYNAMIC_SCORE_CENTER_ZERO_WEIGHT = 0.2;
/** Width of the dynamic score utility, in board-lengths. setup.cpp:448. */
export const DYNAMIC_SCORE_CENTER_SCALE = 0.75;
/** Utility of a no-result game for White. setup.cpp:438. */
export const NO_RESULT_UTILITY_FOR_WHITE = 0.0;

/**
 * The widest utility can swing, used as the loss value for FPU and as the LCB's
 * prior. Upstream computes it inline in several places as the sum of the three
 * utility factors; naming it once keeps them from drifting apart.
 */
export const UTILITY_RANGE_RADIUS =
  WIN_LOSS_UTILITY_FACTOR + STATIC_SCORE_UTILITY_FACTOR + DYNAMIC_SCORE_UTILITY_FACTOR;

/** PUCT exploration constant. setup.cpp:452. */
export const CPUCT_EXPLORATION = 1.0;
/** Log-scaling term on exploration. setup.cpp:455 (header says 0.0). */
export const CPUCT_EXPLORATION_LOG = 0.45;
/** Visit count at which the log term starts to bite. setup.cpp:458. */
export const CPUCT_EXPLORATION_BASE = 500.0;

/**
 * Dynamic cPUCT: exploration scales with how uncertain the parent's utility is.
 *
 * setup.cpp:462, 465, 468. The header has 0.25 / 1.0 / 0.0, and a scale of zero
 * would switch the whole mechanism off — the single largest difference between
 * the header's defaults and the ones the reference runs used.
 */
export const CPUCT_UTILITY_STDEV_PRIOR = 0.4;
export const CPUCT_UTILITY_STDEV_PRIOR_WEIGHT = 2.0;
export const CPUCT_UTILITY_STDEV_SCALE = 0.85;

/** First-play urgency reduction away from the root. setup.cpp:473. */
export const FPU_REDUCTION_MAX = 0.2;
/** And at the root, where being wrong is more expensive. setup.cpp:556. */
export const ROOT_FPU_REDUCTION_MAX = 0.1;
/** How far to assume an unvisited move is simply lost. setup.cpp:476 and :559. */
export const FPU_LOSS_PROP = 0.0;
export const ROOT_FPU_LOSS_PROP = 0.0;
/**
 * Blend the parent's searched average towards its raw network value in
 * proportion to how much policy mass has been visited. setup.cpp:479 and :483
 * (the header switches this off).
 */
export const FPU_PARENT_WEIGHT_BY_VISITED_POLICY = true;
export const FPU_PARENT_WEIGHT_BY_VISITED_POLICY_POW = 2.0;

/** Downweighting exponent for children with bad values. setup.cpp:497 (header says 0.5). */
export const VALUE_WEIGHT_EXPONENT = 0.25;
/** Prune weight that policy cannot justify. setup.cpp:500 (header says false). */
export const USE_NOISE_PRUNING = true;
/** Utility gap at which noise pruning has its effect. setup.cpp:503. */
export const NOISE_PRUNE_UTILITY_SCALE = 0.15;

/** Lower-confidence-bound move selection. setup.cpp:599, :602, :605. */
export const USE_LCB_FOR_SELECTION = true;
export const LCB_STDEVS = 5.0;
export const MIN_VISIT_PROP_FOR_LCB = 0.15;

/**
 * Degrees of freedom for the value-weight distribution.
 *
 * `VALUE_WEIGHT_DEGREES_OF_FREEDOM` in `search.cpp`, not a config key. Lives
 * with the table it parameterizes, in `score-value.ts`.
 */

/**
 * Tiny constant added under the PUCT square root so the numerator stays
 * positive at zero visits. `TOTALCHILDWEIGHT_PUCT_OFFSET` in
 * `searchexplorehelpers.cpp`.
 */
export const TOTAL_CHILD_WEIGHT_PUCT_OFFSET = 0.01;

/**
 * The selection value given to a move the policy calls illegal, low enough that
 * it can never win. `POLICY_ILLEGAL_SELECTION_VALUE` in `search.h`.
 */
export const POLICY_ILLEGAL_SELECTION_VALUE = -1e50;

/*
 * What this search deliberately does *not* implement, and why each is safe to
 * leave out for the shipping network. The conformance run (§9.1) is what
 * decides whether any of them has to come back.
 *
 * - **Policy optimism** (`setup.cpp:493` sets it to 1.0). Applied only when the
 *   network has 2 or 4 policy output channels (`openclbackend.cpp`, "Handle
 *   modelVersion >= 12 policy optimism"). `g170e-b15c192` has one, so upstream
 *   reads no optimistic head either and the parameter is inert.
 *
 * - **Uncertainty weighting** (`setup.cpp:511` turns it on).
 *   `computeWeightFromNNOutput` returns 1.0 unless
 *   `NNEvaluator::supportsShorttermError()`, which is `modelVersion >= 9`. Our
 *   network is version 8 with four score-value channels and no short-term error
 *   heads, so every leaf weighs exactly 1 in upstream too.
 *
 * - **Graph search** (`setup.cpp:524`) and **subtree value bias**
 *   (`setup.cpp:658`). Both are real and both are deferred, by the reasoning in
 *   `TODO.md`: at fifty visits the tree is shallow enough that transpositions
 *   are rare and most bias entries would hold a single node's own contribution.
 *   Deferring graph search is also what lets edge visits and node visits be the
 *   same number here — upstream's `getChildWeight(edgeVisits, childVisits)`
 *   only ever differs from `weightSum` when a transposition is shared.
 *
 * - **The root ending bonus** (`setup.cpp:614` sets 0.5) and
 *   **rootPruneUselessMoves** (`setup.cpp:617`). The latter fires only after
 *   four consecutive opponent passes, which no prompted position in a real
 *   record reaches. The former needs the ownership map and Benson's pass-alive
 *   algorithm, neither of which exists here; it perturbs which root children
 *   get visits but never a reported `scoreLead` directly, so its effect on a
 *   point loss is second order. This is the deferral most likely to show up in
 *   the endgame rows of the conformance run.
 *
 * - **Root noise, root policy temperature, symmetry sampling, wide root noise,
 *   playout doubling, anti-mirror, pattern bonuses, the eval cache.** All are
 *   off by default for analysis, or set to values that make them identities.
 */
