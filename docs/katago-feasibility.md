# lituus — KataGo Feasibility Findings

**Status:** in progress · accuracy settled, mobile ceiling open
**Last updated:** 2026-08-25

Evidence gathered while deciding how AI scoring should work. Not a design
doc and not a PRD — those come after, and should cite this rather than
restate it. [PoC PRD](prd-proof-of-concept.md) §7 poses the questions; this
records what measurement has answered so far.

Harnesses live in `experiments/katago/` (accuracy) and `experiments/browser/`
(throughput), each with its own README. Networks, corpora, outputs, and the
vendored checkout are all ignored; only the code that produces the numbers is
tracked.

## 1. What was decided before measuring

**Point loss is required for v1.** Policy rank and candidate-set membership
were considered and rejected as insufficient. This is the constraint that
rules out the cheapest designs.

**The evaluator is an interface, not a file format.** Consumers ask
`evaluate(position, moves) → { scoreLead, winrate }`, asynchronously. A local
in-browser engine, a precomputed analysis file, and a remote endpoint are
three implementations of it. An earlier plan made a precomputed sidecar the
spine; that was wrong, for the reason in §2.

**AI scoring is a toggle, not a separate mode.** Once a guess is graded by
point loss, the grader stops caring what the user was aiming at, so
"predict the played move" and "predict the engine's move" collapse into one
exercise. A genuinely distinct mode — hiding the played move and letting the
engine supply the questions — belongs to
[move selection](prd-move-selection.md) §4, not here.

## 2. Live evaluation beats precomputation

Precomputing an analysis has to guess in advance which moves a user might
guess, and pay for all of them. A live engine knows the guess the moment it
is made and pays for nothing else.

It is also **about one search per prompt, not three**. Point loss for both
the guess and the played move comes out of a single root search —
`rootScoreLead − scoreLead(m)` — whenever both moves are among the visited
children. Where the guess is not, the engine is asked directly: KataGo's
analysis engine accepts `allowMoves`, which forces the search onto a named
move and returns a real evaluation of it. Verified — forcing A1 and T19 on
move 5 of an empty board returns −13.40 and −13.11 against a true root of
−0.28.

So coverage, measured in §5, is a cost rather than a limit: it says how often
a second query is needed, not how often a number is unavailable. Note that a search values a position
assuming best play among the moves it was allowed, so a query restricted to
one move treats that move as best and reports no loss for it. The loss is the
unrestricted root estimate minus the forced query's value for the move.

## 3. Network sizes, measured

Published estimates circulate for these and they run low; every figure below
is from the file itself.

| Network | Blocks × channels | Size |
| --- | --- | --- |
| b6c96 | 6 × 96 | 3.8 MB |
| b10c128 | 10 × 128 | 11.1 MB |
| b15c192 | 15 × 192 | 36.9 MB |
| b20c256 | 20 × 256 | 87.4 MB |
| b40c256 | 40 × 256 | 173.5 MB |
| b30c320 | 30 × 320 | 202.7 MB |

The small networks come from the g170 archive, which still publishes sizes
the current run does not.

## 4. Native throughput

200 positions at 100 visits, Apple M1 Pro, OpenCL backend. Sets the budget
for reference runs, and gives the relative network cost that browser
timings can be extrapolated against.

| Network | Time | Relative |
| --- | --- | --- |
| b6c96 | 10.8s | 1.0× |
| b10c128 | 25.5s | 2.4× |
| b15c192 | 47.5s | 4.4× |
| b20c256 | 65.9s | 6.1× |
| b40c256 | 120.8s | 11.2× |
| b30c320 | 146.9s | 13.6× |

b30c320 costs more than b40c256: width matters more than depth, as the
blocks × channels² rule predicts.

## 5. Accuracy

11 games (six 19x19, four 9x9, one 13x13), 3k–7k amateur play, 1571 prompted
positions. Reference is b40c256 at 500 visits. Point loss is measured on the
move actually played, which stands in for a guess — see §9.

**More search does not rescue a smaller network.**

