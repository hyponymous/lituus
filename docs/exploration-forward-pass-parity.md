# lituus — Forward-pass parity with KataGo

**Status:** **closed** · three bugs found and fixed, parity reached
**Last updated:** 2026-09-01

Step 4 of [the AI-scoring design](design-ai-scoring.md) §12 builds a forward
pass and has to show it reproduces the network it claims to be running. This
records what has been established, what has been ruled out, and the one
discrepancy still standing — so the next session starts from evidence rather
than from the beginning.

The short version: **the forward pass now matches KataGo.** Over six positions
of a professional record, against the raw network with no search in the path:
policy within 2e-6, winrate within 1e-4, score lead within 0.0005 of a point,
for both colours and at every move number.

Three bugs, in the order they were found: the liberty map capped at three
instead of four (§3.1), the ladder planes were not implemented (§7), and the
self-komi omitted territory scoring's **chill** (§5.4). The last one is the
interesting one, and it is why this document is long: it presented as a
White-to-play bug, was not about colour at all, and survived a dozen sound
arguments that each proved it had to be somewhere else.

The method lesson is in §9, and it is short. Four sessions of inference kept
producing contradictions. Twenty minutes of printing the actual tensor ended it.

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

**KataGo's own golden input dumps** are the strongest instrument for the input
side, and were found last. `cpp/tests/results/runOutputTests.txt` is committed
expected output for KataGo's own test suite: for a battery of positions it
prints every input plane as a grid with the board drawn beside it, plus every
global feature. It is a machine-readable specification of `fillRowV7` that
needs no compiler, no GPU and no network to consult.
`experiments/katago/golden-inputs.ts` lifts two of those positions into
`test/fixtures/golden-v7.json`, and `test/golden-v7.test.ts` checks our encoder
against them. This is what §6 wanted a hand-built dumper for; upstream had
already written it.

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

### 3.3 The input planes are right, on both fixtures

Checked against KataGo's golden dumps on two positions — a 19x19 position 145
moves into a professional game with **White** to play, and a 7x7 position with
**Black** to play:

| Planes | Result |
| --- | --- |
| 0 (board), 1, 2 (stones) | exact, both positions |
| 3, 4, 5 (liberties) | exact, both positions |
| 9-13 (move history) | exact, both positions |
| 14, 17 (ladders) | exact, both positions — see §7 |

Planes 15 and 16 are not checked here: they are the ladder search run on the
two previous boards, and a printed position does not record what was captured,
so the earlier boards cannot be recovered from the fixture. `test/ladder.test.ts`
covers them instead.

This matters more for what it eliminates than for what it confirms. Liberties
and history were live suspects, and on a position far richer than the isolated
stones of §5 they are exact — *including with White to play*. Whatever the §5
discrepancy is, it is not the stone, liberty or history encoding, and it is not
something that goes wrong merely because White is to move.

Two smaller things fell out of the same reading:

- `rowGlobal[5] = selfKomi/20.0f` is what the source says, and what we do. The
  komi scale was never wrong.
- `hist.currentSelfKomi` applies a draw-equivalence adjustment we do not
  implement. It moves nothing at 6.5 or 7.5 komi, and would at integer komi.

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
against the FP32 reference, **with ladder planes 14-17 implemented**:

| Turn | to play | policy Δmax | winrate Δ | lead Δ |
| --- | --- | --- | --- | --- |
| 0 | B | 0.000001 | 0.000106 | **0.0000** |
| 1 | W | 0.010325 | 0.048990 | 0.8789 |
| 40 | B | 0.000001 | 0.000103 | **0.0000** |
| 79 | W | 0.000024 | 0.024538 | 1.3443 |
| 120 | B | 0.000001 | 0.000060 | **0.0000** |
| 199 | W | 0.003321 | 0.000273 | 1.1167 |

**Ladders were the whole of the even-turn error.** Before they existed the same
three rows read 0.032411 / 0.4484 (turn 40), 0.011475 / 0.0917 (turn 120) and
were exact only at turn 0. Every one is now exact to 1e-6 in policy and to four
decimals in lead. §7's inference is confirmed by measurement.

The rows are labelled by colour because that is what the harness prints, and at
this point the split was read as a Black/White one. §5.2 shows it is not: Black
moves first, so every even turn here is Black to play and every odd turn is
White, and the variable is the turn.

