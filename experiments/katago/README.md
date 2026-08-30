# KataGo point-loss experiments

Two questions decide whether in-browser AI scoring is viable for lituus, and
neither can be settled by argument:

1. **Is a small network at a modest visit count accurate enough?** If lituus
   tells a user "that move cost you three points", how wrong is that number
   compared with what a strong engine would say?
2. **How slow is a bigger network in a browser?** Accuracy and download size
   and speed trade against each other, and the acceptable point on that curve
   is an empirical fact about real hardware.

This directory answers (1). It runs the same corpus through several KataGo
configurations locally and measures how far the cheap ones drift from a
strong reference.

## Setup

Requires a KataGo binary on `PATH` (or `$KATAGO`) and network files. Neither
is checked in; `experiments/nets/` and `experiments/out/` are ignored.

Networks used here come from the g170 archive, which still publishes the
small networks the current run does not:

    experiments/nets/g170-b6c96-…        3.6 MB
    experiments/nets/g170e-b10c128-…      11 MB
    experiments/nets/g170e-b15c192-…      35 MB

Drop the corpus — 19x19 and 9x9 games, SGF — in `experiments/corpus/`.

`fetch-ogs.ts` collects one, banded by rank, from OGS:

    node experiments/katago/fetch-ogs.ts \
      --band 6k-3k --games 60 --out experiments/corpus/6k-3k

Bands are `25k-20k`, `15k-10k`, `6k-3k`, `1d-3d`, `4d-6d`, `7d+`. Reads need
no authentication; requests go out one per second. A run is resumable — it
reads back the manifest it wrote and picks up where it stopped — and
reproducible from `--seed`.

The thinnest band needs help finding its way in, because random seeding never
lands near it:

    node experiments/katago/fetch-ogs.ts --band 7d+ --games 60 \
      --cap 6 --pages 4 --seed-from-group 515 \
      --out experiments/corpus/7d+

`--seed-from-group` primes the queue from an OGS group's membership (515 is
"OGS Title Tournaments"); `--seed-from <manifest.jsonl>` does the same from a
neighboring band already collected. OGS has no rating leaderboard to seed
from — see the design doc for why that is deliberate, and why it does not
compromise the corpus.

Each band directory gets a `manifest.jsonl` alongside the SGFs, recording per
game both players' ids, ratings, derived ranks, the ranks the record itself
displays, move count, outcome, komi, and ruleset. `experiments/corpus/` is
git-ignored, so the corpus stays local.

See [the rank survey design](../../docs/design-rank-survey.md) for why the
discovery works the way it does, and what the filters are for.

Once a band is collected, screening and sampling run:

    node experiments/katago/analyze.ts --net <b15c192> --visits 50 \
      --label 6k-3k-screen --out experiments/out/6k-3k-screen.jsonl \
      experiments/corpus/6k-3k/*.sgf

    node experiments/katago/sample.ts \
      --screen experiments/out/6k-3k-screen.jsonl \
      --target 800 --out experiments/out/6k-3k-sample.jsonl

    node experiments/katago/analyze.ts --net <b40c256> --visits 500 \
      --positions experiments/out/6k-3k-sample.jsonl \
      --label 6k-3k-ref --out experiments/out/6k-3k-ref.jsonl \
      experiments/corpus/6k-3k/*.sgf

A search only reports moves it visited, so the reference has no verdict on
moves bad enough that it never looked at them — up to a third of a weak
band's sample, and disproportionately the blunders. `backfill.ts` forces
those with `allowMoves`, writing a separate file rather than overwriting:

    node experiments/katago/backfill.ts --net <b40c256> --visits 500 \
      --ref experiments/out/6k-3k-ref.jsonl \
      --out experiments/out/6k-3k-backfill.jsonl \
      experiments/corpus/6k-3k/*.sgf

`survey.ts` then reads a band back, weighted, merging the backfill if present:

    node experiments/katago/survey.ts 6k-3k

Everything above judges the move the game played. `guesses.ts` judges the move
the *player* guessed, from a playthrough's exported result:

    node experiments/katago/guesses.ts --net <b40c256> --visits 500 \
      --play <playthrough.json> --ref experiments/out/<band>-ref.jsonl \
      --out experiments/out/<band>-guesses.jsonl <game.sgf>

It forces every guess rather than only the ones search happened to visit: a
guess is one amateur's idea, so it is even less likely than a played move to
appear in an unrestricted search, and forcing also spends the full visit
budget on it instead of the three visits it might otherwise have got.

Every pass above truncates its principal variation to six plies, because a
hundred positions at 500 visits is twenty minutes and the tail of a line is
barely searched. The three or four moves a review is actually about deserve
better than a two-move refutation, so `deepen.ts` re-searches only those, at a
much larger budget, and keeps the whole line:

    node experiments/katago/deepen.ts --net <b40c256> --visits 4000 \
      --play <playthrough.json> --stem experiments/out/dogfood/<name> <game.sgf>

Only the lines are kept. Its scores would be measured at a different budget
from every other number in the review, and one move carrying two point-loss
figures that disagree is worse than one figure.

The stratification rule itself lives in `strata.ts`, shared by the sampler and
the reader so a boundary cannot move between drawing a sample and analyzing
it — that kind of drift would corrupt every weighted estimate silently.

## Running

    node experiments/katago/analyze.ts \
      --net experiments/nets/<net>.bin.gz \
      --visits 200 --label b6c96-v200 \
      --out experiments/out/b6c96-v200.jsonl \
      experiments/corpus/*.sgf

    node experiments/katago/compare.ts \
      --ref experiments/out/<reference>.jsonl \
      experiments/out/b6c96-v200.jsonl

## Before keeping results

`analyze.ts` names each game after its SGF file, which is convenient while
working and carries the handles of real players whose games are being
dissected move by move. Anonymize before committing anything anywhere:

    node experiments/katago/anonymize.ts \
      --map experiments/out/game-map.json experiments/out/*.jsonl

The identifier is only used to group records, so nothing is lost. The map is
written to an ignored path and is the only thing that reverses this; it is
deliberately not version-controlled.

The records themselves need the same treatment, and need it more. A game
fetched from a server arrives with both handles, a `PC` link straight back to
the original, and — in over half of them — `C` properties holding the players'
in-game chat, which is where real personal names turn up rather than handles:

    node experiments/katago/anonymize.ts \
      --players experiments/out/player-map.json experiments/corpus/*/*.sgf

Chat and the back-link are dropped outright; the handles are replaced. This
rewrites in place and is safe to re-run — an id already handed out maps to
itself rather than being renamed again.

Do this even for a corpus that never leaves the machine, because a record is
not only an input: lituus embeds the whole thing in the result it exports at
the end of a playthrough, so whatever the record still carries travels with
every export.

## What is measured

`analyze.ts` records, for every position lituus would prompt on, the engine's
verdict on the move actually played. Point loss is measured against the
search's root estimate rather than against its top child: `order` ranks
children by visits, so a lightly visited sibling can carry a higher and
noisier score lead and make the subtraction come out negative.

The played move standing in for the user's guess is a deliberate
simplification. A real guess is often worse than the played move and so
further down the search's attention, where estimates are noisiest — which
means these numbers are, if anything, optimistic.

`compare.ts` reports the distribution of per-move disagreement first, because
that is the number a user would be shown. It then reports the coarser
judgments a user actually acts on: the point-loss band, whether the same move
was called best, and whether blunders are caught.

`analysis.cfg` fixes every setting that could move a score, and disables
network randomization: two runs of one configuration must agree exactly, or
the comparison measures search noise rather than network quality.
