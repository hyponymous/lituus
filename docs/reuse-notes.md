# Reuse notes — lituus and kifu

lituus borrows from [kifu](https://github.com/hyponymous/kifu) by copying
and adapting, with the intent of extracting a shared package once both
consumers have settled (see
[the PoC design doc](design-proof-of-concept.md) §2).

This file records divergences **as they are made**, so the eventual
extraction is a matter of reading notes rather than reconstructing decisions
from two diverged codebases.

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

## Candidate package contents

- `sgf-parser` — the strongest candidate. Pure, no DOM, already stable.
- `rules` — new code in lituus, but general. kifu's `replayMain()` could
  be rebuilt on top of it, gaining ko and suicide handling it currently
  lacks.
- `goban` — the renderer. Most valuable to share and hardest to generalize,
  since kifu crops to a viewport and lituus never does. The divergences
  here are the ones to document most carefully.
