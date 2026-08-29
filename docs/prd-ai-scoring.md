# lituus — Product Requirements: AI Scoring

**Status:** draft · not started
**Last updated:** 2026-08-25

What an engine adds to a session, and what it is allowed to claim.
[The PoC PRD](prd-proof-of-concept.md) §7 sketched this as the tracked next
step; the sketch is now superseded, because the measurements in
[the feasibility findings](katago-feasibility.md) rule out several of the
options it left open. Evidence lives there and is not repeated here.

## 1. Problem

Exact match asks "did you find the move." It is a good question exactly when
the played move deserves to be found.

That holds for professional records and for engine games. It stops holding
for the games most people most want to study — their own, and their
opponents'. In a 6k game the played move is frequently a mistake, and exact
match then scores the user *down* for failing to reproduce it. The exercise
inverts: predicting well is penalized.

This is the case AI scoring exists to serve, and it determines when the
feature should be recommended rather than merely available.

## 2. Goals

- Tell the user what their guess cost, not merely whether it matched.
- Recognize a guess that beat the played move. For an amateur studying their
  own game this is the single most motivating thing the tool can say.
- Never state an engine judgment the engine cannot support.
- Keep a session that does not want an engine exactly as fast as it is today.

### Non-goals

- Playing an opponent. lituus is a study tool, not a client.
- Replacing exact match. The two coexist; §5 keeps both.
- Analyzing a game the user has not started studying. Nothing is precomputed
  ahead of a session, so there is nothing to peek at.
- Server-side analysis, and anything requiring an account. Out of scope for
  this phase; §10 depends on it and is deferred accordingly.

## 3. The engine

**b15c192 at 50 visits**, running in the browser via WebGPU, evaluating
positions as the session reaches them.

This is not a preference. It is the cheapest configuration the measurements
permit: smaller networks cannot be made trustworthy at any visit count, and
more search buys nothing above 50 visits
([findings](katago-feasibility.md) §5).

One search per prompted position. Point loss for both the played move and
the user's guess comes out of that single search — the engine's estimate of
the position minus its estimate of the move — so the cost is one search per
prompt, not one per move under consideration.

**Analysis never blocks the reveal.** It runs behind the session and lands in
the summary. At roughly half a second per prompt against a session that takes
half an hour of human thinking, it finishes long before the user does.

## 4. Turning it on

**Off by default.** The engine is a 37 MB download. A user who wants to step
through a professional record should not pay for it, and a first visit should
stay as fast as it is today.

**Recommended contextually.** The setup view proposes AI scoring when the
record suggests it would help — when the players' ranks (`BR`, `WR`) are kyu,
or absent. It stays quiet for a professional record, where exact match is
already a fair question. The recommendation is a suggestion next to the
toggle, never a default that changes underneath the user.

**The download overlaps the session.** Because §3 keeps analysis off the
critical path, the session can begin while the network is still arriving; it
only has to be ready before the summary. Progress belongs in the session
view, unobtrusively, with a plain statement if it fails — a failed download
degrades the session to exact-match scoring rather than ending it.

**Once fetched, it is cached.** The cost is paid on first use, not per
session.

## 5. What the summary says

Exact-match hit rate remains the headline. Point loss is a second, subordinate
figure, for a reason that is not merely conservative: a hit rate is a number
the user can verify by eye, and an engine estimate is not.

Per prediction, where the engine has an opinion:

- **Point loss**, in points, for the guess.
- **Whether the guess beat the played move**, when it did.
**Every guess gets a number.** A root search spends its visits on moves worth
considering, so roughly 8% of the time — more often for unusual guesses — it
will never have looked at what the user played. That is not a reason to
report nothing. The engine is asked directly: a second query restricted to
the guessed move, which forces the search to spend its whole budget there and
returns a properly searched evaluation of it.

This is the entire advantage of evaluating live rather than precomputing.
A precomputed analysis has to anticipate which moves a user might guess and
pay for all of them; a live engine already knows, and can simply ask. Any
design that shrugs at an unconsidered guess has quietly reverted to the
precomputed model.

Two details this depends on:

- **The loss has to be computed across both queries.** A search reports the
  value of a position assuming best play *among the moves it was allowed to
  consider*. Restrict a query to a single move and that move is, by
  definition, the best one available — so a loss computed inside that query
  comes out near zero however bad the move actually was.

  Concretely, for A1 played as the fifth move of a game: the unrestricted
  search values the position at −0.28, the restricted search values A1 at
  −13.40, and the loss is the difference — about 13 points. Read the
  restricted query alone and it reports a good move in a losing position.
- **The budget goes to one move.** Allowing several moves lets the search
  distribute visits by value and starve the bad ones, which reproduces the
  original problem at a smaller scale. One forced query per guess.

