# lituus — Forward-pass parity with KataGo

**Status:** open · one bug found and fixed, one unexplained
**Last updated:** 2026-08-30

Step 4 of [the AI-scoring design](design-ai-scoring.md) §12 builds a forward
pass and has to show it reproduces the network it claims to be running. This
records what has been established, what has been ruled out, and the one
discrepancy still standing — so the next session starts from evidence rather
than from the beginning.

The short version: **the network runs correctly when Black is to play and
incorrectly when White is to play, and the input tensors for both cases have
been verified correct against KataGo's own source.** Those two facts are in
direct contradiction and the contradiction is not yet resolved.

## 1. Why parity matters here

Every accuracy figure in [the feasibility findings](katago-feasibility.md) came
from native KataGo. A browser engine that is fast, plausible, and differently
calibrated would produce point losses that look entirely reasonable while every
threshold in [the PRD](prd-ai-scoring.md) quietly meant something else. This is
the risk §11 of the design doc names first, and this document is the instrument
against it.

## 2. Instruments

Three, in increasing order of directness.

**`experiments/katago/groundtruth.ts`** asks the analysis engine for one visit
with `includePolicy`, writing a committed fixture
(`test/fixtures/net-b15c192.json`). One visit is one forward pass, so a
disagreement is the graph or the planes and not the tree.

**`experiments/katago/verify-forward.ts`** replays that fixture against our
implementation over six positions of the committed professional record.

**`kata-raw-nn` over GTP** is the best of the three and was found late. It
returns the raw network output — policy, `whiteWin`, `whiteLead`,
`whiteScoreSelfplay` — with no search in the path at all, so it removes the
assumption that `rootInfo` at one visit equals the network's own answer.
`experiments/katago/raw-parity.ts` drives it over a move sequence.

**The primary source.** KataGo is cloned at `~/src/katago`;
`cpp/neuralnet/nninputs.cpp`'s `NNInputs::fillRowV7` is the authoritative
specification of the input planes, and `cpp/game/rules.cpp` of what a ruleset
name means. Reading it settled in minutes several questions that black-box
perturbation had left ambiguous for far longer. *Read the source first.*

## 3. Established, by measurement

- **The parser, the graph and the postprocessing are correct.** On an empty
  board our output matches KataGo to 1e-6 on policy and 0.0000 on score lead.
- **Point indexing is correct.** Compared against all eight board symmetries,
  identity wins by a factor of twenty (0.010 against 0.21 or worse). Separately,
  KataGo reports index 72 as illegal for a stone we place at index 72.
- **Every global is correct**, read out of `fillRowV7` rather than inferred.
  `japanese` resolves to `KO_SIMPLE` + `SCORING_TERRITORY` + `TAX_SEKI`
  (`Rules::getSimpleTerritory`), so globals 6, 7, 8 and 11 are zero, 9 and 10
  are one, 12 and 13 are zero outside the encore, and 18 is written only for
  area scoring or the second encore.
- **The pass-alive area planes (18, 19) are correctly omitted.** For territory
  scoring `fillRowV7` writes them only when `encorePhase >= 2`. This is a real
  saving: Benson's algorithm is not on the critical path for the 92% of the
  corpus that is Japanese or Korean.
- **History planes 9-13 and globals 0-4 are correct**, including the nested
  alternation check that stops at the first move breaking the pattern.
- **The V7 encoding has not changed** between v1.13.2 (the binary that produced
  the ground truth) and v1.18.2 (HEAD). Diffed; the edits are refactors of
  history suppression and pass-alive parameters, none reachable from a normal
  mid-game territory position.

### 3.1 A real bug, found and fixed

The liberty map capped its count at **three**, so every group with four or more
liberties was recorded as three and lit the "three liberties" plane. Upstream
caps at four. Nothing raises on a wrong plane — the network simply answers a
different question — and the symptom was exactly this: the empty board matched
to 1e-6 and every position with a stone on it did not.