| Network | Visits | Blunders found | False alarms | Same band | median error |
| --- | --- | --- | --- | --- | --- |
| b6c96 | 10 | 17.9% | 46.2% | — | — |
| b6c96 | 25 | 22.7% | 50.0% | — | — |
| b6c96 | 50 | 27.1% | 48.0% | — | — |
| b6c96 | 100 | 28.0% | 41.7% | 73.2% | 0.52 |
| b6c96 | 200 | 32.0% | 44.8% | 73.6% | 0.48 |
| b6c96 | 400 | 36.0% | 51.4% | 74.4% | 0.46 |
| b10c128 | 10 | 28.6% | 23.1% | — | — |
| b10c128 | 25 | 28.6% | 20.0% | — | — |
| b10c128 | 50 | 35.4% | 32.0% | — | — |
| b10c128 | 100 | 38.8% | 36.7% | 81.1% | 0.32 |
| b10c128 | 200 | 46.0% | 34.3% | 82.4% | 0.30 |
| b10c128 | 400 | 46.0% | 34.3% | 80.8% | 0.30 |
| b15c192 | 10 | 29.6% | 11.1% | — | — |
| b15c192 | 25 | 41.0% | 15.8% | — | — |
| b15c192 | 50 | **60.5%** | **10.3%** | 84.9% | 0.28 |
| b15c192 | 100 | 63.0% | 9.4% | 85.5% | 0.26 |
| b15c192 | 200 | 62.5% | 9.1% | 85.7% | 0.24 |
| b15c192 | 400 | 61.2% | 9.1% | 85.5% | 0.22 |

A blunder is a move the reference scores at 8 points or worse.

**The ceiling is network capacity, not search depth.** b10c128 plateaus at
200 visits; b15c192 is saturated at 100. Quadrupling search moves nothing.
b6c96's false alarms get actively *worse* with more search — 42% to 51% —
because more search on a network that cannot read the fight produces more
confident wrong answers, not fewer.

**This is where playing strength and evaluation accuracy come apart.** The
familiar result that network size and visit count trade off interchangeably
holds for strength measured by winning games. It does not hold for judging
big-swing positions, which is what point loss is for. Do not carry that
intuition into a design decision here.

**Aggregates hide all of this.** b6c96's median error of 0.52 points looks
respectable and is dominated by the ~1000 quiet moves. Stratified by the
reference's own band:

| Reference band | b6c96 | b10c128 | b15c192 |
| --- | --- | --- | --- |
| fine (<1pt) | 0.35 | 0.20 | 0.16 |
| slack (1–3) | 1.21 | 0.87 | 0.68 |
| costly (3–8) | 2.83 | 2.05 | 1.46 |
| blunder (>=8) | **10.13** | **7.36** | **4.61** |

Median error, in points, at 100 visits. On the moves that decide games, the
two small networks are wrong by more than the quantity they are measuring.

**False alarms are a property of the network; detection rate is a property of
search.** b15c192 sits at 9–16% false alarms at *every* visit count from 10 to
400, while b6c96 sits at 42–51% at every visit count. Recall moves with
search; trustworthiness does not move at all. The two knobs are independent
and a usable configuration needs both.

**b15c192 at 50 visits is the minimum viable configuration.** The knee is
sharp and sits between 25 and 50 visits — 29.6% → 41.0% → 60.5% — and
everything above 50 is flat. Fifty visits buys 96% of the available accuracy
at half the tree of 100.
The false-alarm rate is what separates it: a tool that misses some blunders
but rarely invents one can be presented honestly as flagging only what it is
confident about. At 35–50% false alarms the user cannot tell which flags to
trust, and the feature is worse than absent.

Extra search does still buy *coverage* — positions where the played move was
never visited fall from 23.8% at 10 visits to 8.1% at 50, 4.8% at 100, and
1.9% at 400. That matters for grading unusual guesses, which is the §2
proviso, but it is a separate axis from accuracy. The cheap end is doubly
bad: it misses blunders *and* frequently has nothing to say at all.

### 5b. The same question asked the way the product asks it

The table above measures the *played* move in an unrestricted search. The
product measures the move the **user guessed**, forced with `allowMoves` so
the whole budget lands on it. Six dogfood games — 576 guesses, every one
forced at both configurations — put the shipping config much closer to the
reference than §5 implies:

| | median \|error\| |
| --- | --- |
| all 576 guesses | 0.60 pt |
| the 55 the reference calls blunders (>=8) | 2.78 pt |

Against 4.61 for b15c192 in the table above. Treating the reference's
blunder calls as truth, the shipping config finds **71% of them at 91%
precision**.

