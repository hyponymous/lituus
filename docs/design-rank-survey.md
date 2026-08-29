# lituus — Engineering Design: Rank Survey

**Status:** open · corpus collected, survey run, analysis outstanding
**Last updated:** 2026-08-29

How to measure whether the cheap AI-scoring signals hold across playing
strengths. Findings so far live in
[the KataGo feasibility notes](katago-feasibility.md); the product decisions
they feed live in [the AI scoring PRD](prd-ai-scoring.md).

## 1. What this answers

1. **Does one `topPolicyLoss` threshold work at every rank?** The difficulty
   signal (feasibility §8) was measured on a single corpus. If weak and strong
   players fall into different traps, a fixed threshold is wrong.
2. **Does blunder detection hold where blunders are bigger?** b15c192 @ 50
   visits was characterized against 3k–7k play. Weaker play may be *easier*
   to judge — larger errors sit further from the noise floor.
3. **What does point loss look like per rank?** The calibration behind any
   "that cost you three points" copy, and the input to a rank-comparison
   control ([PRD](prd-ai-scoring.md) §8).

There is a mechanism behind (1) worth stating up front, because the design is
built to detect it: `topPolicyLoss` predicts amateur error because amateurs
*play policy* — the natural-looking move is their move. Stronger players have
largely stopped doing that, so the trap fires and they step around it.
Meanwhile their blunders get rarer and smaller, so detection gets harder and
false alarms cost relatively more. If that is right, the signal decays with
rank from both ends at once.

## 2. Bands

| Band | Source | Notes |
| --- | --- | --- |
| 25k–20k | OGS | handicap and unfinished games are the hazard here |
| 15k–10k | OGS | |
| 6k–3k | OGS | |
| 1d–3d | OGS | |
| 4d–6d | OGS | |
| 7d+ | KGS or Fox, if OGS is too thin | |

Kept as six bands rather than merged into "kyu / dan" because the expected
effect is a gradient; merging averages away the thing being looked for. The
dan side is split three ways because that is where the signal is expected to
decay, and one "dan" bucket would hide the shape of the decay.

**Rank systems are not comparable across servers.** Fox ranks in particular
inflate. Record the server per game, and prefer one server per band.

### The existing corpus is a control, not a band

The eleven games measured so far are mostly one player's own games, and seven
of eleven have a `Humanlike-bot` as one side — with both colors prompted,
roughly a third of those 1571 positions are bot moves. That corpus is
retained and relabeled as a personal n=1 control. It answers "does the signal
predict *this* player's errors", which is a real question, and it gives a free
comparison once the 6k–3k band exists: does the population match the
individual?

## 3. Corpus acquisition

### The API, as it actually is

`/api/v1/games/` (the global list) returns 404 — discovery cannot start there.
These work, unauthenticated:

    /api/v1/games/<id>                     metadata, incl. historical_ratings
    /api/v1/games/<id>/sgf                 the record
    /api/v1/players/<id>/games/?...        filterable, paginated

The player games list accepts `width` and `ranked`, which does most of the
filtering server-side.

Anonymous access is fine but throttled under load. Hold to roughly one request
per second, no parallelism, and back off on 429.

Two traps worth recording. The SGF endpoint answers **406** to a request that
asks for `application/json`, which fails silently as "no games found" if the
fetcher sends one `Accept` header for everything. And a crawl at one request
per second is silent for minutes at a time unless progress is reported from
where the work happens — per game kept, plus a tally of why the rest were
passed over, rather than after a whole player expansion returns.

### Discovery: seeded snowball

1. **Seed** by sampling random game IDs (currently dense from 1 to somewhere
   between 90M and 95M) and harvesting their *players*, not the games. Under
   3% of random games are an unhandicapped ranked 19x19 game between two
   bot-free accounts in one narrow band — most draws are 9x9, handicapped, or
   against a bot — but a player near the band is common, and every player
   leads to a filtered list of their own games.
2. **Expand** through `/players/<id>/games/?width=19&ranked=true`. For a
   player genuinely in band this is highly productive: 41 of 50 admissible in
   the first one measured.
