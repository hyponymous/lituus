# lituus — Rank Estimation Exploration

**Status:** exploratory · one game per band, conclusions provisional
**Last updated:** 2026-08-30

Whether a playthrough can estimate the player's own rank, and which statistic
would do it. Not a design doc and not a PRD; those come after, and should cite
this rather than restate it. [AI scoring](prd-ai-scoring.md) §5 fixes what the
summary reports today, and §9 constrains what any of it can be compared
against. The corpus and the per-rank machinery come from
[the rank survey design](design-rank-survey.md).

Nothing here is settled enough to build on. The headline result rests on six
games, one per band, all played by the same person, all chosen by the author.
§8 says what would have to be true for any of it to hold.

## 1. What was measured

One dogfooding playthrough per rank band, predicting Black throughout. Each
game was then analyzed three times at the reference configuration (b40c256 @
500 visits): the game's own moves in an unrestricted search, the same moves
forced where the search had spent too few visits to be trusted, and every
guess the player made, forced.

Point loss is measured against the root of the *unrestricted* query in every
case, because a restricted query treats its own move as best and its root is
meaningless. This matters more than it sounds: an earlier pass of this work
preferred the unrestricted figure whenever it was non-null, which silently
kept one-visit estimates that were wrong by ten points and more, concentrated
in the endgame where searches go thin. Every number below uses the forced
figure wherever one exists.

Two quantities per prompt:

- **your loss** — points given up by the move the player guessed.
- **their loss** — points given up by the move the game actually played.
- **Δ** — `your loss − their loss`. Negative means the guess was better.

Δ is only defined on misses. Where the guess matched the played move, the two
are the same move and Δ is zero by construction; including hits pins any
median at exactly zero and destroys the statistic.

## 2. Hit rate does not discriminate

| band | prompts | hit rate |
|---|---|---|
| 25k-20k | 108 | 39.8% |
| 15k-10k | 113 | 34.5% |
| 6k-3k | 101 | 39.6% |
| 1d-3d | 92 | 39.1% |
| 4d-6d | 82 | 39.0% |
| 7d+ | 80 | 36.3% |

Six bands spanning roughly 29 stones, and every hit rate falls between 34.5%
and 39.8%. The *lowest* is the game the player played best by every other
measure. Whatever exact-match agreement measures, it is not the distance
between two players' strength.

This is not an argument against [AI scoring](prd-ai-scoring.md) §5 keeping hit
rate as the headline. That decision rests on verifiability — a user can check
a hit rate by eye and cannot check an engine estimate — and verifiability is
untouched by this. It is an argument that the subordinate figure is carrying
all of the information.

## 3. Point loss on its own does not either

| band | median: you / game | total: you / game | blunders ≥5: you / game |
|---|---|---|---|
| 25k-20k | 1.60 / 3.50 | 359 / 495 | 32 / 43 |
| 15k-10k | 0.20 / 1.03 | 157 / 247 | 10 / 20 |
| 6k-3k | 1.52 / 1.07 | 457 / 334 | 28 / 22 |
| 1d-3d | 0.45 / 0.38 | 142 / 151 | 3 / 3 |
| 4d-6d | 0.33 / -0.00 | 305 / 43 | 18 / 3 |
| 7d+ | 1.03 / 0.19 | 155 / 77 | 9 / 2 |

The player's own median loss is not ordered by opponent strength: 1.60, 0.20,
1.52, 0.45, 0.33, 1.03. It cannot be, because it is a property of the
positions the game presented as much as of the player. A quiet game asks
easier questions than a sharp one, and the difference between two games of
the same rank is larger than the difference between two ranks.

Two specific failure modes make it worse.

### 3.1 One fight can carry a whole game

Totals are routinely dominated by a handful of moves in a single local fight.
Share of the total Δ contributed by the four largest single moves:

| band | total Δ | top-4 share |
|---|---|---|
| 25k-20k | -136 | 37% |
| 15k-10k | -89 | 26% |
| 6k-3k | +123 | 102% |
| 1d-3d | -10 | 272% |
| 4d-6d | +262 | 64% |
| 7d+ | +78 | 45% |

