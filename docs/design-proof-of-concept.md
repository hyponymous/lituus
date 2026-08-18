# lituus — Engineering Design: Proof of Concept

**Status:** draft
**Last updated:** 2026-08-17

How the proof of concept described in
[the PoC PRD](prd-proof-of-concept.md) gets built. Scope here is
implementation approach, module boundaries, reuse, testing, and risk — not
product behavior, which the PRD owns.

## 1. Layering

Four layers, built bottom-up, each usable before the one above it exists:

```
views (landing → setup → session → summary)
  └── session state machine (prompt/reveal/advance, scoring)
        └── game model (main line, setup stones, metadata)
              └── rules engine + board renderer
                    └── SGF parser (vendored)
```

The dependency edges that matter:

- The **game model** and the **board renderer** do not depend on each other.
  They can be built in parallel once the parser is in place.
- The **views** can be built against a session machine driven by a
  hand-built fixture game, before real SGF loading works.
- Everything above the parser depends on its `GameTree` type, so vendoring
  the parser comes first.

### Module sketch

| Module | Responsibility |
| --- | --- |
| `sgf-parser` | SGF text → `GameTree[]`. Vendored, unchanged. |
| `rules` | Position + one move → new position. Captures, ko, suicide, legality queries. |
| `goban` | Render a position to SVG; report clicks; draw markers. |
| `game` | `GameTree` → board size, setup stones, main-line move list, metadata. |
| `session` | Drives prompt → reveal → advance; owns the guess record and score. |
| `views` | The four screens and the transitions between them. |

The split between `game` and `session` is the one worth holding: `game` is a
pure reading of the SGF and has no notion of a user, while `session` knows
about guesses and scoring but not about SGF syntax. Anything that needs both
belongs in `session`.

## 2. Reuse from kifu

The sibling project [kifu](https://github.com/hyponymous/kifu) has already
solved two of the problems here. What we take, and how:

**`sgf-parser.ts` — a clean lift.** `parse(src): GameTree[]` handles the
escaping rules, nested variations, and collections. No changes anticipated.
Its tests come along with it.

**`goban.ts` — an adaptation, not a lift.** kifu renders from a game *tree*
and computes a cropped viewport around the stones, which is right for
sharing a diagram and wrong for us: we render an arbitrary mid-game
position, always at full board size, with markers overlaid on top. The star
points, stone drawing, and coordinate labels are worth keeping; the
tree-driven entry point and viewport logic are not. Budget a rewrite that
borrows, rather than a patch.

**`replayMain()` — informative, but not what we need.** It replays a whole
game to a final position, which is a different operation from stepping one
move at a time. More importantly it has no ko state and does not reject
suicide: it places the stone and then checks only for *opponent* captures,
so a self-capture leaves a dead group on the board. That is invisible when
rendering a static diagram of a legal game record, and unacceptable here,
where a user clicks an arbitrary point and we must decide whether the move
is legal. The rules engine is new code.

### Toward a shared package

We copy and adapt for now, because extracting a package before either
consumer has settled would be premature. But the intent is a shared package
eventually, so the cost of deferring it should be paid down as we go rather
than reconstructed from memory later:

- Every vendored file carries a header comment naming its upstream origin.
- `docs/reuse-notes.md` records each divergence as it is made, with the
  reason, plus anything that looks like a natural package boundary.

The likely package contents are the parser, the rules engine, and a board
renderer general enough for both consumers — which is to say the renderer
divergences are the ones worth documenting most carefully.

## 3. Testing

Tests cover the **rules engine** and the **session logic**. Both are places
where a bug is invisible to manual testing: an illegal move accepted in an
obscure ko, or a guess scored against the wrong move, looks exactly like
correct behavior on screen. The views are verified by hand.

Two kinds of rules test:

- **Unit tests** on constructed positions: captures, multi-group captures,
  snapback, ko, suicide, edge and corner cases.
- **A corpus check** replaying real game records move-by-move and comparing
  the final position against kifu's whole-game `replayMain()`. Any
  disagreement is a bug in one of the two implementations, and finding out
  which is time well spent either way.

Session tests cover scoring, advancing, handicap starts, and game end.

## 4. Deployment

GitHub Pages, as kifu does. A placeholder page gets deployed early —
before there is an app worth looking at — so that base-path and build
configuration problems surface while they are cheap to fix, rather than
during the first real release.

## 5. Risks

- **Rules correctness.** Ko and suicide are where naive implementations
  break, and a bug here silently corrupts every score the tool reports. The
  corpus check is the main defense.
- **Renderer adaptation is larger than it looks.** Unpicking the viewport
  cropping and the tree-driven API is most of the work of writing a renderer
  from scratch. Estimating it as "copy and tweak" is the trap.
- **SGF in the wild.** Rectangular `SZ`, `AE`, multi-game collections,
  vendor-specific properties, passes encoded as `tt`. Real records from a
  public archive are the only honest test.
- **Scope creep from PRD §8.** Time settings and top-N guesses are the
  tempting ones. Both are cheap *after* the loop exists and expensive
  before, because both change the shape of the guess record.