The cost is a second search on the minority of prompts that need it — a few
percent of the session's engine time, and it buys the guesses most worth
explaining, since a move the engine never considered is usually an
instructive mistake.

Session level: median point loss rather than mean, for the same reason the
existing summary reports median time — one catastrophe should not swallow the
figure. Sum of points lost is also reported, since that is the quantity a
player recognizes from AI review tools.

**Show the engine's continuation, not only its verdict.** Point loss says a
move cost four points; the engine's principal variation says why. Displaying
two or three plies of the follow-up — for the guess and for the played move —
is the difference between a score and an explanation, and it costs nothing:
the line is already in the analysis output.

Two or three plies, and no more. At 50 visits the variations run four to
eight moves and the tail is barely searched. Showing a long line would imply
a confidence the search does not have.

**Difficulty is measurable, but not from how concentrated the policy is.**
The tempting version — a forced position peaks the policy on one point, an
open one spreads it — does not work. Policy concentration is the *engine's*
certainty, and that parts company with human difficulty in both directions: a
peaked position may be an obvious recapture or a tesuji nobody below dan
level would see. Worse, where several moves are near-equivalent, the move
actually played is one of several equals, so naming it is closer to guessing
the player's taste than to reading. A hit there is *noisier*, not
harder-won, and weighting it upward would reward luck. §6.1 is the right
response to that situation: stop asking for the exact point, credit the area.

**What does work is comparing the network's intuition against its reading.**
The policy proposes a move before any search; the search then judges it. Where
the most natural-looking move turns out to lose, the position punishes
intuition — and that is a property of the position, available from the same
search, at no extra cost.

It predicts human error strongly ([findings](katago-feasibility.md) §8).
Across the corpus, players lost three points
or more on 12% of positions and blundered on 3.6%. Restricted to positions
where the most natural move costs three points or more, those rise to **62%
and 44%** — a twelvefold increase in the blunder rate. Where intuition is
sound, they fall below baseline.

The two directions are not equally useful, which is worth knowing before
building on it. "Looks obvious but is bad" predicts error far better than
"good but hard to find" (44% versus 9% blunder rate). The reason is that
amateurs play natural moves: they are punished when the natural move is bad,
whereas a merely hidden best move costs them only if the alternatives are
also bad — which is the first condition again.

Two caveats. The strongest bucket is small — 34 positions out of 1401 — so
the effect is clear but its size is not precisely known. And the corpus is
one rank band; whether the same positions trap a 15k and a 1d equally is
untested. §10 describes the version that would answer that directly, by
modeling what a player at the user's own level would play.

This signal is also the best available answer to what
[move selection](prd-move-selection.md) §3 calls engine selection. Score
swing finds sharp positions; this finds positions that *mislead*, which is a
better definition of a moment worth studying.

**"You beat the professional" needs a threshold.** Differences below roughly
half a point are search noise. The claim is made only when the margin clears
that, and the number of times it happens is worth surfacing on its own.

## 6. Anatomy of a miss

A miss is currently a single fact: the guess was not the move. But misses
differ in kind, and the difference is most of what a player would want to
know. The engine, together with the rules engine already in place, can
classify them.

Reported as a breakdown of the misses, *not* folded into the hit rate. The
hit rate stays a number the user can check by eye; this sits beside it, in
the same spirit as the existing tenuki agreement matrix.

### 6.1 Right area, wrong point

There is a specific and common situation worth detecting: the best moves are
not touching any other stone, and several adjacent points are worth about the
same. A roughly 3x3 region is collectively correct, and playing anywhere in
or around it demonstrates a sound sense of direction, whichever point was
chosen.

This only means anything under those conditions, which is why it is a
detection problem rather than a distance measure. All of the following must
hold:

- **Several near-equivalent moves.** At least two candidates within a small
  margin of the best — a margin, not a rank, since two moves may tie.
- **Tightly clustered.** Those candidates fit inside a small region.
- **Not contact plays.** None of them is adjacent to an existing stone.

The last condition is what makes the rest safe. In a contact fight the exact
point is the whole content of the move and a neighboring point can be a
blunder, so proximity means nothing. Away from stones, in open positions,
proximity is exactly what direction means.

When the conditions hold, a guess inside the cluster or immediately around it
is recorded as right-area. When they do not hold, the position simply is not
one where direction is testable, and no partial credit is available. That
distinction is the point: reporting "you had the right direction" on a
position where direction was not the question would be worse than saying
nothing.

Both thresholds — the value margin and the cluster size — need calibrating
against real games rather than being guessed here, in the same way
`TENUKI_RADIUS` needs revisiting.