Fixed in `src/engine/board.ts`, with the reasoning recorded on the constant.

### 3.2 KataGo's own numerical noise

Its OpenCL backend defaults to FP16, and its FP16 and FP32 answers differ by up
to 0.0018 on policy and 0.028 on score lead. Our first comparison charged that
gap to our own account. The ground-truth fixture is now generated with
`openclUseFP16 = false` (`experiments/katago/analysis-fp32.cfg`), and against
FP32 the empty board is exact — our earlier turn-0 error was *precisely*
KataGo's own FP16 delta, 0.001782.

## 4. Ruled out by experiment

Each of these was tested by perturbing the input and measuring; every one made
agreement worse, so each is confirmed correct as written.

| Hypothesis | Result |
| --- | --- |
| Convolution kernel orientation | Cross-correlation as written is best; flip, transpose and vertical flip are all worse |
| Planes 1 and 2 swapped | Far worse (lead Δ 24 against 0.9) |
| Komi sign | Far worse (lead Δ 17.5) |
| History in the wrong plane, or absent | Worse either way |
| Global 14 set | Worse |
| Board flipped or rotated | Identity best of eight by 20x |
| Ladders explaining the one-stone case | Impossible: a lone stone has four liberties and `iterLadders` only considers groups with one or two |
| History explaining it | Ruled out: a stone placed by `initialStones` with *no* move history is equally wrong |

## 5. The discrepancy that remains

Over a five-move sequence, comparing against `kata-raw-nn`:

| Position | policy Δmax | winrate Δ | lead: ours vs theirs | score mean Δ |
| --- | --- | --- | --- | --- |
| 0 stones, B to play | 0.000001 | 0.000000 | −1.626 vs −1.626 | 0.0004 |
| 1 stone, **W to play** | 0.011294 | 0.047100 | 0.651 vs 1.527 | 1.4045 |
| 2 stones, B to play | 0.000003 | 0.000000 | −1.702 vs −1.702 | 0.0002 |
| 3 stones, **W to play** | 0.033402 | 0.051512 | 0.608 vs 1.514 | 1.5015 |
| 4 stones, B to play | 0.000003 | 0.000000 | −1.393 vs −1.393 | 0.0004 |
| 5 stones, **W to play** | 0.009318 | 0.052833 | 0.759 vs 1.715 | 1.6179 |

Exact whenever Black is to play; wrong by roughly nine tenths of a point
whenever White is. Policy, winrate, score lead and score mean are all wrong
together, which means the *input tensor* differs rather than any one output
channel being mishandled.

But the tensors have been dumped and both match `fillRowV7`:

    1 stone, W to play (wrong):   ch0=361  ch2=[72]  ch9=[72]
                                  g5=+0.40 g9=1 g10=1
    2 stones, B to play (exact):  ch0=361  ch1=[72]  ch2=[288]  ch9=[288]  ch10=[72]
                                  g5=−0.40 g9=1 g10=1

Both are what the specification calls for. That is the contradiction.

### 5.1 What this costs on a real game

The same comparison over six positions of the committed professional record,
after the liberty fix, against the FP32 reference:

| Turn | to play | policy Δmax | winrate Δ | lead Δ |
| --- | --- | --- | --- | --- |
| 0 | B | 0.000001 | 0.000106 | 0.0000 |
| 1 | W | 0.010325 | 0.048990 | 0.8789 |
| 40 | B | 0.032411 | 0.028085 | 0.4484 |
| 79 | W | 0.000012 | 0.019003 | 1.0246 |
| 120 | B | 0.011475 | 0.003980 | 0.0917 |
| 199 | W | 0.021101 | 0.000164 | 0.5396 |