Shares above 100% mean everything outside those four moves nets the other way.
The 1d-3d game reads as level overall — 142 against 151 — on the strength of
one capturing race where the player misread it once and the game misread it
twice; strip five moves and the remainder is 85 against 64 the other way. The
4d-6d game puts 167 of the player's 305 points into four moves between move
141 and move 153, all well searched, none backfilled.

Any summary built on a sum inherits this. Four of six games have it.

### 3.2 A standing missed move inflates everything

Where one move stays best for a player turn after turn and that player never
plays it, every move they *do* play scores as a large loss, over and over.
Longest runs of consecutive same-color turns with an unchanged best move:

| band | color | move | consecutive turns | ever played |
|---|---|---|---|---|
| 6k-3k | B | Q4 | 26 | never |
| 6k-3k | W | P7 | 16 | never |
| 15k-10k | B | R17 | 13 | eventually |
| 25k-20k | B | R18 | 11 | eventually |
| 15k-10k | W | L12 | 8 | never |
| 1d-3d | B | M19 | 8 | eventually |
| 7d+ | W | S12 | 9 | eventually |
| 4d-6d | B | F13 | 5 | eventually |

The runs are per color and the two colors miss *different* moves, sometimes
in overlapping stretches — in the 6k-3k game Black ignored `Q4` for 26 straight
chances while White ignored `P7` for 16. Run length also shortens with
strength, from 26 turns at 3k to 5 at 4d.

This is a coaching opportunity rather than a defect. "Neither of you played
`Q4` for 26 consecutive chances" is better feedback than anything the review
currently emits, and it is a short pass over data already on disk. It is
recorded here because it explains why absolute point loss reads so high in
some games and not others, and why a fixed points-lost threshold will fire
differently across ranks for reasons unrelated to skill.

## 4. Median Δ over misses

Comparing the guess to the played move cancels the position. Both moves face
the same board, so a sharp game raises both losses and leaves the difference
alone. Taking the median rather than the sum discards the single-fight
domination of §3.1 without having to detect it.

| band | Black's rank | misses | median Δ | 95% CI | SE |
|---|---|---|---|---|---|
| 25k-20k | 22k | 65 | -1.30 | [-2.76, -0.60] | 0.55 |
| 15k-10k | 15k | 74 | -0.88 | [-1.57, -0.50] | 0.24 |
| 6k-3k | 3k | 61 | +0.02 | [-0.42, +0.46] | 0.22 |
| 1d-3d | 2d | 56 | +0.29 | [-0.12, +0.68] | 0.29 |
| 4d-6d | 4d | 50 | +1.51 | [+0.09, +4.15] | 0.97 |
| 7d+ | 7d | 51 | +1.25 | [+0.50, +1.78] | 0.27 |

Intervals are 4000-sample bootstraps resampling the misses within each game.

Five bands ordered cleanly. The sixth, analyzed last and the only one whose
position was not known before the shape was proposed, came in **below** the
band beneath it — 1.25 against 1.51, where the trend wants the largest value
of the six. The two intervals overlap almost completely, so this is not
evidence the statistic is broken; it is a direct demonstration that one game
cannot order two bands three stones apart.

Ranks are the `BR`/`WR` recorded on each game rather than band midpoints. The
bands are wide and their midpoints are not what was played.

### 4.1 Against the alternatives

Each statistic regressed on Black's rank, with a per-game bootstrap standard
error converted into stones through that statistic's own slope:

| statistic | R² | SE per game | stones (1 SE) | games for ±1 stone at 95% |
|---|---|---|---|---|
| median Δ | 0.890 | 0.282 | ±3.0 | 34 |
| trimmed median Δ | 0.925 | 0.306 | ±3.5 | 47 |
| better % of misses | 0.821 | 6.28pp | ±4.2 | 69 |
| mean sign of Δ | 0.825 | 0.128 | ±4.3 | 72 |