### 6.2 Right idea, wrong side

A second family: the guess did the same recognizable thing as a good move,
but chose the wrong one of a small set of ways to do it.

- **Atari from the wrong side.** Where more than one move puts the same group
  in atari, choosing between them is the skill. A guess that ataris the right
  group from the worse side is not a random miss.
- **Extending the wrong way.** Where a group can be extended in more than one
  direction, the same applies.

Both are detected from the rules engine — liberty counts and adjacency, which
`rules.ts` already computes — and the engine supplies only the value
difference that says which choice was better. The stat is a rate with a cost
attached: how often the right idea was executed on the wrong side, and what
it cost on average.

### 6.3 The taxonomy

Together with the tenuki agreement already implemented, a miss can be
reported as one of: right area, wrong side, played elsewhere entirely, or
unclassified. "Of your 63 misses, 18 were the right area and 9 were the right
idea from the wrong side" tells a player what to work on. A bare count of 63
does not.

Unclassified must stay a visible category rather than being forced into the
others. Most misses will land there, and a taxonomy that pretends otherwise
is worse than one that admits its coverage.

## 7. Mobile

An iPhone runs b6c96 and nothing larger; b15c192 crashes the tab
([findings](katago-feasibility.md) §7). So mobile either does without AI
scoring or accepts a network whose judgments are, in the aggregate, poor.

The errors are not symmetric, and the design turns on that. b6c96 flags a
blunder that is not one **42% of the time**, and misses **72%** of the real
ones. But because blunders are rare, its quiet verdicts are right about 97%
of the time. It is far better at noticing that nothing went wrong than at
identifying what did.

**Therefore, on the small network:**

- **It may reassure. It may not accuse.** "Nothing obviously lost here" is
  within its competence. Naming a move a blunder is not.
- **No point-loss numbers.** Coarse bands only. A decimal reads as precision
  the network does not have, and on the moves that matter its median error is
  larger than the loss it is estimating.
- **Large losses are reported as unquantified.** Where the small network
  believes a lot was lost, the honest statement is that something looks wrong
  here and this engine cannot size it — not a figure, and not the word
  blunder.
- **The limitation is stated where the results are**, in the summary itself,
  not buried in settings. Not a dismissible banner; a permanent part of how
  mobile results are presented.

A user on a phone may opt into the full network anyway. It is offered with a
plain statement of what happens — the tab will probably crash — and is not
recommended. Desktop is where accurate scoring lives, and saying so is better
than shipping a mobile experience that quietly misleads.

## 8. Strength settings

**No engine-strength slider for now** — not because one is ruled out, but
because nothing yet justifies it. Accuracy collapses below 50 visits — 63% of
blunders found at 100, 61% at 50, 41% at 25, 30% at 10 — and appears flat
above it. A control over a cliff followed by a plateau would mostly invite
users to choose configurations that are strictly worse.

Hold the plateau lightly. Playing strength really does rise roughly linearly
in log(visits), and the two claims are compatible: what was measured here is
agreement with a reference about a single amateur move, not strength. The
flat stretch rests on four grid points across three doublings, at modest n,
on one corpus that turned out to be a single player plus a bot. The browser
budget caps us near 100–200 visits regardless, so the range in dispute is
narrow — but the rank survey ([design](design-rank-survey.md)) recomputes the
grid per band and gets a free re-check.

Network selection follows the device, per §3 and §7, with a manual override
for anyone who wants to try. That is a capability decision, not a preference.

The setting that *is* meaningful is the rank to compare against, and it
belongs to §10.

## 8b. What the rank survey changed

Measured across six rank bands (see [the rank survey](design-rank-survey.md)
§6c), two results bear directly on this document.

**Evaluating the guess with `allowMoves` is load-bearing, not a nicety.** §6
already requires it, on the grounds that a move the user played deserves an
answer. The survey measures the cost of skipping it. A search reports only the
moves it visited, and the moves it skips are 45% of a beginner's and 7% of a
7-dan's — so a detector that reads only what search reported catches **14%**
of a 20-kyu's blunders. Forcing the evaluation takes that to **82%**, at 90%
precision. No visit count or network choice recovers the difference; only
asking the question does.

With the guess forced, the feature is strongest for the players who need it
most: recall 82% at 25k-20k, falling to the forties and fifties at dan level
where errors are small enough to approach the network's noise floor.

**Confidence has to vary by rank even though the threshold need not.** The
difficulty signal's lift over baseline holds at 3-7x for everyone, so one
`topPolicyLoss` threshold stays defensible. But what it means differs: "the
natural move here is a trap" is right about three times in four for a 5k and
between two and three times in ten for a 7d. Above dan level the threshold
sweep goes flat, so raising the bar does not recover precision either. The
same holds for the blunder call, whose precision runs from 90% at 25k-20k to
56% at 7d+.