3. **Follow** every in-band player met along the way, including through games
   that are themselves unusable. Without this the walk has no way back toward
   the band, and a run of handicap games or bot opponents ends the crawl.

The seed margin — how far outside the band a seed player may sit — is kept
tight. OGS matches by rank, so a player far from the band plays opponents who
are also far from it, and expanding them burns requests without ever
producing a game.

Snowballing concentrates on a few players, which is the exact bias the
existing corpus already suffers from. Bounded by:

- at most **3 games per player** and 1 per player *pair*
- at least **20 distinct players** per band
- both players in band, independently checked

### Band assignment

From `historical_ratings` — the rating at the time the game was played, not
the player's rating today. OGS rank number is

    r = ln(rating / 525) * 23.15

with displayed kyu `K` for `r ∈ [30-K, 31-K)` and dan `D` for
`r ∈ [29+D, 30+D)` — 1d starts at 30. The fetcher cross-checks its assignment
against the `BR[]`/`WR[]` strings in the downloaded SGF and reports
disagreements. **The pull is not accepted until that reconciliation is
clean.**

That check earned its place twice. It caught a player carrying rating exactly
1500 with deviation 350 — the Glicko prior for a never-rated account, which
OGS displays as `?` and this code was filing as a 6k. And it caught the dan
half of the mapping being wrong by a full rank: the three kyu bands
reconciled 60/60 while the first dan band reconciled **0/60**, which is the
difference between a bug and a corpus quietly labeled 4d-6d while holding
3d-5d play.

### Filters

| Filter | Why |
| --- | --- |
| `width == 19` | a 3-point loss means something different on 9×9 |
| `handicap <= 1`, no `AB[]` in the record | OGS reports `handicap: 1` for an even game with reduced komi, placing no stones. Those are usable — komi reaches KataGo through the SGF. Rejecting them threw away roughly half the yield. Anything that actually places stones is caught by checking the record rather than the metadata |
| `ranked`, not `annulled` | rating is only meaningful for games that counted |
| no bots | `bot_detection_results`, `players[*].ui_class` |
| reached a real finish | excludes 12-move timeouts, which dominate beginner bands |
| both players in band | |
| Glicko deviation <= 160 | a new account carries rating 1500 and deviation 350 — the prior, not a measurement. Banding on it files an unrated player as a 6k. OGS displays `?` for these, which is what caught it |

### Collected so far

Everything lives under `experiments/corpus/<band>/`, which is git-ignored:
local only, never committed. Each directory holds the SGFs plus a
`manifest.jsonl` recording, per game, both players' ids, ratings, derived
ranks, the ranks the SGF itself displays, move count, outcome, komi, and
ruleset. The personal control sits alongside them in
`experiments/corpus/personal/`.

| Band | Games | Players | Positions | Median | Rank check |
| --- | --- | --- | --- | --- | --- |
| 25k-20k | 60 | 75 | 11,261 | 203 | 60/60 |
| 15k-10k | 60 | 76 | 12,908 | 226 | 60/60 |
| 6k-3k | 60 | 73 | 11,521 | 198 | 60/60 |
| 1d-3d | 60 | 68 | 10,704 | 176 | 60/60 |
| 4d-6d | 60 | 61 | 10,208 | 171 | 60/60 |
| 7d+ | 60 | 61 | 11,688 | 192 | 60/60 |

**360 games, 68,290 prompted positions**, every band reconciling against the
ranks OGS itself displays. The personal control adds 11 games and 1571
positions on top.

Three properties of the collection that the analysis has to account for:

- **Median game length falls with strength** — 203, 226, 198, 176, 171 across
  the kyu and lower dan bands. Stronger
  players resign rather than play out a lost position, so the dan bands
  contribute proportionally more opening and middlegame and less endgame.
  Endgame point losses do not behave like opening ones, so a per-band
  comparison should control for phase rather than pool the whole game.