The worst lead error is **1.34 points**, worse than the 1.02 measured before
ladders. That is not a regression from the ladder work: the even rows that used
to contribute error now contribute none, so the worst case is simply an odd row
that was always this wrong and was previously not the maximum. `BEAT_MARGIN` is
half a point, so this still moves verdicts.

**One row worth keeping in view.** At turn 79 the policy is exact to 2.4e-5
while the winrate is off by 0.025 and the lead by 1.34. A wrong input tensor
should move the policy too, so this looked at the time like evidence that the
encoder was fine and the value and score heads were being read wrong. Turns 1
and 199 do carry policy error, so it was never the whole story, and §5.2's
eliminations have not settled which half is at fault. It remains the one
position where the two halves come apart most sharply, and worth revisiting
once the minimal repro (§6) names a cause.

### 5.2 Colour is not the variable

`experiments/katago/raw-parity-game.ts` replays a real record through
`kata-raw-nn`, and with `--mirror` it replays the same game with **every move's
colour swapped and komi negated**. That is an exact symmetry of Go, and because
the network is shown "player to move" and "opponent" rather than black and
white, it produces a bit-identical input tensor. KataGo must return the same
numbers for a game and its mirror.

It does. And so do the errors:

| Turn | normal | mirrored | lead Δ |
| --- | --- | --- | --- |
| 40 | B to play, exact | W to play, exact | 0.0001 both |
| 79 | W to play, wrong | B to play, wrong | 1.3442 both |
| 120 | B to play, exact | W to play, exact | 0.0005 both |
| 199 | W to play, wrong | B to play, wrong | 1.1164 both |

The error follows the position, not the colour. Black moves first, so in this
record "White to play" is exactly "odd turn number", and the colour reading was
a coincidence of that. Consecutive turns confirm it — 40 through 47 alternate
perfectly, every even turn exact and every odd turn wrong.

(Turn 0 mirrored is not a valid comparison: with no moves to replay, GTP still
has Black to move, so the mirror cannot take effect. That row is an artifact of
the harness.)

**What this rules out, and what it leaves.** The invariant that survives
mirroring is that the player to move is the *second* player — equivalently, an
odd number of stones have been played. Three further eliminations:

- **Komi.** At `--komi 0`, where `currentSelfKomi` is zero for both players and
  global 5 is identical, the alternation persists unchanged. Global 5 was the
  only colour-dependent input, and it is not the cause.
- **The analysis engine.** `kata-raw-nn` is the raw network with no search
  anywhere in the path, and it agrees with the committed fixture to four or five
  decimals. The ground truth is not at fault.
- **Plane 17.** It correlates with the alternation perfectly — a laddered chain
  sits on the board through turns 40-47, and plane 17 lights up exactly when it
  belongs to the opponent of the player to move — but forcing it to zero barely
  moves the numbers (turn 41 lead Δ 0.6632 becomes 0.6842). A correlate, not a
  cause. It is also the reason the alternation is not merely an artifact of the
  ladder work: the same pattern predates ladders entirely.

The rules override was verified applied (`kata-get-rules` reports TERRITORY,
SEKI, SIMPLE), so globals 9 and 10 are right.

This leaves a genuine contradiction. The network cannot see colour or move
number. Every input that could encode either has been checked. Yet the output
alternates.

### 5.3 The minimal repro, and what it narrows

`experiments/katago/minimal-repro.ts` walks a six-move opening against
`kata-raw-nn` on a small network, so the whole comparison runs in a minute and
the positions are small enough to reason about entry by entry.

    stones  to play   policy Δ    winrate Δ   lead Δ    ours / theirs
         0  B         0.000001    0.000068    0.0005    -0.599 / -0.599
         1  W         0.001109    0.014096    0.4027     0.381 /  0.784
         2  B         0.000002    0.000086    0.0002    -0.230 / -0.230
         3  W         0.000472    0.013772    0.3993     0.631 /  1.030
         4  B         0.000001    0.000109    0.0004    -0.459 / -0.459
         5  W         0.001818    0.013383    0.4142     1.283 /  1.697
         6  B         0.000001    0.000094    0.0002     2.363 /  2.363

Three things this pins down.

**The trigger is unequal stone counts.** Not colour (§5.2), and not move number
as such: turn 6 has five history planes exactly as turn 5 does, and is exact.
What separates the exact rows from the wrong ones is that the two players have
the same number of stones on the board. The real game agrees — the plane sums at
turns 40 to 43 run 20/20, 20/21, 21/21, 21/22, and the exact turns are the equal
ones.