The practical consequence is in the copy and the confidence shown, not in the
engine configuration — a cheaper conclusion than the human-imitation net in
§10, and one this survey supports directly rather than by analogy.

## 9. Comparability

**A score carries its engine.** A hit rate is comparable across sessions; a
point-loss figure is comparable only against the same network and visit
count. The same problem already exists for replays and for sampling modes,
and it gets the same treatment: the configuration is recorded with the
result, and any view that puts two results side by side refuses to compare
figures produced by different engines.

This matters most for the desktop/mobile split, which is the case where the
same user, studying the same game, gets numbers that must not be compared.

## 10. Human-like scoring (later)

Everything above measures the user against perfect play. There is a second,
more interesting comparison available: against players of a given rank.

KataGo ships one human-imitation network, `b18c384nbt-humanv0`, with the rank
it imitates set at runtime rather than by downloading a different file. It
runs *alongside* a normal network, which at ~96 MB plus a companion rules it
out of the browser entirely ([findings](katago-feasibility.md) §9). This
section therefore depends on analysis running somewhere other than the
browser, and is deferred until that exists.

What it would buy, roughly in order of appeal:

**Rank estimation.** A human-imitation network gives, for any position, the
distribution of moves a player of rank *r* would choose. lituus already
collects the user's move for a hundred positions. Comparing those against the
distributions at each rank estimates which rank the user's *reading* most
resembles — independent of their playing strength, which also depends on
things a prediction exercise never tests. "Your predictions look like a 4k's"
is a genuinely new measurement, and the one most likely to bring someone
back.

**A fair baseline.** "A typical 6k finds this move 31% of the time — you
found it." This is the comparison an amateur actually wants, and unlike point
loss it is a second headline that does not compete with hit rate for the same
slot.

**Difficulty weighting.** [The PoC PRD](prd-proof-of-concept.md) §8.3 asks
for one and proposes policy sharpness from a strong network. Probability
under the human network at the user's own rank is better: "how likely was
someone at your level to find this" is what difficulty means here, and a
weighted hit rate built on it would be meaningfully fairer than a raw one.

**Move selection.** [Move selection](prd-move-selection.md) §3 wants an
engine-driven mode and proposes score swing. Positions where the human
network and the strong network disagree most are better: that disagreement
*is* the definition of a position where human instinct goes wrong, which is
what a study tool should be asking about. Score swing merely finds sharp
positions, which is not the same thing.

**Playing above your rank.** Where the user's guess matches the strong
network but not the human network at their rank, they found something their
peers would not. That is a rarer and better compliment than a hit.

**The rank slider lives here.** Which rank to be measured against is a real
choice with a real range, unlike engine strength: a 6k might reasonably ask
to be measured against 6k, against 1d, or against professional play. It
should default to the user's own rank where the record supplies it.

## 11. Deferred

**Multiple choice.** Presenting the engine's top candidates and asking which
is best, rather than asking for a point on the board. Attractive on a phone,
where placing a stone precisely is the worst part of the interaction, and it
asks less of the engine — ranking a handful of plausible moves is a weaker
demand than sizing an arbitrary loss. It is a different exercise, though,
recognition rather than recall, and its scores would not be comparable to
free-placement ones. Out of scope for this phase.

**Flashcard export.** The positions a user got wrong, with their guess and
the better move as variations, are already most of a flashcard, and lituus
already exports an annotated SGF in roughly that shape. A separate project of
the author's compiles flashcard SGFs into Anki decks from exactly this
structure — anchor-node metadata in a comment, alternatives as variations —
so the two meet at the file format rather than needing an integration. Out of
scope, but cheap enough when wanted that the export format should avoid
foreclosing it.

## 12. Open

- **Whether mobile can have the good network.** The tab crash is more likely
  an engine implementation problem than a device limit
  ([findings](katago-feasibility.md) §7), and §7 exists only because it is
  unresolved. Settling it could delete most of that section.
- **Which engine actually ships.** The measurements were taken against a
  vendored third-party implementation. Using it directly, adapting it, or
  writing a search against lituus's own rules engine are three different
  answers with different dependency costs — the project currently has no
  runtime dependencies, and that implementation brings TensorFlow.js.
- **Where analysis comes from for anyone wanting better than the browser
  offers**, which §10 also depends on. Reviewing a game first spoils it, so
  any local path must be headless, one-shot, and unread.
- **Whether point loss should ever be shown at reveal** rather than only in
  the summary. §3 keeps it out on latency grounds, but a user who has just
  guessed may want the answer while the position is still in their head.