- **Every wide band tilts toward the population mode.** 15k-10k came out
  10k-heavy (40 against 7 at 15k); 4d-6d came out 4d-heavy (61 against 22).
  The narrow 6k-3k band stayed flat. The wide bands are effectively narrower
  than their labels, and closer to their inner edge.
- **Timeouts** run 3 to 10 per band, recorded in the manifest rather than
  filtered.

### 7d+ is a different kind of band

It could not be collected the way the others were, and the reason is worth
keeping. Random seeding never lands near 7d+, and the walk only follows
players already in band, so it had no route in: the first attempt returned
**zero** games, and the strongest player the 4d-6d crawl ever saw was rank
number 35.96 — the very top of 6d.

Identifying accounts was never the difficulty. Scanning 200 games from four
strong players turned up seven distinct 7d+ accounts one hop away. The
binding constraint is *pairing*: only 5 of those 200 games had 7d+ on both
sides, because strong players mostly play weaker opponents.

So the band needs its queue primed, deeper pagination to surface accounts the
first page of a history misses, and a raised `--cap`:

    node experiments/katago/fetch-ogs.ts --band 7d+ --games 60 \
      --cap 6 --pages 4 --seed-from-group 515 \
      --out experiments/corpus/7d+

**There is no rating leaderboard on OGS to seed from, and that is deliberate.**
The forums explain the reasoning: a list ordered by rating fills with bots,
inflated provisional ratings, and dormant accounts, so OGS publishes
leaderboards based on tournament results instead. The closest usable thing is
group membership — group 515, "OGS Title Tournaments", has ~3000 members and
its endpoint returns each member's rating, deviation and `ui_class` directly.
Roughly 31 requests yields ~320 candidate players near the band, against 61
from priming off the 4d-6d manifest, and it needs no earlier crawl to exist.

The first member that endpoint returns is a good illustration of the warning:
rating 6000, deviation 180, `ui_class: provisional`. The deviation filter
rejects it.

### The corpus is not contaminated by that problem

Worth stating plainly, because the forum warning sounds like it should apply
here. It does not, because the walk never consults a rating ordering: it
reaches players through games actually played, and filters bots and
provisional ratings as it goes. A leaderboard-seeded collection would have
inherited exactly the population the forums complain about.

Audited afterwards, all 61 players in the 7d+ band came back clean —
`ui_class` is `(none)` on 59, `supporter` on 2, `moderator` on 1, with no
bots, no provisional accounts and no rating deviation above the threshold. A
sample of 20 of its games carries `bot_detection_results: null` and
`flags: null`, i.e. nothing flagged — though `null` may equally mean detection
never ran, which the API does not distinguish.

What none of this rules out is an undeclared engine user strong enough to sit
in the band without being caught. That is unfalsifiable from the API, and it
is a reason to treat a 7d+ result as the softest of the six.

With those it fills as completely as any other band — 60 games from 61
distinct players, so the raised cap barely bound in the end. It also reaches
much further above its floor than the other bands do (7d 87, 8d 20, and 13
players at 9d and above), because there is no band above it to stop at. Its
16 timeouts are the highest of any band.

### Privacy and terms

The pull is for private experimentation; the corpus is not redistributed and
`experiments/corpus/` stays ignored. Records carry usernames, so
`anonymize.ts` runs on arrival rather than at publication time.

## 4. Two-stage measurement

The reference is the expensive stage (b40c256 @ 500 visits, ~3.0 s/position);
screening is cheap (b15c192 @ 50 visits, ~0.12 s/position). So: **screen
everything, reference a stratified sample.**

Screen with the *shipping* configuration, not a stronger one. Then the strata
are defined by what the product would actually surface, and the precision
figures that come out are the ones a user would experience.

Three strata, assigned from the screen alone:

| | Stratum | Share of the budget |
| --- | --- | --- |
| **A** | screen says the played move was bad (`pointLoss >= 3`) | 30% |
| **B** | screen says `topPolicyLoss >= 1`, played move fine | 30% |
| **C** | everything else | 40% |