Read this as corroboration, not as a replacement for §5. It is a different
population (guesses, not played moves), a different n, and 55 blunders is
thin — the per-band splits are noise and only the pooled figure is worth
quoting. But the direction is consistent and has an obvious mechanism:
forcing spends 50 visits on one move where an unrestricted search might have
given it three, and §8b already documents the same effect inverting a
detector's apparent recall by rank.

**This matters most for §7.** The mobile ceiling was argued from accuracy
that a forced query may not have. Before concluding what a phone can and
cannot do, re-run §5's table with forcing on both sides.

## 6. Browser throughput

Measured against [web-katrain](https://github.com/Sir-Teo/web-katrain)
(MIT), which parses KataGo's native `.bin.gz` and runs PUCT search on
TensorFlow.js. Not what lituus would ship, but close enough to size the
problem.

**Apple M1 Pro laptop, Chromium, WebGPU**, at 50 visits — the configuration
§5 settles on:

| Network | visits/s | Per prompt | 100-prompt session |
| --- | --- | --- | --- |
| b6c96 | 608.8 | 0.08s | 8s |
| b10c128 | 292.5 | 0.17s | 17s |
| b15c192 | 103.6 | 0.48s | 48s |

b15c192 held 2.9s per round across 40 consecutive rounds — 240 searches, 2.4x
a full session's work with no gaps — with no drift and no crash. Warmup, which
is where the network is actually parsed and uploaded, is 0.3s; the only real
cost of a 37 MB network is the one-time download, which this test served from
localhost and so did not measure.

**On the desktop the viable configuration is cheap.** Half a second per
prompt, off the critical path, against a session that takes half an hour of
human thinking.

**iPhone 14 Pro, Safari 26.6, WebGPU:** b6c96 at 50 visits sustains
**~107 visits/s**, and held that across 40 consecutive rounds — 240 searches,
~112 seconds of unbroken load — with a 4% drift between first and last round.
Thermal throttling is not a concern at this size.

Search overhead is negligible: evals/s ≈ visits/s, so cost is network-bound
and scales with network size roughly as §4 predicts.

In session terms, at one search per prompt, a 100-prompt session needs about
45 seconds of phone GPU time at 50 visits. The work is off the critical path
and lands in the summary, so this is comfortable rather than marginal.

## 7. The mobile ceiling

Larger networks kill the tab outright on iOS — Safari's "a problem
repeatedly occurred", with no exception and no console. Breadcrumbs persisted
to `localStorage` before each boundary survive the kill and locate it:

| Network | Visits | Outcome |
| --- | --- | --- |
| b6c96 | 50 | 40 rounds, stable |
| b10c128 | 50 | died during round 1 |
| b15c192 | 50 | died during round 1 |
| b15c192 | 10 | **completed round 1, died in round 2** |

The 40 MB download itself is fine, and so is loading the network: every run
above reached `warmup-done`, which is a completed 8-visit search. The failure
is in the measured rounds.

**Round 2 does identical work to round 1.** A per-search ceiling would kill
round 1 or neither; dying on the second identical round means memory
accumulates across searches. Lower visit counts postpone the wall rather than
avoiding it.

This is therefore most likely **a property of this engine implementation
rather than of the device or of WebGPU** — `modelV8.ts` makes 85 TensorFlow.js
calls behind 3 `tidy` blocks and 2 `dispose` calls, with no `tf.memory()`
instrumentation anywhere. Unconfirmed: b6c96 survived 240 searches, which an
unbounded leak arguably should not allow, so a high-water mark scaling with
network size × visits is also consistent with the evidence. Distinguishing
them needs `tf.memory()` sampled *inside the worker*, where the tensors live.

The desktop measurement in §6 leans toward a high-water mark: b15c192 at 50
visits ran 240 consecutive searches on a laptop with no drift, where the phone
died within one round of the same configuration. That is what headroom looks
like rather than an unbounded leak — and it means this is a mobile problem
specifically, not something that degrades a desktop session.

Provisionally: **with an off-the-shelf browser KataGo, a phone runs b6c96 and
nothing larger.**

§5 has since resolved the question this was waiting on, and badly: b6c96 is
*not* accurate enough, and no visit count fixes it. The only viable network
is the one that kills the tab, and the low-visit tiers close the last escape
hatch: b15c192 needs 50 visits, and b15c192 at 50 visits was the first
configuration measured to crash. Whether the ceiling is a leak or a genuine
device limit is therefore the single blocker for AI scoring on mobile, rather
than one consideration among several.

## 8. Difficulty is predictable from policy-versus-search

The network's policy proposes a move before any search; the search then judges
it. Where the most natural-looking move turns out to lose, the position
punishes intuition, and humans fall into it.

Measured over the corpus, against the reference's verdict on what the player
actually did:

| Positions | n | Human lost >=3pt | Blundered |
| --- | --- | --- | --- |
| all (baseline) | 1401 | 12.2% | 3.6% |
| natural move costs >=3pt | 34 | 61.8% | 44.1% |
| natural move costs >=1pt | 97 | 45.4% | 19.6% |
| natural move costs <1pt | 1304 | 9.7% | 2.4% |
| best move had prior <0.05 | 33 | 33.3% | 9.1% |

Not circular: the signal is computed from the engine's own policy without
reference to the played move, and the error rate comes from a different
configuration (b40c256@500) than the signal (b15c192@100).

The asymmetry matters. "Looks obvious but is bad" predicts error far better
than "good but hard to find" — amateurs play natural moves, so they are
punished when the natural move is bad, while a merely hidden best move costs
them only when the alternatives are bad too.

Caveats: the strongest bucket is 34 positions, so the effect is clear and its
magnitude is not; and the corpus is a single rank band.

Policy *concentration*, by contrast, is not a difficulty measure — see
[the AI scoring PRD](prd-ai-scoring.md) §5.

## 9. HumanSL

There is exactly one human-imitation network, `b18c384nbt-humanv0`, ~96 MB,
with the imitated rank set at runtime rather than by downloading a different
file. It is used *alongside* a normal network.

That rules it out for the browser — 37 MB + 96 MB of downloads and two
forward passes per evaluation, the expensive one being an 18 × 384 — but it
is attractive wherever a real KataGo runs:

- **Difficulty weighting** ([PoC PRD](prd-proof-of-concept.md) §8.3 asks for
  this, and proposes policy sharpness): "how likely was a player at your
  rank to find this" is what difficulty actually means here.
- **A fair baseline.** "A typical 6k finds this 31% of the time" is a
  second headline that does not compete with point loss, and beats measuring
  an amateur against a superhuman policy.
- **Move selection.** Positions where HumanSL and a strong network disagree
  most are where human instinct diverges from correct play — a better
  criterion than score swing, which merely finds sharp positions.

## 10. Methodology notes worth keeping

Each of these produced, or would have produced, a plausible wrong answer.

**Point loss is measured against `rootInfo`, not the top child.** `order`
ranks children by visits, so a lightly visited sibling can carry a higher and
noisier score lead and make the subtraction come out negative.

**A single forward pass already yields a score estimate.** The value and
score heads are evaluated along with the policy head, so one visit per
candidate gives a usable `scoreLead`. Search buys a *corrected* estimate, not
the only one — which is why the visit grid reaches down to 10.

**Headless browsers fake WebGPU.** Chromium will answer `requestAdapter()`
with a software adapter and return entirely plausible timings that measure
the CPU. The harness runs headed, reports the adapter on every run, and flags
a fallback one.

**WebGPU requires a secure context.** `http://<lan-ip>` is not one — only
`localhost` is exempt — so phone testing needs HTTPS or `navigator.gpu` is
simply absent and TensorFlow.js quietly falls back to CPU. WebGPU does *not*
require cross-origin isolation, so measurements taken behind COOP/COEP
transfer unchanged to a host that cannot set those headers. Only the WASM
fallback path degrades there, losing threading.

**The played move stands in for the user's guess** throughout §5. A real
guess is usually worse, and therefore further down the search's attention
where estimates are noisiest. Every accuracy figure here is optimistic.

**Small networks are reported weakest in large capturing races and
whole-board fights** — exactly where point loss is largest and most worth
teaching. An aggregate dominated by quiet moves would hide that, so
`compare.ts` also reports error stratified by the reference's own band.

## 11. Open

- Whether §7's ceiling is a leak or a high-water mark. **This is now the
  critical path for mobile**, since §5 rules out the networks that fit.
- Nothing further on accuracy. The grid is complete: 15 configurations
  against a common reference.
- Where analysis comes from for a game nobody has analyzed — the producer
  story. Reviewing a game first spoils it, so any local path must be
  headless, one-shot, and unread.
