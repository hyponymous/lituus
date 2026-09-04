# In-browser throughput benchmark

Answers the second KataGo question: **how slow is a bigger network in a
browser?** The accuracy side is in `../katago/`.

There is no browser KataGo of our own. This measures
[web-katrain](https://github.com/Sir-Teo/web-katrain) (MIT), which parses
KataGo's native `.bin.gz` and runs PUCT search on TensorFlow.js — the closest
thing to what lituus would ship, and enough to size the problem before
committing to building anything.

## Setup

    git clone --depth 1 https://github.com/Sir-Teo/web-katrain.git \
      experiments/vendor/web-katrain
    (cd experiments/vendor/web-katrain && npm install)

    node experiments/browser/make-positions.ts \
      experiments/corpus/<a 19x19 game>.sgf \
      experiments/vendor/web-katrain/public/lituus-positions.json

The checkout is ignored, as are the networks it serves.

## Running

    node experiments/browser/run.ts --visits 100 --backends webgpu,wasm

Runs headed on purpose. A headless Chromium will happily answer
`requestAdapter()` with a *software* adapter, and the resulting timings look
entirely plausible while measuring the CPU. Every run reports the adapter it
got, and flags a fallback one; treat any result marked `FALLBACK(software)`
as void.

Do not run this while a local KataGo sweep is going — they contend for the
same GPU and both sets of timings become fiction.

## What is measured

- **visits/second** through the full search: the number that bounds a
  session, since lituus needs roughly three searches per prompt.
- **evals/second** through a batched forward pass, isolating network cost
  from search overhead.
- **load time**, which is the other half of the download-size tradeoff.

Positions come from a real game at six stages, opening through endgame,
because search cost falls as the board fills and a single position would
mislead.

---

# Forward pass and readback

`run-readback.ts` measures **our** engine rather than the vendored one, and
exists for a single question: `dataSync()` on the WebGPU backend is a canvas
round trip, not a readback, and `ModelV8.evaluate` makes one per output head.

    node experiments/browser/run-readback.ts --label before \
      --save experiments/out/readback-before.json

It reports the cost of one forward pass, the cost of one `dataSync()` at two
sizes 90x apart, and the cost of one prompt at the shipping visit count. Two
numbers to read together:

- **a read as a share of a pass** tells you what reading fewer times can buy.
- **the fitted per-call cost**, from the two sizes. Only that part is won back
  by making fewer calls; the bytes have to cross either way. Measured at
  2.4ms per call plus ~3.5us per float on an M-series Mac, which is why
  reading the four heads once instead of four times took a forward pass from
  23.0ms to 15.7ms.

Headed, and for the same reason as above; the adapter is printed and a
software one is flagged. It is a before-and-after instrument — one run on its
own says almost nothing, so save one before touching anything and diff. Runs
from different machines, adapters, or positions are not comparable.
