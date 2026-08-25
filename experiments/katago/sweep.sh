#!/usr/bin/env bash
# Run the whole grid: a strong reference, then each candidate browser
# configuration across a range of visit counts.
#
# Sequential by design. Two runs at once would contend for the GPU and make
# the timings — which are half the point — meaningless.
#
#   experiments/katago/sweep.sh
#
# Networks are expected in experiments/nets/; see README.md.
set -euo pipefail
cd "$(dirname "$0")/../.."

NETS=experiments/nets
OUT=experiments/out
mkdir -p "$OUT"

shopt -s nullglob
CORPUS=(experiments/corpus/*.sgf)
if [ ${#CORPUS[@]} -eq 0 ]; then echo "no SGFs in experiments/corpus/" >&2; exit 1; fi

run() { # <net-path> <label> <visits>
  local out="$OUT/$2-v$3.jsonl"
  if [ -s "$out" ]; then echo "skip $2-v$3 (exists)"; return; fi
  node experiments/katago/analyze.ts \
    --net "$1" --visits "$3" --label "$2-v$3" --out "$out" "${CORPUS[@]}"
}

B6=$NETS/g170-b6c96-s175395328-d26788732.bin.gz
B10=$NETS/g170e-b10c128-s1141046784-d204142634.bin.gz
B15=$NETS/g170e-b15c192-s1672170752-d466197061.bin.gz
REF=${KATAGO_REF_NET:?set KATAGO_REF_NET to a strong network}

# Reference first: it is the long pole, and nothing can be read without it.
run "$REF" ref 500

# Low tiers first: they are cheap, and a single forward pass already yields a
# scoreLead, so the interesting question is how far down this can go.
for v in 10 25 50 100 200 400; do
  run "$B6"  b6c96   "$v"
  run "$B10" b10c128 "$v"
  run "$B15" b15c192 "$v"
done

echo "sweep complete"