All three are *capped* rather than taken whole. Taking A and B entire was the
first instinct, and the dry run killed it: on the old 1571-position corpus
they hold 204 positions between them, which scales to ~1500 in an
11k-position band — 75 minutes of reference per band, double the budget, for
precision far beyond what any of these questions need. A stratum that comes
in under its allocation hands the surplus along, which is how C absorbs the
slack in a band with few blunders.

C must keep a nonzero rate: recall is
*P*(reference says blunder | screen said fine), and that lives entirely in C.

Every emitted record carries its **sampling weight**, so population estimates
come out by inverse-probability weighting and no downstream analysis can
silently forget the design.

**The sampling rule is frozen before any reference output is inspected.**

## 5. Cost

Per band at 60 games ≈ 9000 prompted positions:

| Stage | Positions | Rate | Time |
| --- | --- | --- | --- |
| screen | ~12,000 | 0.12 s | ~24 min |
| reference | 800 sampled | 3.0 s | ~40 min |

Six bands ≈ **6.4 hours** of engine time — against roughly 30 hours to
reference every screened position. The bucket that is
currently the weak point (n=34) reaches n≈200, tightening the 44% figure from
about ±17pp to ±7pp.

Rates extrapolate from feasibility §4, which measured 100 visits. They are
estimates, and the first band's screen is also the measurement that replaces
them.

Never run this while the browser harness is running: both contend for the GPU
and both sets of timings become fiction.

## 6. Analysis

Per band: baseline error rates, the feasibility §8 stratification table, and a
**threshold sweep** of the `topPolicyLoss` cut from 0.5 to 5 — the question is
whether the best cut *moves* with rank, not merely whether the effect
survives. All estimates weighted, all with confidence intervals; an unweighted
figure from this corpus is simply wrong.

## 6b. The reference does not judge the worst moves

A KataGo search reports only the moves it visited. A move bad enough that
PUCT never expands it comes back with no `scoreLead`, and `analyze.ts`
records `pointLoss: null` — so the positions the reference silently drops are
exactly the ones that decide a blunder rate.

The rate is not small, and it is worst where it hurts most:

| Band | Sampled positions with no verdict |
| --- | --- |
| personal (3k-7k) | 74 of 800 (9%) |
| 15k-10k | 256 of 800 (32%) |
| 25k-20k | 259 of 800 (32%) |

Weaker players play more moves the engine would never consider, so the
missingness rises exactly as the band gets weaker — and it is not random
within a band either. Of the personal control's unjudged positions, the ones
the screen *did* score had a median point loss of 14.2 and a maximum of 20.1.
Left alone, this biases every blunder rate downwards, and biases the weak
bands more than the strong ones, which would manufacture a rank gradient out
of nothing.

`backfill.ts` repairs it with `allowMoves`, which forces the search to
evaluate a move it would otherwise ignore. The subtlety is that inside a
one-move query that move is trivially the best, so its own root estimate is
meaningless: the loss must be measured against the root from the original
unrestricted query, which the reference already recorded. The repaired
positions go to a separate file that `survey.ts` merges, so nothing is
overwritten.

This is the same defect that
[the AI scoring PRD](prd-ai-scoring.md) §6 resolves for the product — a guess
the engine did not consider still has to be scored. The corpus harness simply
had not adopted it.

## 6c. Results

Six bands plus the personal control, 800 sampled positions each, weighted back
to the whole band. Every figure below is post-backfill; the pre-backfill
version of this table said something materially different, which is the point
of §6b.

| | 25k-20k | 15k-10k | 6k-3k | 1d-3d | 4d-6d | 7d+ |
| --- | --- | --- | --- | --- | --- | --- |
| lost >=3pt | 42.5% | 37.8% | 21.9% | 14.7% | 9.0% | 7.6% |
| blundered | 19.3% | 15.2% | 8.1% | 3.8% | 2.4% | 1.6% |
| natural move >=3pt -> lost >=3pt | 71.5% | 80.6% | 77.1% | 59.7% | 40.1% | 28.4% |
| detector precision | 81.6% | 78.9% | 76.5% | 61.9% | 59.3% | 47.1% |
| detector recall | 14.3% | 14.4% | 28.3% | 29.9% | 33.6% | 36.4% |

