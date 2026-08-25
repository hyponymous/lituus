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
