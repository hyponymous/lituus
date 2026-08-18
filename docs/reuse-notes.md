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

### Vite config: no dev middleware

**kifu:** a custom Vite plugin serves `dev/` HTML tools and `fixtures/` under
the base path.

**lituus:** no plugin. Just `root`, `base`, and `build.outDir`.

**Why:** neither a `dev/` tools directory nor image fixtures exist here. Add
the middleware back if and when they do; it is unrelated to any shared code.

**At extraction:** not applicable — build config is per-project.

## Candidate package contents

- `sgf-parser` — the strongest candidate. Pure, no DOM, already stable.
- `rules` — new code in lituus, but general. kifu's `replayMain()` could
  be rebuilt on top of it, gaining ko and suicide handling it currently
  lacks.
- `goban` — the renderer. Most valuable to share and hardest to generalize,
  since kifu crops to a viewport and lituus never does. The divergences
  here are the ones to document most carefully.