**Komi is not a scale factor on the error.** The lead offset is ~0.40 at komi 8,
~0.95 at komi 0 and ~1.06 at komi 16 — not monotonic, so the ~0.40 that looked
like `komi/20` at komi 8 was a coincidence worth catching before it became a
theory.

**The policy is nearly right while the value and score are not.** Policy error
is 1e-6 on exact rows and 1e-3 on wrong ones — small, but a thousand times
larger, so the trunk output genuinely differs. The value and score heads then
disagree far more, which is what one would expect of a head fed by global
pooling. That made the pooling the natural suspect; its constants were checked
against KataGo's and are right (`mean`, `mean·(√area−14)·0.1`, and for the value
head `mean·((√area−14)²·0.01−0.1)`, which is 0.15 at 19x19).

**What did not work.** A perturbation sweep over every global and every spatial
channel at the stone. Nothing collapsed the error: the best single change
improved the lead while making the policy thirteen times worse, and the
untouched baseline had the smallest policy error of any trial. The input is not
one entry away from correct, and the sweep is exactly the instrument that
fabricates a plausible answer here — see §9.

### 5.4 The cause: territory scoring's chill

`experiments/katago/dump-inputs.cpp` links against KataGo's own `board.cpp`,
`boardhistory.cpp`, `rules.cpp` and `nninputs.cpp`, builds a position, calls
`NNInputs::fillRowV7` — the same function the engine calls — and prints the
tensor as JSON. Diffed against ours for one black stone with White to play, it
returned a single line:

    global 5: ours 0.4000000059604645  theirs 0.449999988

0.45 x 20 is 9, not 8. KataGo's self-komi for White was komi **plus one**. From
`boardhistory.cpp`:

```cpp
//Territory scoring - chill 1 point per move in main phase and first encore
if(rules.scoringRule == Rules::SCORING_TERRITORY && encorePhase <= 1 && moveLoc != Board::PASS_LOC && !wasPassForKo) {
  if(movePla == P_BLACK)      whiteBonusScore += 1.0f;
  else if(movePla == P_WHITE) whiteBonusScore -= 1.0f;
}
```

Under territory scoring a stone you place fills your own territory, so it is
worth a point less than the same stone under area scoring. KataGo folds that
into the komi rather than the board: `whiteKomiAdjusted = komi + (black moves -
white moves)`, and the self-komi is that value, negated for Black.

Every measurement in this document follows from it:

| Observation | Why |
| --- | --- |
| Exact when stone counts are level | The chill is zero, so our komi was right |
| Wrong when they are not | Off by exactly one point of komi |
| Looked like "White to play" | Black moves first, so White is to play precisely when Black is a stone ahead |
| Survived colour mirroring | The chill is about move counts, not colour |
| Survived komi 0 | The chill is added regardless of komi |
| Not proportional to komi | It is an addend, not a factor |
| Never caught by the golden fixture | Both fixture positions are Tromp-Taylor — **area** scoring, where there is no chill — and §3.3 does not compare globals anyway |

The asymmetry is the part worth remembering. With komi 8 and Black one stone
ahead, White's self-komi is +9 and Black's is -8. `currentSelfKomi` *is* a plain
negation, exactly as §4 recorded — but of a quantity that already contains the
move-count difference. Reading the negation and concluding "therefore symmetric
in colour" was the false step, and it survived four sessions because it is true
of the function and false of the number.

Fixed in `src/engine/features-v7.ts`, where `movesPlayed` is a **required**
field: a default of zero is right half the time and silently wrong the other
half, which is the failure mode that produced this document.
`test/features-komi.test.ts` pins the numbers, KataGo's own, including the
asymmetric case.

## 6. The hypotheses, and how each ended

Kept as a record of what the search cost, since most of it was spent on ideas
that were reasonable and wrong.

| Hypothesis | Ended by |
| --- | --- |
| Colour handling | Colour mirror, §5.2 — the errors do not move |
| Komi sign or scale | `komi 0` still alternates, §5.2; `/20.0f` verified in source |
| The analysis engine's ground truth | `kata-raw-nn` agrees with it to five decimals, §5.2 |
| The ladder planes | Fixed a real bug (§7) but not this one; the pattern predates them |
| Plane 17 specifically | Correlates perfectly, causes nothing — §5.2 |
| A single wrong tensor entry | Exhaustive perturbation found none, §5.3 |
| Global pooling constants | Checked against KataGo's, correct, §5.3 |
| `nneval.cpp`'s output conversion | Never needed; the fault was upstream of it |
| Compiling a dumper | **This one.** §5.4 |