Two things to read from this. The worst lead error is **1.02 points**, which is
nowhere near good enough: `BEAT_MARGIN` is half a point and the blunder
threshold is eight, so an error of this size moves verdicts. And the
Black-to-play rows are *not* exact here, unlike the synthetic sequence in §5 —
turn 40 is off by 0.45. Those positions have real groups in them, so the most
likely explanation is the missing ladder planes (§7), which the synthetic
sequence of four isolated stones could never exercise. That is consistent, but
it is inference rather than measurement, and it should be confirmed once the
ladders exist.

**A loose end worth pulling first.** An empty board with *White* to play was
measured exact — but through the analysis engine with `initialPlayer`, not
through `kata-raw-nn`. If that holds under the better instrument, the rule is
not "White is wrong" but "White with at least one stone is wrong", which is a
different and more specific shape. Re-measure it before anything else.

## 6. What has not been tried

- **Compile a dumper against KataGo's own `board.cpp`, `boardhistory.cpp` and
  `nninputs.cpp`** and print the true input tensor for these positions, then
  diff field by field. This is the definitive instrument and removes the last
  place a wrong assumption can hide. It should probably have been step one.
- **Read `nneval.cpp`'s conversion** of the network's player-to-move output into
  `whiteWin` / `whiteLead`, to confirm it is only a sign flip and carries no
  komi or perspective adjustment.
- **A colour-mirror check**: the same position with colours swapped and komi
  negated must give an identical player-to-move answer. If ours does not, the
  fault is ours and is isolated to colour handling.

## 7. Not a cause, but still required

**Ladder planes 14-17 are not implemented.** They cannot explain the one-stone
case, but they are needed for real positions and are the largest remaining port
(`searchIsLadderCaptured` and its helpers, roughly 400 lines). Until they exist,
parity on a real game cannot be claimed even once the colour problem is solved.

## 8. Reproducing

Everything below needs the network, which is git-ignored. The commands are
recorded because the inputs they produce are ignored too, and a cold start
should not have to rediscover them.

    NET=experiments/nets/g170e-b15c192-s1672170752-d466197061.bin.gz

    # The committed ground-truth fixture (FP32, so it measures the network
    # rather than KataGo's FP16 backend).
    node experiments/katago/groundtruth.ts --net $NET       --turns 0,1,40,79,120,199 --config experiments/katago/analysis-fp32.cfg       --out test/fixtures/net-b15c192.json test/fixtures/2024-07-09d.sgf

    # Our forward pass against it.
    node experiments/katago/verify-forward.ts --net $NET       --truth test/fixtures/net-b15c192.json test/fixtures/2024-07-09d.sgf

    # The stronger reference: raw network output, no search in the path.
    node experiments/katago/raw-parity.ts

The AI-scoring fixture `test/fixtures/result-ai.json` comes from a different
chain, over the same record, and is regenerated the same way its inputs were:

    node experiments/katago/analyze.ts --net $NET --visits 50 --label fixture-v50       --out experiments/out/fixture/ref.jsonl test/fixtures/2024-07-09d.sgf
    node experiments/katago/backfill.ts --net $NET --visits 50       --ref experiments/out/fixture/ref.jsonl       --out experiments/out/fixture/backfill.jsonl test/fixtures/2024-07-09d.sgf
    node experiments/katago/guesses.ts --net $NET --visits 50       --play test/fixtures/result.json --ref experiments/out/fixture/ref.jsonl       --out experiments/out/fixture/guesses.jsonl test/fixtures/2024-07-09d.sgf

Those three are joined by `joinRecorded` and driven through the replay
evaluator; `test/fixture-ai.test.ts` pins the figures they produced.

## 9. Method note

Two corrections worth carrying forward, both made by the reader rather than by
the measurement:

- **Go to the primary source before black-box probing.** KataGo is open source
  and its input encoding is a readable function. Several hours of perturbation
  sweeps answered less than twenty minutes of reading `fillRowV7`.
- **Do not re-test what has been settled.** Once `currentSelfKomi` was read and
  shown to be a plain negation, sweeping komi values could only fit noise.
