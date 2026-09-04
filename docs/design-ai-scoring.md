# lituus — Engineering Design: AI Scoring

**Status:** draft · not started
**Last updated:** 2026-08-30

How the feature described in [the AI scoring PRD](prd-ai-scoring.md) gets
built. Scope is implementation approach, module boundaries, the engine
decision, and testing — not product behavior, which the PRD owns, and not the
measurements, which live in [the feasibility findings](katago-feasibility.md)
and [the rank survey](design-rank-survey.md).

The PoC's [design doc](design-proof-of-concept.md) is closed; this is the
second one. It inherits that document's layering and its rule that anything
invisible on screen gets a test.

## 1. What is actually new

Three things, and it is worth separating them, because only the first is hard:

1. **A KataGo network, evaluated in a browser.** No such thing exists in this
   repo. §4.
2. **Somewhere for late-arriving numbers to live**, given that `Session` is an
   immutable value produced by pure transitions and analysis is neither. §3.
3. **More things for the summary to say.** Ordinary view work on top of a
   richer record, and most of PRD §5 and §6 is arithmetic once the numbers
   exist. §6.

The middle one is the piece that determines whether the other two stay
testable, so it is settled before either.

## 2. Layering

The PoC's stack gains one column, deliberately beside the existing one rather
than inside it:

```
views (landing → setup → session → summary)
  ├── summary  ────────────────┐
  │     └── session            │  summarize(session, analysis)
  │           └── game         │
  │                 └── rules  │
  │                            │
  └── analysis store ──────────┘
        └── evaluator (interface)
              ├── engine evaluator  → worker → KataGo net (TF.js/WebGPU)
              └── replay evaluator  → a recorded JSONL, for tests and dev
```

The dependency edges that matter:

- **`session` does not import the evaluator, or know it exists.** A session
  runs identically with the engine on or off, which is what keeps PRD §2's
  "a session that does not want an engine is exactly as fast as it is today"
  true by construction rather than by care.
- **`summarize` gains a second, optional argument** and returns a `Summary`
  whose AI fields are null without it. Every existing caller — `dev.ts`,
  `main.ts`, the tests — keeps working unchanged.
- **The evaluator is an interface with two implementations from day one.**
  Feasibility §1 already committed to this; the point of building the replay
  one first is that everything above the interface can be finished, reviewed
  and regression-tested before any network is parsed.

### Module sketch

| Module | Responsibility |
| --- | --- |
| `evaluator` | The interface, its request and verdict types, and the queue that drains it. |
| `analysis` | The store: verdicts keyed by position, and the derived statistics (point loss, beat-the-move, PRD §6.4 runs). Pure. |
| `replay-evaluator` | An evaluator backed by a recorded file. Dev and test only. |
| `engine/` | The adapted KataGo: bin parsing, V7 features, the V8 graph, PUCT search. |
| `engine/worker` | The worker entry point. The only file that imports TensorFlow.js on the main thread's behalf. |
| `rank` | `BR`/`WR` strings → a rank number, for PRD §4's contextual recommendation. |

`analysis` is where the interesting testable logic ends up, and it depends on
nothing but `game`, `session` and plain verdict records. That is the point of
the split: PRD §6.4's "neither of you played `Q4` in 26 straight chances" is a
group-by over recorded verdicts, and it should be unit-testable without an
engine anywhere near it.

## 3. Where the numbers live

`Session` cannot hold them. It is documented as an immutable value whose
transitions are pure so that "replaying the same guesses produces the same
session" — the same reasoning that already keeps `elapsedMs` measured by the
caller rather than read from a clock inside `guess()`. A verdict that arrives
four seconds after the guess, or never, breaks that outright.

So analysis is a **second value, held beside the session in `main.ts`**, and
joined to it only when the summary is computed:

```ts
summarize(session: Session, analysis?: Analysis): Summary
```

`Analysis` is a map from a **prompt key** to a verdict. The key is the move
number, which is unique within a game and survives everything the session does
to itself. It deliberately does not include the guess: a replay of the same
game and colour asks about the same positions, so the expensive root searches
are reused and only a changed guess costs anything. That makes PRD §5's
"Same again" nearly free, and it is the reason to key by position rather than
by guess.

A verdict carries what one prompt's searches produced:

```ts
interface Verdict {
  readonly moveNumber: number;
  readonly rootScoreLead: number;
  readonly rootVisits: number;
  readonly best: BestMove;
  readonly played: MoveVerdict | null;
  readonly guessed: MoveVerdict | null;
  readonly natural: NaturalMove | null;
}
```

Three things about that shape were decided by the recorded data rather than in
advance, and are worth stating because each looked different from here:

- **`best` is narrower than a `MoveVerdict`.** Its loss is zero by
  construction, and nothing asks how many visits it got — so it carries a
  point, a score lead and a continuation. The recorded files do not hold more
  than that either.
- **`played` can be null.** Where the search never looked at the played move
  and no repair exists, there is no estimate worth having. That is not a
  failed verdict: the position still carries a best move and a difficulty
  signal, which are what §6.4 and the difficulty breakdown are built from.
- **`guessed` equals `played` on a hit** rather than being null. A hit is still
  a move the engine has an opinion about, and the case the product most wants
  to talk about should not be the one every consumer special-cases.

There is no list of candidates. It was in the first sketch and nothing needs
it: the summary asks about four specific moves — the guess, the played move,
the engine's own, and the one the policy proposed — and carrying the other
ninety-odd would be a per-prompt array kept for no reader.

Everything downstream — point loss, beat-the-move, the PV shown at reveal or
in the summary, the §6.1 cluster test, the §6.4 runs — is a pure function of
`Analysis` plus `Game`. None of it belongs in the evaluator, and none of it
belongs in the views.

**The store is serializable, and that is load-bearing.** `dev.ts` already
rebuilds a session from an exported result and recomputes every number, which
turns a saved result into a regression test. Putting the verdicts in the
export keeps that property: a session played once against the real engine
becomes a permanent fixture for every AI figure on the summary screen.

## 4. The engine