The dumper was proposed early, struck out in favour of KataGo's committed
golden fixtures, and reinstated last. Striking it was defensible — the fixtures
are excellent for the planes they cover, and they found the ladder gap — but
they cannot produce a tensor for *our* position, and that turned out to be the
whole question.

## 7. Ladders: implemented, and they mattered

**Ladder planes 14-17 are implemented**, in `src/engine/ladder.ts` — a port of
`Board::searchIsLadderCaptured`, `searchIsLadderCapturedAttackerFirst2Libs` and
`iterLadders`, following upstream's move ordering and its 25,000-node budget
rather than improving on them. A cleverer search that finds one more ladder
would be a worse input, not a better one.

They were never a candidate for the one-stone case in §5 — a lone stone has
four liberties and `iterLadders` only looks at groups with one or two — but
they were the entire Black-to-play error on a real game. §5.1 has the numbers:
three Black rows that were off by up to 0.45 points are now exact.

Verified two ways. `test/golden-v7.test.ts` checks planes 14 and 17 against
KataGo's own committed output on both fixture positions. `test/ladder.test.ts`
covers what a single position cannot: that the search takes its moves back,
that reusing its scratch does not change its answers, that a ladder breaker
flips the verdict, and that planes 15 and 16 read the boards they are named for
and fall back to the current board when there is no history, as upstream does.

Cost is 0.15 ms per 19x19 position, three passes per evaluation — negligible
beside a forward pass.

## 8. Reproducing

**The tensor dumper** (§5.4) needs a KataGo checkout and a C++ compiler, and no
network, no GPU and no backend — it compiles only the files `fillRowV7`
transitively needs:

    K=$KATAGO_SRC/cpp          # a KataGo checkout, e.g. ~/src/katago
    c++ -std=c++17 -O1 -I"$K" -I"$K/external/filesystem-1.5.8/include" \
      -o dump-inputs experiments/katago/dump-inputs.cpp \
      "$K"/game/{board,boardhistory,rules}.cpp "$K"/neuralnet/nninputs.cpp \
      "$K"/core/{hash,rand,global,sha2,test,timer,logger,config_parser}.cpp \
      "$K"/core/{fileutils,datetime,makedir,rand_helpers,bsearch}.cpp \
      "$K"/core/{fancymath,base64,md5,threadsafequeue}.cpp -lz

    ./dump-inputs 8 B:Q16      # komi, then the moves

The checkout is v1.18.2 and the binary that produced the ground truth is
v1.13.2; §3 established that the V7 encoding did not change between them.

The golden-input fixture is the other cheap one: it needs only a KataGo
checkout, no network and no binary, and `test/golden-v7.test.ts` runs it as part of
`npm test`. Regenerate it after a KataGo upgrade with

    node experiments/katago/golden-inputs.ts > test/fixtures/golden-v7.json

which reads `$KATAGO_SRC`, defaulting to a checkout in `~/src/katago`.

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

Three lessons, in increasing order of how much they cost.

- **Go to the primary source before black-box probing.** KataGo is open source
  and its input encoding is a readable function. Several hours of perturbation
  sweeps answered less than twenty minutes of reading `fillRowV7`.

- **A perturbation sweep on a deep network fits noise.** Run on the minimal
  repro (§5.3), the best single change improved the score lead while making the
  policy thirteen times worse, and the untouched baseline had the smallest
  policy error of any trial. Had the lead been the only figure watched, that
  would have looked like an answer.

- **Reading a function is not the same as knowing its value.** This is the one
  that cost four sessions. `currentSelfKomi` was read early and correctly
  described as a plain negation, and from that came "the self-komi is symmetric
  in colour", which was false — because the quantity being negated already
  carried the move-count difference. Every later argument inherited it, and each
  contradiction was resolved by discarding a *different* hypothesis rather than
  by questioning the shared premise.

  The corollary to "do not re-test what a source has settled" is that a source
  settles what it says, not what was concluded from it. When a chain of sound
  arguments keeps producing contradictions, the fault is a premise, and the way
  out is to observe the quantity itself rather than reason about it once more.
  `dump-inputs.cpp` cost about twenty minutes to build and answered in one line.