### The difficulty signal is real, and it decays with rank

It is not an artifact of the original corpus being one player and a bot. The
personal control and the real 6k-3k band agree closely on it — 73.5% against
77.1% for "the natural move costs >=3pt", well inside each other's intervals —
so where intuition is a trap, players of that strength fall in at the rate the
original finding claimed.

Across bands it fades exactly as predicted: amateurs play the natural move, so
the trap catches them; stronger players have stopped, so it does not. The
threshold sweep shows the same thing in its shape. Every kyu band climbs
monotonically to cut 5.0 (25k-20k reaches 83.4%, 6k-3k 84.1%), while 7d+ is
flat from cut 2.0 onward — 30.0%, 28.4%, 31.3% — meaning a higher threshold
buys a strong player nothing.

**The lift over baseline holds at every rank**: roughly 3-7x each band's own
error rate, with no trend. The signal keeps finding genuinely riskier
positions for everyone. What collapses is the absolute rate, because strong
players simply do not err often. So one fixed threshold remains defensible;
what cannot be fixed is the confidence attached to it.

### The detector is strongest where it matters most — if the guess is forced

| Band | precision | recall |
| --- | --- | --- |
| 25k-20k | 90.0% | 82.4% |
| 15k-10k | 91.1% | 64.7% |
| 6k-3k | 75.7% | 49.5% |
| 1d-3d | 67.5% | 41.0% |
| 4d-6d | 57.1% | 47.7% |
| 7d+ | 56.5% | 55.5% |

Recall is highest for beginners, whose blunders are large and unambiguous, and
falls to somewhere in the forties and fifties at dan level with intervals too
wide to order. Precision declines the same way, 90% down to 56%: a dan
player's errors are small enough to sit near a small network's noise floor,
which is the story [the feasibility notes](katago-feasibility.md) §5 already
told about network capacity.

**These numbers only hold if the guess is evaluated with `allowMoves`.**
Measured against a screen that stays silent on moves search never visited —
45% of a beginner's moves, 7% of a 7-dan's — the same detector appears to
catch **14%** of a 20-kyu's blunders and 36% of a 7-dan's, an apparent
inversion that is entirely an artifact of the silence. Forcing the evaluation
moves beginner recall from 14% to 82%.

The artifact is worth recording because it is so plausible: it produces a
clean monotone gradient, in a direction that invites a story about why weak
players are hard to judge, and nothing about it looks broken. The measurement
that exposes it is cheap — a restricted search at 50 visits costs far less
than an unrestricted one, because it explores a single subtree.

## 7. What the design does and does not support

Stratifying on the screen's own output means stratum B contains positions
where the screen was mistaken, and regression to the mean will pull the
measured trap rate below its true value.

That is the *correct* bias for the product question — "when the shipped
detector fires, how often is the player really in trouble" is precision, and
precision is what a user experiences. It is the *wrong* bias for "how hard is
this position really." Weighted population estimates recover the latter for
quantities that C can estimate; anything conditioned on B cannot be read as a
statement about difficulty in general.

## 8. HumanSL is downstream of this, not upstream

Using the human-imitation net as the instrument would hold position constant
and cost an afternoon, but it assumes its move distribution resembles the rank
it claims to imitate, and that assumption is unverified. Real per-band data is
what tests it. HumanSL becomes something the survey validates, not something
the survey depends on — off the critical path.

## 9. Code

| Module | Responsibility |
| --- | --- |
| `fetch-ogs.ts` | seeded snowball, filters, band assignment, SGF download |
| `sample.ts` | screen output → weighted position list, by the frozen rule |
| `analyze.ts` | gains: accept a position list instead of whole games |
| `compare.ts` | gains: weighted estimates with CIs, grouped by band |

## 10. Open

- Whether OGS carries enough 7d+ amateur play to fill a band, or whether that
  one has to come from KGS with the cross-server caveat.
- Whether beginner bands survive the filters at all: 25k–20k play is heavily
  handicapped and frequently abandoned.
- Whether the screen's own throughput matches the extrapolation in §5.