PRD §12 leaves this open — vendor the third-party implementation, adapt it, or
write a search against lituus's own rules engine. The decision is **adapt a
subset**, and the rest of this section is what that subset honestly is,
because the first estimate of it was wrong in an instructive way.

### 4.1 What the measurements were taken against

Everything quantitative in [the feasibility findings](katago-feasibility.md)
§5 and [the rank survey](design-rank-survey.md) §6c was produced by **native
KataGo's search**, not by a browser engine. The browser numbers in §6 are
throughput only — visits per second — and say nothing about whether a
different search arrives at the same score.

This is the central risk of the whole feature, and it is easy to miss because
the two bodies of evidence sit in the same document. A hand-written PUCT
search is a *new engine*: it can be fast, correct, and produce point losses
that do not match the ones every accuracy claim in the PRD rests on. §9.1
exists to catch that.

### 4.2 What comes across

Sizes are the vendored `web-katrain` files, MIT, measured rather than guessed.

| File | Lines | Disposition |
| --- | --- | --- |
| `binModelParser.ts` | 174 | Lift. Pure `.bin` tokenizer, no dependencies. |
| `loadModelV8.ts` | 201 | Lift. Reads the layer descriptors into a plain object. |
| `modelV8.ts` | 567 | Lift. The TF.js graph: trunk, policy head, value head. |
| `evalV8.ts` | 81 | Lift. Logits → win probability and score lead. |
| `scoreValue.ts` | 131 | Lift. The score-utility tables the search needs. |
| `featuresV7Fast.ts` + `positionInputsV7.ts` | 388 | Adapt: board size (§7). |
| `fastBoard.ts`, the feature half | ~1,100 | Adapt. See below. |
| `analyzeMcts.ts` | 2,836 | Rewrite against our own board, keeping the numerics. |
| `worker.ts`, `client.ts` | 1,132 | Replace. Our lifecycle is much smaller (§5). |

**The fastBoard estimate is the correction worth recording.** Proposing this
work, I described `fastBoard.ts` as a rules engine lituus already has in
`rules.ts` and could therefore drop. That is true of about 200 of its 1,427
lines. The rest computes *network inputs*, and has no counterpart here:

- `computeLibertyMap` — planes 3–5, one-two-three liberties.
- `calculateAreaForPla` / `computeAreaMapV7KataGo` (~210 lines) — pass-alive
  territory, Benson's algorithm. Required for the area planes, and for
  Japanese-rules scoring.
- `searchIsLadderCaptured` and its callers (~370 lines) — planes 14–17.

These are not optimizations, they are part of the input specification: get them
wrong and the network is being asked a different question, quietly and with no
error. They come across essentially intact.

`rules.ts` still earns its place — it stays the authority for legality and for
what the user is allowed to click — but the search needs a mutable board with
`playMove`/`undoMove` and an undo snapshot, which `rules.ts` deliberately is
not (it returns new positions). Those ~200 lines come across too, as
`engine/board.ts`, with a test asserting the two agree on the corpus. Two
board representations with one shared conformance test is the honest shape
here; pretending one can serve both roles would slow the search by an order of
magnitude.

Net: roughly **2,600 lines lifted or adapted, plus a search we write**. That is
several times the figure I offered when this route was chosen, and it should be
the number the schedule is built on.

**Afterwards, two dispositions in that table turned out wrong, both in the same
direction.** `scoreValue.ts` and the ladder half of `fastBoard.ts` are marked
lift and adapt, and neither came from web-katrain in the end: both follow
KataGo's C++ directly, because a port is only as good as the parity you can
check it against and the parity work sent us to the primary source every time
(`docs/exploration-forward-pass-parity.md`). The line counts were about right;
the *source* was not. `docs/reuse-notes.md` records file by file which upstream
each one actually followed.

### 4.3 The search

`analyzeMcts.ts` is 2,836 lines because it serves an analysis product:
ownership maps, regions of interest, wide-root noise, tree reuse, progressive
reporting during search, per-move ownership. lituus needs none of that. What it
does need is the part that determines the numbers:

- PUCT selection with KataGo's cPUCT schedule and FPU reduction
  (`cpuctExploration`, `exploreScaling`, `selectEdge`).
- Utility as win/loss plus static and dynamic score utility
  (`computeBlackUtilityFromEval`, and the `scoreValue` tables behind it).
- Noise pruning and the weighted root statistics
  (`pruneNoiseWeight`, `downweightBadChildrenAndNormalizeWeight`,
  `computeWeightedRootStats`).
- Root symmetry sampling.
- PV extraction.

Those constants are not ours to tune. Every one of them is a KataGo default,
and changing one changes what a point of loss means relative to the corpus the
PRD's thresholds were set against. **They get copied with their names intact
and a comment saying where they came from**, so a future reader can tell a
transcription from a decision.

#### 4.3.1 The defaults are not in the header

Written before the transcription and short because of it. `SearchParams()` in
`cpp/search/searchparams.h` reads like the list of KataGo's defaults and is not:
its comment says it is kept mostly fixed over time to preserve the behaviour of
tests. `cpp/command/analysis.cpp` calls
`Setup::loadSingleParams(cfg, SETUP_FOR_ANALYSIS, ...)`, and `setup.cpp`
supplies its own answer for every key the config file leaves unset. The configs
that recorded `experiments/out/` set only threading and FP32 flags, so
`setup.cpp` is where the reference runs' parameters actually came from.

The two disagree on a dozen keys, and on three that the list above does not
mention at all:

| | header | `SETUP_FOR_ANALYSIS` |
| --- | --- | --- |
| `cpuctExplorationLog` | 0.0 | 0.45 |
| `cpuctUtilityStdevScale` / `Prior` / `PriorWeight` | 0 / 0.25 / 1.0 | 0.85 / 0.40 / 2.0 |
| `staticScoreUtilityFactor` | 0.3 | 0.1 |
| `dynamicScoreUtilityFactor` | 0.0 | 0.3 |
| `valueWeightExponent` | 0.5 | 0.25 |
| `useNoisePruning` | false | true |
| `fpuParentWeightByVisitedPolicy` | false | true, pow 2.0 |
| `rootFpuReductionMax` | 0.2 | 0.1 |
| `useLcbForSelection` | false | true, 5.0 stdevs |
| `useGraphSearch` | false | true |
| `subtreeValueBiasFactor` | 0.0 | 0.45 |
| `rootEndingBonusPoints` | 0.0 | 0.5 |

