# Reuse notes — lituus and kifu

lituus borrows from [kifu](https://github.com/hyponymous/kifu) by copying
and adapting, with the intent of extracting a shared package once both
consumers have settled (see
[the PoC design doc](design-proof-of-concept.md) §2).

This file records divergences **as they are made**, so the eventual
extraction is a matter of reading notes rather than reconstructing decisions
from two diverged codebases.

kifu is the main upstream, and everything below concerns it unless a section
says otherwise. The analysis engine has a second one — web-katrain — which is
borrowed from on the same terms and gets its own section at the end.

## Conventions

- Every vendored file carries a header comment naming its upstream origin.
- Every entry below says what differs and *why*, since the why is what
  decides whether a difference should be reconciled or preserved at
  extraction time.

## Divergences

### Test harness: no TypeScript loader hook

**kifu:** runs tests with `node --experimental-transform-types --loader
./test/helpers/resolve-ts.mjs`, where `resolve-ts.mjs` resolves extensionless
relative imports (`./sgf-parser`) to `.ts` files.

**lituus:** runs plain `node --test 'test/*.test.ts'`, with no loader and
no flags. Imports carry explicit extensions (`./sgf-parser.ts`), enabled by
`allowImportingTsExtensions` in `tsconfig.json`.

**Why:** Node 24 strips TypeScript types natively, so the transform flag is
unnecessary. Node's resolver requires explicit extensions, which is what
kifu's loader hook exists to paper over; writing the extensions instead
removes the hook, the flags, and a nonstandard resolution rule that only
holds inside this project.

**At extraction:** shared source must use explicit `.ts` extensions to work
under both. Vite resolves them fine, so kifu can adopt the same convention
without its loader — this difference should be reconciled, not preserved.

### goban.ts: renders a position, not a tree

**kifu:** `renderGoban(trees, container, opts)` takes parsed game trees,
replays them internally, and crops to a viewport calculated from where the
stones are, with tick marks implying board beyond the crop.

**lituus:** `renderGoban(position, container, opts)` takes a `Position` from
the rules engine and always draws the whole board. No viewport, no cropping,
no tick marks. Adds per-intersection click targets, a marker overlay
(`actual` / `guess` / `hit` for a reveal, `last` for the stone most recently
played), and an `animate` option naming the indices whose stones are new, so
the stylesheet can move only what changed.

**Why:** cropping is right for sharing a diagram, where the interesting part
is a corner. It is wrong for a study session: a player reads a position
against the whole board, and a viewport recomputed each move would shift
under them as the game spreads. Taking a position rather than a tree also
keeps the renderer ignorant of SGF, which is what makes it reusable.

**At extraction:** the shared renderer should take a position and treat the
viewport as an option, with kifu passing a computed crop and lituus passing
none. The grid, star points, stone drawing, and coordinate labels are
already common and should move over close to unchanged. The `last` marker is
worth sharing — a static diagram wants to show the move it is about — while
`actual` / `guess` / `hit` are specific to a prediction session and could stay
here. Animation belongs to the consumer's stylesheet either way: the renderer
only labels what is new and takes no view on whether it should move.

### goban.ts: no stone jitter

**kifu:** offsets each stone by up to half a pixel, deterministically seeded
by its coordinates, for a hand-placed look.

**lituus:** stones sit exactly on their intersections.

**Why:** markers are drawn on the same points as stones, and a marker that
does not line up with the stone it refers to looks like a bug. The charm is
not worth the ambiguity when the whole task is reading precise points.

**At extraction:** keep it an option, defaulting to off.

### Vite config: no dev middleware

**kifu:** a custom Vite plugin serves `dev/` HTML tools and `fixtures/` under
the base path.

**lituus:** no plugin. Just `root`, `base`, and `build.outDir`.

**Why:** neither a `dev/` tools directory nor image fixtures exist here. Add
the middleware back if and when they do; it is unrelated to any shared code.

**At extraction:** not applicable — build config is per-project.

### Masthead: the tagline is screen-dependent

**kifu:** header is static — wordmark, tagline, repo link — because the whole
app is one screen and the tagline never has to get out of the way.

**lituus:** the same three parts and the same GitHub mark, but the tagline
shows only on the landing screen. `main.ts` stamps `data-screen` on the body
and the stylesheet hides it elsewhere.

**Why:** lituus has four screens and the tagline answers a question the user
only has on the way in. Once a session is running, it is a line of text
between the reader and the board.

**At extraction:** the markup and the GitHub mark could be shared; the
visibility rule could not, and belongs to whichever app has screens.

### URL-fragment encoding: one file, no download, typed bytes

**kifu:** `src/encode.ts` and `src/decode.ts`, two files. `decode.ts` also
exports `download()` for saving the record as a file, and both export
`*FromHash`/`*ToHash` helpers that read and write `location.hash`
themselves. The writer is fed with a cast: `writer.write(data as
Uint8Array<ArrayBuffer>)`.

**lituus:** one `src/share.ts` exporting `encode` and `decode` only. The
hash is read by `main.ts`, which already owns routing and has a dev fragment
to check first; a download already exists in `views.ts`. The byte arrays are
typed `Uint8Array<ArrayBuffer>` at the boundary, so the writer takes them
with no cast. Error messages are rewritten for a reader holding a broken
link rather than a developer holding a stack trace.

**Why:** two forty-line files for one concern is over-split at this size,
and a module that reaches for `location` is harder to test than one that
takes a string. The cast in kifu is load-bearing only because its byte
arrays are typed loosely upstream.

**At extraction:** `encode`/`decode` are the shared part and should keep the
narrow signatures. Everything that touches `location`, the DOM, or user-facing
wording belongs to the app.

## Vendored from web-katrain

A second upstream, on the same terms: [web-katrain](https://github.com/Sir-Teo/web-katrain),
MIT. It is the only browser KataGo close enough to lituus's needs to borrow
from, and `docs/design-ai-scoring.md` §4 records why a subset is adapted rather
than the whole thing vendored or a new engine written.

Unlike the kifu borrowings, nothing here is heading for a shared package. It is
a transcription of KataGo's model format and search, and its correctness is
owed to KataGo rather than to us — which is exactly why the divergences need
recording.

**There are really two upstreams here**, and which one a file follows is itself
a divergence worth recording. web-katrain is a port, and where its port is thin
or absent — the ladder search, the score-utility tables, the search constants —
the file below follows KataGo's C++ instead. That is not a preference for the
harder source: `docs/exploration-forward-pass-parity.md` is the record of what
it cost to work the other way round, and every one of the parity bugs was found
by reading `nninputs.cpp` rather than by probing the port.

### `binModelParser.ts` → `src/engine/bin-model-parser.ts`

A clean lift. The `.bin` tokenizer is pure, dependency-free, and has no reason
to differ. Renamed to the project's kebab-case file convention; contents
unchanged.

### `loadModelV8.ts` → `src/engine/load-model-v8.ts`

Lifted. Two changes, both about imports:

- Specifiers carry `.ts` extensions, as everything in this project does.
- The `ParsedKataGoModelV8` type comes from a new `model-types.ts` rather than
  from `modelV8.ts`.

**Why the second one matters.** Upstream, the parsed-model type lives in the
same module as the TensorFlow.js graph, so reading a network drags TensorFlow.js
in behind it. Splitting the type out keeps the parser free of it, which is what
lets `node --test` exercise the parser with no bundler and no GPU, and what lets
the deployment spike validate a downloaded network before any backend exists.

### `modelV8.ts` → `src/engine/model-types.ts` (types) and `model-v8.ts` (graph)

Split in two, and the split is the divergence. Upstream keeps the parsed-model
type in the same module as the TensorFlow.js graph; here the declarations live
in `model-types.ts` and only `model-v8.ts` imports TF.js. Everything else in
`engine/` — parser, board, planes, ladders, the search's arithmetic — therefore
runs under `node --test` with no bundler and no GPU, which is what lets most of
the engine be tested at all.

The graph itself is a transcription: trunk, both heads and the pooling formulas
are fixed by the file format. Two divergences, both subtractive:

- **No ownership head.** lituus never shows an ownership map. The head is still
  *parsed* — the file has to be read in order — and then not built, which is one
  convolution and one weight tensor less per position on a device whose limit is
  a memory high-water mark (`docs/katago-feasibility.md` §7). The deferred root
  ending bonus (`docs/design-ai-scoring.md` §4.3.3) is the one thing that would
  want it back.
- **One forward method, not three.** Upstream offers policy-and-value,
  value-only and everything. A search that needs the policy at every expansion
  and the value at every leaf gets both from a single call.

`evalV8.ts` (logits → win probability and score lead) came across as the tail of
the same file, kept separate from the graph because it is arithmetic over the
outputs rather than part of the network.

### `featuresV7Fast.ts` → `src/engine/features-v7.ts`

Adapted. A specification rather than a design: every plane index and global is
fixed by the network file, and a wrong plane raises nothing — the network
answers a different question, confidently. Three divergences.

**Territory scoring only, refused at the door.** The area planes need a
pass-alive (Benson) analysis that has not been ported, so `area` is named in the
ruleset type and rejected by `buildFeatures` rather than quietly encoded as
territory. Territory covers Japanese and Korean, which is 92% of the corpus.

**The ladder planes are computed, not passed in.** Upstream takes planes 14–17
as four optional `Uint8Array` arguments and leaves the caller to fill them.
`ladder.ts` fills them here (below), because a plane a caller may forget is a
plane that will eventually be forgotten.

**The self-komi chill, which is a correction to upstream.** Upstream computes
`selfKomi = pla === 'white' ? komi : -komi`, a plain negation, and so did we.
KataGo's `BoardHistory::currentSelfKomi` does not: under territory scoring a
stone fills your own territory, so it folds a point per move played into the
komi. We were passing the record's komi unadjusted and asking the network about
a position worth a point more or less than the one on the board, whenever the
players had played a different number of moves. Found by compiling
`dump-inputs.cpp` against KataGo's own `nninputs.cpp` — global 5, ours 0.400
against theirs 0.450 — and fixed in `b90cacb`. The whole story, including why
it read for weeks as a White-to-play bug, is
`docs/exploration-forward-pass-parity.md`.

### `fastBoard.ts` (move half) → `src/engine/board.ts`

Adapted, 376 lines against upstream's ~200 for the same job — the extra
includes `libertyMap`, which belongs to the feature half below but needs the
board's flood fill and so lives here. Three divergences, all deliberate.

**No module-level mutable state.** Upstream keeps the board size, the neighbour
tables and every scratch buffer in module `let`s, reinitialized by
`setBoardSize`. Two boards of different sizes then quietly corrupt one another.
That is a live hazard here rather than a theoretical one: the tests replay 7x7
through 19x19 in a single process, and a session can load a second game without
a reload. A `Board` owns its tables and scratch instead, built once per game.

**Rectangular boards work.** Upstream indexes by one dimension. `rules.ts`
reads rectangular `SZ`, supporting it costs a second field, and it lets the
differential test cover records upstream could not represent. The *network* is
still square-only — its input planes really are indexed that way — which is a
separate limit recorded in `docs/prd-ai-scoring.md` §12.

**An illegal move returns null instead of throwing.** A search asks constantly
and an exception is the wrong instrument for an expected answer. Upstream
throws, which is right for a UI and wrong in a loop that runs millions of times
a second. A refused move also leaves no trace, so there is nothing for the
caller to undo.

Retained exactly: the stamped flood fill (clearing 361 entries per liberty
query would be most of its cost), the liberty cap at two, the processed-group
stamp that stops one group being captured twice through two neighbours, and the
ko condition — which is character-for-character the same rule `rules.ts`
implements, and is the thing `test/engine-board.test.ts` exists to keep true.

Stones use KataGo's 0/1/2 rather than `rules.ts`'s 1/-1, since everything
downstream in the engine reads that encoding; converting here is one pass per
evaluation instead of one per feature build.

### `fastBoard.ts` (feature half) → `src/engine/ladder.ts` and `libertyMap`

Ported from KataGo's C++ rather than from upstream's port of it:
`Board::searchIsLadderCaptured`, `searchIsLadderCapturedAttackerFirst2Libs` and
`iterLadders` in `cpp/game/board.cpp` and `cpp/neuralnet/nninputs.cpp`. The
planes are only useful if they say what KataGo's say, so the search is followed
closely — including its move ordering and its node budget. A cleverer search
that finds one more ladder is a worse input, not a better one.

They earned the effort: planes 14–17 were the *whole* of the even-turn parity
error, and a network that cannot see a ladder is not slightly worse at ladders,
it is confidently wrong about them.

One structural divergence. KataGo maintains chain membership and liberty counts
incrementally, so a liberty count is a lookup; `board.ts` recomputes by stamped
flood fill, so the same question costs a walk. That is a constant factor on an
already-bounded search, and it buys not maintaining a second set of invariants
through every play and undo.

Still not taken from the feature half: `calculateAreaForPla` /
`computeAreaMapV7KataGo`, the pass-alive analysis. It gates area-rules support
above, and the root ending bonus needs it too.

### `analyzeMcts.ts` → `search.ts`, `search-params.ts`, `score-value.ts`

Rewritten against our own board, keeping the numerics: 1,219 lines against
upstream's 2,836, which serves an analysis product — ownership maps, regions of
interest, wide-root noise, tree reuse, progressive reporting — that lituus does
not have.

**Two terms dropped, neither a change to a formula.** Upstream distinguishes a
child's *edge* visits from its *node* visits, because two paths can reach one
node under graph search; graph search is deferred, so the two are always equal
here. Upstream also runs many threads with virtual losses; one thread has none.
Both are the formula with a term that is provably zero.

**The constants did not come from upstream.** web-katrain's `searchParams.ts` is
three lines citing `analysis_example.cfg`. Ours transcribes `setup.cpp`'s
`SETUP_FOR_ANALYSIS` defaults, which are what actually produced the reference
runs in `experiments/out/` and differ from the frozen `SearchParams()` in
`searchparams.h` on a dozen keys — dynamic cPUCT is entirely off in the header
and on in the analysis engine. `docs/design-ai-scoring.md` §4.3.1 has the list;
the file carries a line citation per constant, at KataGo v1.13.2, which is the
version the references were recorded with.

**Two of upstream's constants are inert on our network, measured rather than
assumed.** `policyOptimism` needs two or four policy channels and `b15c192` has
one; `useUncertainty` needs `modelVersion >= 9` and ours is 8. So upstream reads
no optimistic head and weights every leaf 1 either.

`score-value.ts` likewise follows `ScoreValue` in `nninputs.cpp` and the
`DistributionTable` in `search.cpp` rather than upstream's `scoreValue.ts`. Two
notes worth keeping: the t-distribution CDF at ν=3 has a closed form, so the
continued-fraction `incompleteBeta` port upstream carries was unnecessary — but
the 2,000-point table over [−50, 50] and its linear interpolation *are*
replicated, because matching the reference means matching its interpolation too.

**No terminal nodes.** Under territory scoring two passes send KataGo into the
encore rather than to a result, and the encore is a large part of
`boardhistory.cpp` with its own ko rules. No node is treated as terminal here.
At fifty visits from a prompted position the tree does not reach a double pass,
so the case is unreachable rather than handled — but it is a real limit.

### Deliberately not taken

- **`fastBoard.ts`'s pass-alive area code** (`calculateAreaForPla`,
  `computeAreaMapV7KataGo`, ~210 lines). The last of the feature half still
  outstanding; the liberty maps and ladders are above.
- **`worker.ts` / `client.ts`**, 1,132 lines. Their lifecycle serves an analysis
  product with tree reuse, cancellation and progressive reporting. lituus queues
  one search at a time behind a session, and `src/engine/worker.ts` plus
  `src/engine-client.ts` come to 364 lines together — the replace call in
  `docs/design-ai-scoring.md` §4.2 was the right one.
- **`backendFallback.ts`.** Upstream degrades to wasm. GitHub Pages cannot set
  COOP/COEP, so there is no `SharedArrayBuffer` and wasm would be
  single-threaded, which for a 15-block net means losses arriving after the
  reader has left the summary. No WebGPU degrades to exact-match scoring
  instead (`docs/design-ai-scoring.md` §5.4).
- **The `tfjs` umbrella package.** Upstream depends on it; lituus takes
  `@tensorflow/tfjs-core` and the WebGPU backend only. The KataGo graph uses
  core ops, and layers, converter and data would be bundle nobody calls.

## Candidate package contents

- `sgf-parser` — the strongest candidate. Pure, no DOM, already stable.
- `rules` — new code in lituus, but general. kifu's `replayMain()` could
  be rebuilt on top of it, gaining ko and suicide handling it currently
  lacks.
- `goban` — the renderer. Most valuable to share and hardest to generalize,
  since kifu crops to a viewport and lituus never does. The divergences
  here are the ones to document most carefully.
- `share` — the fragment encoding. Pure, no DOM, and now proven in two
  consumers, which is the bar the rest of this list is waiting to clear.