Trimming the five largest swings gives the **best fit of anything tried**, and
does not improve precision at all: the standard error is unchanged and the
slope flattens, so the same error buys fewer stones. Outlier removal buys
linearity, not resolution. The median already does the robustness work.

Discarding magnitude entirely — counting how often the guess beat the played
move, or averaging the sign — costs both fit and precision. The size of the
difference is carrying real information, not just noise.

## 5. Fitting a rank

Least squares on the six points, with `1k = 0` and `1d = 1` so one step is one
stone either side of the kyu/dan line:

```
median Δ = 0.0955 × rank_index + 0.530     R² = 0.890
```

One stone of strength difference is worth about **0.1 points of median Δ**.
Read as an estimator, `estimate = game_rank − medianΔ / 0.0955`.

The fitted zero crossing is 6.6k. The dogfooder self-reports around 3k with
the caveat that their rank fluctuates in practice and 6k is inside their
range, so the crossing is consistent with their strength without being
evidence for the model. There is no independent measurement of the player's
strength in this data, and by their preference their playing account is
deliberately not joined to it. The calibration constant is therefore unchecked.

## 6. What one game is worth

The per-game standard error of median Δ is 0.22 to 0.97, clustering near 0.28.
At roughly 0.1 points per stone that is **±3 stones at one standard error, ±6
at 95%** — a band, not a rank. Pooling shrinks it by the usual root-N, so
about nine games for ±1 stone at one SE, and 34 for ±1 stone at 95%.

Treat 34 as a floor rather than an estimate. Those bootstraps resample misses
*within* a fixed game, so they capture only sampling noise inside that game.
Between-game variance — the opponent's style, how sharp the game is, the
player's form that day — sits on top of it and cannot be estimated at all from
one game per band.

Precision is not uniform. The standard error is 0.22 and 0.29 for the two
games nearest the player's own strength, against 0.55 and 0.97 at the
extremes. Far from the player's strength the differences are dominated by
large blunders in one direction and the median wobbles; near it they are small
and roughly symmetric.

## 7. Candidate designs

**Per game.** `estimate = game_rank − medianΔ / 0.0955`, reported as a ±6
stone band and never as a number. The game's rank is already known from its
record, so the input is free. The output at this width is worth about as much
as "you are a mid-SDK", which may still be worth showing.

**Pooled over time.** An Elo-style update against a prior rather than a
running mean. The target is not fixed — the dogfooder's own rank fluctuates by
several stones — and a mean averages over drift it should be tracking.

**Adaptive selection.** Choose each next game near the current estimate and
step up or down on the *sign* of median Δ. This is the strongest of the three
and the data points at it directly: it never needs the slope, never needs two
bands to be orderable, and concentrates sampling exactly where §6 shows the
standard error is smallest. It also sidesteps the one number in §5 that is
fitted from six points and unvalidated.

## 8. What would have to be true

In roughly the order these would bite.

**The calibration is one player's.** Every point comes from the same person.
Nothing here separates "this is how median Δ behaves" from "this is how *this
player's* median Δ behaves". A second dogfooder is the cheapest test of the
entire idea, and until one exists §5's constant should be treated as a
description rather than a parameter.

**Between-game variance is unmeasured.** One game per band. The precision
figures in §6 are lower bounds and the true requirement is probably worse.

**The games were chosen by the author.** Six games picked by the same person
who proposed the hypothesis. The corpus holds around 60 per band, so this is
fixable by sampling rather than picking.

**Six points, one reversal.** The 7d+ result already contradicts the ordering.
One more band out of place would be enough to abandon the linear reading
entirely, and the adaptive design in §7 survives that outcome where the other
two do not.

## 9. Reproducing

Everything below comes from `experiments/katago/`, driven by `dogfood.ts`
against exported playthrough JSON. The exports, the corpus, the analysis
outputs and the review SGFs are all git-ignored; only the code is tracked.

The analysis scripts behind §4 through §6 — the bootstraps, the regressions,
the run detector — were written to a scratchpad and are not preserved. They
are a few dozen lines each over the JSONL the harnesses emit, and are cheaper
to rewrite against a real question than to maintain against none.