A cPUCT scale of zero switches dynamic exploration off entirely, so reading the
header would have produced a search that behaves plausibly and is calibrated
against nothing. That is §11's risk arriving through a door this section did not
name, and the reason `search-params.ts` cites a file and a line for every value
rather than only a name.

**Read the sources at the tag that made the numbers.** The reference runs used
KataGo v1.13.2; a fresh clone is at v1.18.2. No constant changed between them
and no transcribed function changed in substance — the diffs are human-SL
plumbing, the eval cache, and a refactor passing `sqrtBoardArea` where a
`Board&` used to go — but the line numbers moved by about eighty, and nothing
would have said so.

#### 4.3.2 Two of the frightening defaults are inert on the shipping network

`setup.cpp` also turns on `policyOptimism = 1.0` and `useUncertainty`, which
between them imply an optimistic policy head and per-leaf uncertainty weights.
Neither applies to `g170e-b15c192`, and that is a property of the file rather
than a judgement: it has one policy output channel, and `openclbackend.cpp`
blends in an optimistic head only at two or four; it is model version 8 with
four score-value channels, and `computeWeightFromNNOutput` returns 1.0 unless
`supportsShorttermError()`, which is `modelVersion >= 9`. Upstream reads no
optimistic policy and weights every leaf 1 on this network too.

#### 4.3.3 What is deferred, and what each deferral costs

Graph search, subtree value bias and the root ending bonus are all on by default
and are all left out of the first search, to be decided by §9.1 rather than
guessed at: at fifty visits the tree is shallow, so transpositions are rare and
most bias entries would hold a single node's own contribution. Deferring graph
search buys a real simplification — a child's *edge* visits and its *node*
visits can only differ when two paths share a node, so upstream's
`getChildWeight(edgeVisits, childVisits)` becomes `weightSum` throughout.

The ending bonus is the deferral to watch. It needs the ownership map, which
§4.3 said lituus would not need, and Benson's pass-alive algorithm, which does
not exist here. It never touches a reported `scoreLead` directly — it perturbs
which root children get visits — so its effect on a point loss is second order,
but the endgame is where it bites and the endgame rows of the conformance run
are where it would show.

One further limit is worth stating because it is a silence rather than a
setting: **no node is ever terminal**. Under territory scoring two passes send
KataGo into the encore rather than to a result, and the encore is a large part
of `boardhistory.cpp` with ko rules of its own. At fifty visits from a prompted
position the case is unreachable, which is why it is left unhandled rather than
approximated.

The search is also where the one genuinely new capability goes:

**Forced evaluation of the guess.** PRD §8b and feasibility §5b make this
load-bearing — without it the blunder detector catches 14% of a 20-kyu's
blunders instead of 82%. Native KataGo does it with `allowMoves`, which
`analyzeMcts.ts` does not expose, and the obvious browser substitute is to skip
the mechanism entirely: play the guess, search the resulting position, negate.

**Do not do that.** The two are close but not identical — searching the child
gives the move 50 visits where a root-restricted search gives it about 49 and
backs the value up through the root's utility, and the dynamic score centre is
recomputed at the child. The difference is small and unmeasured, and the whole
point of forcing is that its recall numbers were measured a specific way. A
root child mask is roughly twenty lines — `buildAllowedMovesMask` already
exists in `analyzeMcts.ts` for regions of interest and does most of it — so
**match the measured methodology exactly** and keep the substitution as a
fallback only if the mask proves harder than it looks.

The same section supplies the rule for *when* to force. Per the rank survey's
backfill work, the criterion is a **visit floor, not null-ness**: a one-visit
`scoreLead` is a raw network evaluation wearing the same confidence as a
searched one, and one was out by ten points where fifty-visit moves agreed to
within 0.2. The floor is a constant with that finding recorded next to it.

## 5. Lifecycle

### 5.1 Off the critical path, by construction

PRD §3's guarantee — analysis never blocks the reveal — is not a scheduling
policy to be maintained, it is what §2's layering already gives us. The reveal
is driven by `session`, which has no reference to the evaluator. There is no
code path in which a verdict can delay a reveal, because there is no code path
from one to the other.

That is half of the guarantee, and building the lifecycle found the other half
(§5.4). A session that cannot be delayed by a verdict can still be *redrawn* by
one: the view layer was re-rendering the whole screen on every analysis event,
so the reveal was being interrupted by analysis after all. The structural claim
above is true and was not sufficient. Its second half — **analysis never
redraws a screen** — belongs beside it.

### 5.2 Download, warmup, cache

The worker is spawned when AI scoring is switched on, not before, and it
dynamic-imports TensorFlow.js so an ordinary session never fetches it (§10).
The 37 MB network is fetched into the **Cache API** keyed by network name —
not `localStorage`, which is the wrong size class and the wrong API. Warmup is
0.3s once parsed (feasibility §6), so the cost is entirely the first download.

Four states the session view has to be able to show, unobtrusively: fetching
with progress, warming up, ready, and failed. **Failure degrades rather than
ends** — the session continues and the summary reports exact match only, with
a plain statement of why. This is the same failure the replay evaluator
exercises, so it is testable without breaking a network.

### 5.3 The queue

