# lituus

A static site for studying Go (weiqi/baduk) game records by prediction.

Load an SGF, pick a color, and step through the game. At each of that color's
moves the board pauses and you guess where the move was played. The site
reveals the answer, scores the guess, and moves on.

The premise: passively replaying a pro game teaches much less than committing
to a guess first. Being wrong — and noticing *how* wrong — is the lesson.

**Live:** https://hyponymous.github.io/lituus/

> **Status: in development.** The SGF parser, rules engine, and board renderer
> are built and tested; the prediction loop is not there yet. The deployed page
> is a placeholder.

## The name

A *lituus* is the curved staff a Roman augur carried, used to mark out the
field of sky they watched for signs. The tool is a training manual for
augurs — you are reading a board for what comes next.

## Development

Requires Node 24 or later, which strips TypeScript types natively, so tests run
with no loader hook and no flags. There are no runtime dependencies.

```sh
npm install
npm run dev        # Vite dev server
npm run build      # production build to dist/
npm test           # Node test runner
npm run typecheck  # tsc --noEmit
```

Because Node's resolver needs explicit extensions, relative imports carry
them (`./rules.ts`), enabled by `allowImportingTsExtensions`.

## Layout

| Path | Contents |
| --- | --- |
| `src/` | Application source, and the Vite root. |
| `test/` | Node test runner suites, plus SGF fixtures. |
| `docs/` | Product and engineering documents. |

The modules, bottom-up: `sgf-parser` (SGF text to game trees), `rules`
(positions, captures, ko, suicide, legality), `goban` (renders a position to
SVG and reports clicks), then the game model, session logic, and views.

## Documents

- [`docs/prd-proof-of-concept.md`](docs/prd-proof-of-concept.md) — what the
  proof of concept does. §8 catalogues deliberately deferred features.
- [`docs/design-proof-of-concept.md`](docs/design-proof-of-concept.md) — how it
  gets built: layering, reuse, testing, deployment, risks.
- [`docs/reuse-notes.md`](docs/reuse-notes.md) — divergences from kifu,
  recorded as they are made.

## Relationship to kifu

[kifu](https://github.com/hyponymous/kifu) is a sibling project for sharing
static SGF diagrams. lituus vendors its SGF parser and adapts its board
renderer, with the intent of extracting a shared package once both consumers
have settled. Every vendored file names its origin in a header comment, and
`docs/reuse-notes.md` records each divergence and the reason for it.

kifu's `replayMain()` is *not* reused: it replays a whole game to a final
position, has no ko state, and does not reject suicide. That is fine for
rendering a static diagram of a legal record and unacceptable here, where a
user clicks an arbitrary point and the site must judge it. The rules engine is
new code, checked against kifu on real games as a cross-implementation test.