One search at a time. On each `guess()`, `main.ts` enqueues one job for the
prompt: the unrestricted root search of `move.before`, which yields
`rootScoreLead`, the candidates, the policy the §5-difficulty signal needs, and
a verdict for the played move whenever search visited it above the floor. A
second, forced job is enqueued only when the played move or the guess falls
below that floor — a few percent of prompts for the played move, more for
guesses (PRD §5's ~8%, and much more at weak ranks).

At roughly half a second per search against a user thinking for tens of
seconds, the queue drains continuously and the arithmetic is comfortable. It
does not always finish: a session ended early, or a fast replay of a game
already known, can reach the summary with jobs outstanding. **The summary
renders progressively** — the AI section says how many of the predictions have
verdicts and fills in as they land — rather than blocking on a queue or
silently reporting a median over half the game.

Jobs for prompts already in the store are dropped, which is what makes a same
colour replay nearly free (§3).

### 5.4 What building it found

Everything above survived contact. What follows is what building it added to
the design rather than confirmed in it.

**The bundle split holds, measured rather than intended.** `main` is 42.4 kB
with no TF.js reference and no preload; the worker is 1,059 kB as a chunk of
its own. A session with AI off downloads none of it, which is the same finding
the spike reported (§10b.3) now checked against the real thing.

**WebGPU or nothing.** Pages cannot set COOP/COEP, so there is no
`SharedArrayBuffer`, so `tfjs-backend-wasm` is single-threaded — and a
single-threaded wasm search of a 15-block net delivers its losses well after
the reader has left the summary. No WebGPU degrades to exact match, the same
path as a failed download, which already exists. The wasm fallback is not worth
offering.

**Analysis never redraws a screen.** Analysis events were calling `draw()`,
which is `replaceChildren` on the whole screen, and that one cause produced
three bugs of which exactly one was visible:

1. the board was rebuilt mid-animation, so a stone drop or a reveal beat in
   flight restarted — the artifact that led here;
2. `drawSession` arms the auto-advance timer whenever the phase is `reveal`,
   and `draw()`, unlike `show()`, did not clear the previous one. Download
   progress fires many times a second, so every reveal stacked a pile of timers
   and all of them fired. **This skipped prompts**, and nobody had noticed;
3. on the summary it reset the review cursor, throwing a reader back to the
   final position because a search happened to finish.

So: live regions found by id and written in place — `#engine-status` on the
session, and on the summary `#summary-headline`, `#summary-subhead`,
`#summary-phases`, `#engine-findings` and the strip's cells — with everything else a pure function of its props,
redrawn wholesale. The same repaint serves a second caller: switching the
baseline changes every figure on the screen without changing a verdict, and a
re-render there would throw away the review's cursor exactly as a late search
used to. With a `MutationObserver`
watching an idle session through an entire download: 0 board rebuilds against
2,555 engine-line updates, every one of which used to rebuild the board, and
prompts that advance 1, 3, 5, 7, 9 — one per guess. The one-timer invariant
moved *into* `drawSession` rather than living in `show()`, so it holds whoever
calls.

**§3's cheap replay had to be built, not merely designed.** Keying the store by
position makes a replay nearly free only if the store survives the replay, and
"Same again" was tearing down the engine and dropping every verdict — so a
second run cost exactly what the first did. The worker and the store now
survive a replay of the same record, and `enqueue` skips a move whose existing
verdict already covers this guess: a replay opens at "6 scored", repeated
guesses add no work, and a changed guess adds exactly one job. The *queue* is
still rebuilt per session on purpose, since it remembers every move number it
was ever handed, which is right within a session and wrong across one.

**Degradation is verified by aborting the download**, and the summary that
results is byte-identical to a no-AI one. That exercise paid for itself: a
failed fetch throws a bare `TypeError: Failed to fetch`, which reads to a user
like a bug in the page, so `net-cache.ts` now distinguishes a connection
failure, a non-ok status and an interrupted body, and says something that can
be acted on. `AbortError` is re-thrown rather than reworded.

It also exposed a pre-existing bug that only a live region could show:
`engineFindings` returned null when there was nothing to report, taking
`describeEngine` with it — and that line is the only place on screen naming
the engine behind the point loss, which PRD §9 requires a score to carry. On a
clean game the whole section simply vanished from under the reader as the last
verdicts landed. It now stands with "Nothing stood out" plus the attribution.

**Not done, and known:** root-search reuse inside the worker. A changed guess
on a replay currently re-runs the unrestricted root search as well as the
forced one. §3 promises only that the *store* is keyed by position, and it is,
but the worker could cache a `SearchResult` by move number and make a changed
guess cost just its forced search.

## 6. What the summary gains

Mostly arithmetic over `Analysis`, and mostly not novel. The parts worth
naming as design rather than implementation:

- **Which figure leads is the view's decision, not the data's.** `Summary`
  reports every figure either way; PRD §5 says which one a reader meets first,
  and that has changed once already — the exact-match rate led until the
  agreement counts gave it something to be read against.
- **Totals, not medians, for anything compared with the played move.** On a hit
  the guess *is* the played move, so with half the predictions matching both
  medians are computed mostly over the same entries and their difference is
  damped toward zero by construction; the median of the differences is 0.00
  outright. Phase figures are means for the same reason. The median survives
  where nothing is being subtracted — `timing`, and the session's own
  `medianLoss` — because there one catastrophe should not swallow the figure.

### 6.1 The sign convention, once, for every figure on screen

A loss is **positive-is-worse everywhere inside the code**: it is a difference
between two score leads, and that is the direction the arithmetic runs. Every
figure the reader sees is **negated at the edge**, so that positive is good and
a move that cost six points reads `-6.0`. This is what KataGo, OGS and AI
Sensei all show, and a reader arrives already fluent in it.

The rule, in full:

- **A number on screen is signed and negated.** `signed()` in `summary.ts` is
  the one place the flip happens (`asChange` is its per-move sibling on the
  review board). Nothing else may print a raw `loss`.
- **The unit is dropped from the figure** and named once nearby: `-6.0`, not
  `-6.0 points`, with "points vs the engine's best" under the pair.
- **Prose may carry the direction in a word instead**, and then the magnitude
  is unsigned: "three points worse than the game", "5 guesses cost 8 points or
  more". What prose may *not* do is mix the two — "White gave up -0.02" is a
  double negative that means the opposite of how it reads.
- **A figure that rounds to zero prints as `0`, not `-0.0`.** Negating zero
  gives negative zero and `toFixed` renders it faithfully, so every perfect
  move would otherwise be reported as having lost something.
- **The sign is decided at the printed precision.** A figure that rounds to
  zero must not be handed a minus sign it does not show, which is why `signed`
  takes the number of digits it is about to print.

The convention is easy to break in exactly one way: writing a new figure
straight from `loss` because it happens to read plausibly. Both totals in the
summary headline shipped that way for a day.
- **The PV is a record, not yet a display.** The evaluator returns six plies,
  matching `experiments/katago/analyze.ts`, and they travel into the JSON export
  and the annotated SGF — which are read at leisure and can afford them. No
  screen shows a PV today, at the reveal or in the summary. When one does it is
  truncated to two or three plies, and the truncation belongs in the view rather
  than in the record: six plies on screen would imply a confidence a fifty-visit
  search does not have.
- **PRD §6.4's runs are per colour** and are a group-by over the store. Pure,
  cheap, and the highest-value sentence in the review — build it early, since
  it needs no view work beyond a line of text.
- **§6.1 (right area) and §6.2 (right idea, wrong side) are deferred within
  this phase**, not because they are hard but because both need thresholds
  calibrated against real games rather than guessed, exactly as
  `TENUKI_RADIUS` did. They land after the first end-to-end session produces
  data to calibrate on.

The JSON export and the annotated SGF both grow the same fields. The SGF's
shape is already prototyped: `experiments/katago/review.ts` writes a
playthrough back with guesses as variations and refutations only where a move
cost points and went unpunished, and that wording was iterated against a reader.
Port it rather than re-inventing it.

## 7. Board sizes, rules, komi

The V7 feature code indexes by a single `BOARD_SIZE`, settable but **square**.
lituus reads rectangular `SZ` and studies 9×9 and 13×13 records happily today.

So: **AI scoring is offered for square boards only**, and a rectangular record
gets exact-match scoring with the reason stated where the toggle would be. This
is a real limitation and belongs in the PRD's §12 rather than being discovered
by a user with a 19×15 record.

Komi comes from `KM` and rules from `RU`, with the same ruleset mapping
`analyze.ts` already carries; an absent or unrecognized `RU` falls back the way
that harness does. Handicap positions need no special handling — `move.before`
already has the stones, and the history planes read the last five moves out of
`game.moves`.

## 8. Comparability

PRD §9 requires a score to carry its engine. The `Analysis` value records the
network name, visit count, and backend, and they travel into the JSON export
and the SGF root comment. Any view that puts two results side by side refuses
to compare point-loss figures produced by different configurations.

The same value also records what the engine *failed* to do. `Analysis` carries
an `incidents` list and a `failures` count, written when a prompt is refused or
when the engine is declared dead, and both travel into the export beside the
configuration. Without them a session whose GPU died mid-game exports exactly
like a session left unfinished — losses that are null, with nothing to say
which — and telling the two apart takes forensics on the principal variations.
The list is capped, because a dead engine fails once per queued prompt and all
of those are one event; the count is carried separately for the same reason, so
a truncated list cannot shrink the number it stands for.

This is the third thing needing such a flag, after the replay flag and the
sampling mode, both already noted in `TODO.md` as unbuilt. They are one
mechanism — **the conditions a score was produced under, stored with the
score** — and whichever lands first should be built to hold all three rather
than as a one-off.

## 9. Testing

The PoC design doc's rule applies unchanged: test what is invisible on screen.
A wrong point loss looks exactly like a right one.

### 9.1 Conformance against native KataGo

The one test this feature genuinely needs, and the answer to §4.1.

`experiments/katago/analyze.ts` already emits, for every prompted position in a
corpus game, what a given configuration thought — as JSONL, with the reference
runs committed to `experiments/out/`. The browser engine runs the same
positions at the same network and visit count, and the two are compared the way
`compare.ts` already compares configurations.

The bar is **not** that the searches agree move for move; two PUCT searches with
different floating-point orderings will not. The bar is that the *point losses*
agree closely enough that the PRD's thresholds keep meaning what they were
measured to mean — comparable to the spread §5b measures between the shipping
config and the reference, and much tighter than the eight-point blunder
threshold. A run that drifts is a bug in the transcription of a constant, and
this is the only instrument that will find it.

This needs the browser, so it belongs with `experiments/browser/`, driven by
the Playwright harness that already exists there. It runs headed, for the
reason that harness documents: a headless Chromium will answer
`requestAdapter()` with a software adapter and return plausible timings that
measure the CPU.

"Needs the browser" turned out to be a measurement rather than a preference. A
CPU forward pass of `b15c192` under `@tensorflow/tfjs-backend-cpu` in Node takes
**4.5 seconds**, so a single fifty-visit search is about four minutes and a
two-hundred-position run is over a week. The same search on WebGPU is a couple
of seconds. Node can spot-check one position; it cannot carry this.

Unit-testing the *search* is a separate job and does not want a network at all.
`test/search.test.ts` supplies its own `Network` — a few dozen lines that state
an opinion about a position — which runs in milliseconds and lets a test choose
the position that produces a given answer instead of hunting for one. Writing
those stubs turned up something worth keeping: an evaluator that says "whoever
is to move is ten points ahead" at every node is not an opinion about a position
but a contradiction, and the search correctly reports every move as handing ten
points to the opponent. A stub has to flip with the colour, exactly as the value
head does.

The harness is `experiments/browser/run-conformance.ts`, and it reports the one
figure the bar is actually about: how many verdicts change *band* — fine,
costly, blunder — between the two searches. Two searches disagreeing by a tenth
of a point is expected; one calling a move a blunder that the other calls fine
is a transcription bug. It compares against the committed professional record
and the reference in `experiments/out/fixture/`, so it publishes nothing new
and needs no private game.

#### 9.1.1 What the first run found

Two hundred positions of the committed record, `b15c192` at 50 visits, WebGPU
on an `apple/metal-3` adapter, about 2.3 seconds a position:

| | median | p90 | max |
| --- | --- | --- | --- |
| point loss, \|Δ\| | 0.183 | 1.07 | 4.55 |
| root score lead, \|Δ\| | 0.164 | 0.94 | 2.64 |

The best move agreed on 153 of 200, and 23 verdicts changed band — **none of
them across the eight-point blunder line**. The search is deterministic: single
positions re-run reproduce the full run's figures exactly.

That passes the bar with room, and the yardstick is §5b of the feasibility doc
rather than a number chosen here. §5b measured the spread between the shipping
configuration and the reference at a median of 0.60 points over 576 forced
guesses, and the PRD's thresholds were set knowing it. At 0.183 this
transcription is three times tighter than a disagreement the product already
lives with. Most of the band changes sit on `BEAT_MARGIN`, half a point — finer
than that 0.60 spread — so they are the expected noise rather than findings.

The finding is *where* the error is. Split by whether the reference had to
force the move with `allowMoves`:

| | n | median \|Δ loss\| | p90 | max |
| --- | --- | --- | --- | --- |
| forced | 77 | 0.394 | 1.51 | 4.55 |
| unrestricted root search | 123 | 0.102 | 0.47 | 4.04 |

— while the *root* lead agrees equally well in both groups (0.149 against
0.205). The root search is in good shape; the forced query is where the
divergence lives, on the same fifty-visit budget on both sides. Since forcing is
what §8b's recall numbers were measured with, that is the half worth chasing
first, and it is a much narrower question than the one this run was built to
ask.

**What would answer it**, in the order the questions get cheaper. Our forcing is
a mask on the root's new-child loop in `selectChild`; KataGo's `allowMoves`
fills `avoidMoveUntilByLoc` with depth 1 for every move but the allowed one, and
consults it in `getPlaySelectionValues`' `isOkayRawPolicyMoveAtRoot` and in the
symmetry-duplication path as well — so the first thing to check is whether one
place is doing what upstream does in three. Then the degenerate case: with a
single allowed move the root has one child, and the pruned root value is
`(w·childLead + ownLead) / (w + 1)`, which is worth checking against
`getPrunedNodeValues` directly. And there is a controlled experiment already
recorded — `experiments/out/fixture/guesses.jsonl` is 100 positions forced by
`allowMoves` with the played move as the guess, so the conformance run can be
pointed at forcing alone.

A second pattern is visible and is *not* yet separable from the first: the
disagreement grows through the game, with a median of 0.101, 0.171 and 0.334
over turns 0–59, 60–119 and 120–199. The deferred root ending bonus (§4.3.3)
only acts on near-settled points and would predict exactly this, but so would
the plain fact that endgame positions have wider score distributions — and the
backfilled positions cluster late, so the two splits overlap. Whichever gets
tested first has to control for the other. The cheap separation is to stub the
ending bonus as a pass-only penalty — two thirds of a point of score against a
pass, which needs no ownership map — and see whether the 120–199 rows move.

### 9.2 Unit tests, no engine

Against the replay evaluator and hand-built verdicts:

- Point loss, including the sign conventions, which are the easy thing to get
  backwards and the hard thing to notice.
- Beat-the-played-move, including the half-point threshold PRD §5 requires.
- PRD §6.4 runs: per colour, boundaries, a run that spans an abandoned tail.
- The forcing decision: the visit floor, and that a below-floor verdict is
  never reported as if it were searched.
- Degradation: a summary computed with a partial `Analysis`, and with none.

### 9.3 The corpus check, extended

`engine/board.ts` and `rules.ts` must agree. The existing corpus check already
replays real records move by move; the mutable board joins it, comparing final
positions. A disagreement is a bug in one of the two and finding out which is
time well spent, exactly as it was against kifu.

### 9.4 A saved session as a fixture

A session played against the real engine has its export — verdicts included,
per §3 — committed as a fixture, and `dev.ts` recomputes every AI number from
it. A regression test for the whole of §6 that costs nothing to maintain and
needs no GPU.

**Built, as `test/fixtures/result-ai.json`.** It required no new record: the
repository already carries `result.json`, a real hundred-guess session on Ke
Jie against Ichiriki Ryo, 10th Ing Cup — a published professional game, which
is why it can be committed at all. Running KataGo over that same session's
positions at the shipping configuration, with every guess forced, produces a
fixture with real verdicts and publishes nothing new.

Doing it that way avoided the alternative, which was committing an amateur's
game record to a public repository so that a test could have something to read.
Worth remembering as a pattern: the fixture that needs no new data is usually
sitting in the repository already.

The fixture is deliberately the *wrong* game for the feature. §1 says AI
scoring exists for games where the played move is frequently a mistake, and
against two professionals it nearly always deserves to be found — so the losses
are small, the median is 0.03 points, and there are no standing-missed-move
runs at all. That makes it an excellent regression fixture and a poor
demonstration, and it means §6.4's runs stay covered by hand-built verdicts
rather than by this.

## 10. Build and dependencies

This breaks "no runtime dependencies", and there is no version of the feature
that does not: `@tensorflow/tfjs` plus its WebGPU backend is the only realistic
path to a network forward pass in a browser, and hand-writing WebGPU shaders is
not a proportionate answer. `pako` is avoidable — `DecompressionStream('gzip')`
is available everywhere WebGPU is — and should be avoided.

What keeps the cost contained:

- **The dependency is reachable only from the worker**, via dynamic import. A
  session with AI scoring off downloads no TensorFlow.js, which is what makes
  PRD §4's "a first visit should stay as fast as it is today" true.
- **`README.md` says so.** "No runtime dependencies" is currently a claim in
  tracked, public documentation; it becomes "no runtime dependencies outside
  the optional engine" on the same commit that adds the dependency, not later.
- **`docs/reuse-notes.md` gains the adapted engine**, with its upstream origin
  and every divergence, on the same terms as the vendored parser. Each adapted
  file carries a header naming the upstream file it came from and the commit.

Node 24 runs the tests with no loader, so `engine/` must stay importable
without a bundler for §9.2 and §9.3 to run under `npm test`. In practice that
means the TF.js import lives in `modelV8.ts` and nowhere else, and the pure
pieces — parser, features, board, and the search's arithmetic — import nothing
that needs a DOM.

## 10b. Where the network comes from

Everything measured so far was served from `localhost`. lituus deploys to
GitHub Pages, and the two differ in ways that decide the design rather than
merely complicating it.

**Neither upstream host allows a cross-origin fetch.** Measured 2026-08-30:

| Host | `Access-Control-Allow-Origin` |
| --- | --- |
| `media.katagotraining.org` | absent, including on an `OPTIONS` preflight |
| `katagoarchive.org` | absent |

So a browser on `hyponymous.github.io` cannot fetch a network from either. It
is not a matter of a header we forgot to send; there is no header to send from
our side. This forecloses the arrangement the design would otherwise have
reached for — point the app at the archive and cache the result — and it is
the reason web-katrain has a `fetch:model` build script rather than a runtime
download. **The network must be same-origin.**

**It is fetched at build time, not committed.** The deploy workflow downloads
the network into `dist/` before `upload-pages-artifact` runs, so it is served
same-origin without a 37 MB binary entering git history, where it would be
permanent and would be paid by every clone forever. This costs the workflow a
download per deploy, which is cheap and cacheable.

**The bandwidth ceiling is real and belongs on the record.** GitHub Pages
publishes a soft limit of 100 GB/month and a 1 GB site size. 37 MB per cold
visitor puts the ceiling near 2,700 first-time loads a month. For a study tool
that is comfortable, and it is not a number to discover from a throttling
notice — if lituus ever needs more, the answer is a host of our own with CORS
set, and the evaluator interface means nothing above §2 changes when that
happens. (These are published limits, not something measured here.)

**Do not trust the file extension.** A `.gz` served by a static host may or may
not arrive with `Content-Encoding: gzip`, and the two cases need opposite
handling: if the browser has already inflated it transparently, inflating it
again fails. This is precisely the class of bug that works on `localhost` and
breaks on the real host. The fix is not to guess — **sniff the gzip magic
bytes (`1f 8b`) and decompress only if they are there**. That is correct under
both behaviors and under a host that changes its mind.

**Cross-origin isolation is impossible on Pages**, which cannot set custom
headers at all. No COOP/COEP means no `SharedArrayBuffer`, which means
tfjs-backend-wasm runs single-threaded. Feasibility §10 already established
that WebGPU itself does not need isolation, so the shipping path is unaffected
— but it means **the WASM fallback is not a fallback worth offering**. A device
without WebGPU degrades to exact-match scoring with the reason stated, the same
way a failed download does (§5.2). Offering a crawling WASM path would be worse
than declining.

**The base path is `/lituus/`.** The model URL must be built from
`import.meta.env.BASE_URL`, and the worker constructed as
`new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })` so
Vite rewrites it for the deployed base. Both are ordinary, both are invisible
in `npm run dev`, and both break only in production. That is the PoC design
doc's §4 argument, unchanged: deploy the risky configuration before there is
anything depending on it.

### 10b.1 The deployment spike

The above is why the order in §12 starts at zero. **None of these questions
need the engine**, and all of them are answered by one deployed page:

1. The workflow fetches the network into `dist/`; the site serves it.
2. A `#spike` route — same trick as `#dev`, dev-and-diagnostic only — fetches
   it with progress, sniffs for gzip magic, decompresses, and reports the
   byte length.
3. It parses the header with `binModelParser` and `loadModelV8`, and prints the
   model name, version, block count and channel count. Those two files are 375
   lines and the cleanest lifts in §4.2, so this is real work brought forward
   rather than throwaway scaffolding.
4. It stores the bytes in the Cache API and re-reads them, proving the second
   visit is free.
5. It spawns the module worker, which dynamic-imports TensorFlow.js and reports
   the backend and the WebGPU adapter it actually got.

Deployed, that page settles hosting, CORS, base path, content-encoding, the
Cache API, worker and TF.js bundling under `vite build`, and whether WebGPU is
there on the real origin — on the real host, at a point where the answer is
still cheap. It should be built and deployed **before** step 2 commits to
anything, and it is a day's work rather than a phase.

### 10b.2 What the spike found before it was deployed

Built and run against `vite preview`, which serves the built site under the
real base path. Everything below is measured; the deployed run can only add
to it.

**The content-encoding trap is real, and it fires on the first host we tried.**
`vite preview` serves the `.bin.gz` with `Content-Encoding: gzip` *and* a
`Content-Length` of the compressed size. The browser therefore inflates the
body on the way in: `fetch` yields 39,776,212 bytes where the file on disk is
36,948,927, and the first two bytes are `67 31` — ASCII `g1`, the start of the
model name — rather than gzip's `1f 8b`. A `DecompressionStream` applied on
faith would have thrown, on a static host, with a correct file.

The sniff handles it. Two consequences worth carrying:

- **A size check against the expected byte count cannot be an error.** More
  bytes than the file holds is the legitimate signature of a host that
  inflated it. The spike reports the mismatch and explains it rather than
  failing.
- **Progress can exceed 100%** when `Content-Length` describes the compressed
  body and the bytes arriving are inflated. Cosmetic, but the download
  indicator PRD §4 asks for has to tolerate it.

**The bundle splits the way §10 requires.** `vite build` puts TensorFlow.js
entirely in the worker chunk: the main bundle is 31.9 kB with zero references
to it and no preload, the lazily imported spike page is 10.1 kB, and the worker
is 1.02 MB. A session with AI scoring off downloads none of the engine, and
that is now a measured property rather than an intention.

**Vite rewrites the worker URL for the base path**, so
`new Worker(new URL('./engine/spike-worker.ts', import.meta.url))` resolves to
`/lituus/assets/spike-worker-*.js` in the built output. This is the form to
use; a bare specifier would not have survived.

**`crossOriginIsolated` is false**, as expected, confirming that whatever else
happens the WASM path will be single-threaded (§10b).

**The parser lift is correct.** It reads the real network's header:
`g170-b15c192-s1672170752-d466197061`, model version 8, 22 spatial and 19
global input channels, 15 blocks of 192 channels, with gpool blocks seventh and
twelfth. That is a b15c192, described by our own code.

**WebGPU computes, and correctly.** On an M1 Pro the worker reports adapter
`apple / metal-3` — a real adapter, not the software fallback the browser
harness warns about — running tfjs-core 4.22.0 on the `webgpu` backend, with an
all-ones 19×19×32 convolution returning a checksum of 3,097,600 against an
expected 3,097,600 in 66 ms.

### 10b.3 What the deployed spike found

Deployed to GitHub Pages and driven on the real origin. Every step passes, and
the answer to the open question is the most useful one available: **the two
hosts disagree.**

| | `vite preview` | GitHub Pages |
| --- | --- | --- |
| `content-type` | `application/octet-stream` | `application/gzip` |
| `content-encoding` | `gzip` | absent |
| `content-length` | 36,948,927 (compressed) | 36,948,927 (compressed) |
| bytes delivered | 39,776,212, inflated | 36,948,927, still gzipped |
| first bytes | `67 31` | `1f 8b` |
| decompression | skipped — host did it | `DecompressionStream` runs |

Pages sends no `Content-Encoding` even when the request advertises
`Accept-Encoding: gzip, deflate, br`, so this is the behavior a browser gets
and not an artifact of how the header was checked.

**The sniff is what makes both work**, and neither host is misconfigured. A
build that hardcoded either assumption would have passed its own tests and
broken on the other, which is precisely the failure §10b.1 existed to prevent
and the strongest argument for keeping the check when the real evaluator
replaces the spike.

Everything else on the live origin: `crossOriginIsolated` false as expected,
the Cache API round trip intact at 36,948,927 bytes, the header parsed to
g170-b15c192 version 8 with 15 blocks of 192, and the worker on adapter
`apple / metal-3` returning the convolution's expected checksum in 128 ms.

One incidental measurement worth keeping: the network inflates 36,948,927 →
39,776,212 bytes, a ratio of **1.08x**. Float32 weights barely compress, so
gzip buys about 7% and the bandwidth arithmetic in §10b stands as written —
roughly 37 MB per cold visitor, whichever way it is served.

## 11. Risks

- **A search that is fast, correct, and differently calibrated.** §4.1. The
  numbers would look entirely plausible and every threshold in the PRD would
  quietly mean something else. §9.1 is the only defense and should be built
  before the search is finished, not after. **It was, and it paid**: §9.1.1
  passes the bar overall and still isolated a forced path four times worse than
  the root search, which no amount of looking at plausible point losses would
  have shown. The risk is reduced, not retired — the run judges 200 positions of
  one record.
- **Feature planes are wrong in a way nothing reports.** Area maps and ladders
  are the likely places. A network fed slightly wrong inputs still returns
  confident numbers. §9.1 catches this too, which is most of why it comes
  early. **This one happened, twice**: a liberty map capped at three, and a komi
  that omitted territory scoring's chill. Neither raised anything; both were
  found by diffing against KataGo's own inputs, not by the search behaving
  oddly (`docs/exploration-forward-pass-parity.md`). Area planes are still
  unported and refused at the door rather than approximated.
- **The adaptation is larger than it looks.** This is the PoC design doc's
  renderer risk repeating: `fastBoard.ts` was estimated as "we already have
  that" and is 1,100 lines of things we do not (§4.2). Estimate the remainder
  from measured line counts, not from what a file's name suggests.
- ~~**Everything measured so far was served from `localhost`.**~~ **Retired by
  §10b.3.** It was the right risk: two upstream hosts turned out to be
  unfetchable, and the two hosts we do use disagree about `Content-Encoding`, so
  a build that trusted either would have passed its own tests and broken on the
  other. Base paths and worker bundling behaved as the spike predicted, and §5.4
  found the shipped lifecycle no new hosting surprises.
- **Mobile.** PRD §7 rests on unforced measurements, and feasibility §5b says
  forcing flattered the large network several-fold. §7 of the PRD should not be
  implemented until that table is re-run forced (`TODO.md` has the ticket), and
  the iOS ceiling is separately unresolved. Ship desktop; say plainly what a
  phone gets.
- **Scope creep from PRD §6.** The miss taxonomy is the tempting part and the
  part that needs calibration data that does not exist yet. §6.4 is the
  exception — it needs no thresholds — and is the one to build now.

## 12. Order of work

Each step is usable before the next exists, which is the property that made the
PoC's bottom-up order work.

0. **The deployment spike** (§10b.1): build-time network fetch, a `#spike`
   route that downloads, sniffs, decompresses, parses the header, caches, and
   spawns a TF.js worker — deployed to Pages. Answers every hosting question
   while the answer is still cheap, and brings 375 lines of §4.2 forward.
1. **`analysis` and the evaluator interface**, with the replay evaluator and
   verdicts recorded from `experiments/out/`. No engine, no dependency.
2. **Everything downstream**: `summarize(session, analysis)`, point loss,
   beat-the-move, §6.4 runs, the JSON and SGF exports, the summary view. Fully
   tested against §9.2. At the end of this step the product is finished except
   that the numbers come from a file.
3. **`engine/board.ts`** and the §9.3 corpus check.
4. **Network parsing, features, and the V8 graph** — a single forward pass,
   verified against a recorded policy and value from the native engine on the
   same position. No search yet.
5. **The search**, with §9.1 standing up alongside it.
6. **Lifecycle**: worker, download, cache, progress, degradation.
7. **Setup-view recommendation** (`rank`, PRD §4) and the recorded
   configuration (§8).

Steps 0, 1 and 2 are independent of each other and of the engine. Steps 1 and
2 are worth doing even if the engine slips indefinitely: they make the six
dogfood games' existing verdicts viewable in the product, which is the cheapest
possible check on whether PRD §5's summary is the right summary. Step 0 is
worth doing first regardless, because it is the only step whose failure mode is
discovering in step 6 that the shape of steps 4 and 5 was wrong.

**Where it stands.** Steps 0 through 6 are built, in that order and without
reordering; a session in a browser downloads the network, scores its own
predictions and reports them. What is outstanding is step 7 — rank parsing for
PRD §4's setup recommendation, the one row of §2's module sketch with nothing
behind it — and two follow-ups the earlier steps opened rather than closed: the
forced-path divergence in §9.1.1, and root-search reuse inside the worker
(§5.4). `TODO.md` carries them with their evidence; this section is the plan,
not the ledger.
