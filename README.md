# lituus

**You've replayed dozens of pro games. How many of those moves could you have
found yourself?**

lituus is the uncomfortable way to find out. Load a game record, pick a color,
and at every one of that color's moves the board stops and refuses to go on
until you've committed to a point. Then it shows you what was actually played,
scores you, and moves on.

**Live:** https://hyponymous.github.io/lituus/

> **Status: in development, but the loop works.** Load a record, pick a side,
> predict move by move, read the summary. Still to come: a layout pass, reveal
> timings tuned against a full game, something better than a desktop-only
> pointing interface, and the AI scoring the PRD sketches.

<!-- Screenshots go here: the prompt, and a reveal showing a miss with both
     points marked. Deliberately omitted until they can show the real thing —
     a broken image is worse than none. -->

## Why predict moves?

Replaying a strong player's game is the oldest study method in Go, but it's
easy to get lazy. Moves arrive with authority; each one looks sensible the
moment you see it, and a whole game can slide past while you nod along. Koriat
and Bjork called this an [illusion of
competence](https://bjorklab.psych.ucla.edu/wp-content/uploads/sites/13/2016/07/Koriat_RBjork_2005.pdf):
you judge how well you know something while the answer is sitting in front of
you, and the judgment comes out far too high. A game record mirrors that setup
exactly. Recognizing a good move and finding one are different skills, and it
only ever exercises the first.

Committing to a move first closes that gap. Three findings bear on it:

- **Being wrong still works.** Attempting an answer before you see the solution
  improves retention even when the attempt fails. This is the
  [pretesting effect](https://learninglab.uchicago.edu/Pre-Testing_files/RichlandKornellKao.pdf),
  and the studies establish it by throwing out the trials where people happened
  to guess right.
- **Confident mistakes teach the most.** Errors made with high confidence turn
  out to be the ones most likely to get corrected, apparently because being
  surprised makes you pay attention to the correction. It's called
  [hypercorrection](https://link.springer.com/article/10.3758/s13423-011-0173-y).
  The moves you were certain about and got wrong are worth more than the ones
  you shrugged at.
- **The difficulty is doing the work.** Practice conditions that make you
  slower and more error-prone at the time tend to produce better recall weeks
  later. Bjork named these
  [desirable difficulties](https://www.unh.edu/teaching-learning-resource-hub/sites/default/files/media/2023-06/itow-introducing-desirable-difficulties-into-practice-and-instruction-bjork-and-bjork.pdf).

Chess players have been doing this for decades. Guess-the-move study runs from
Kotov through *Chess Life*'s Solitaire Chess column to
[the version players still practice today](https://www.zwischenzug.gg/p/solitaire-chess).
The usual argument for it is that you can't zone out of a review that keeps
asking you questions. Go has its own replaying tradition, and a few apps offer
a guess-the-move mode.

## What to point it at

Any game record works, and while you can't go wrong with classic pro game
study, other games may teach more or be more fun. Some options:

- **Pick a player a stone or two stronger than you.** Their concepts are only
  slightly more refined than yours, so you can often reconstruct their
  reasoning once you see their move (professional reasoning is often too subtle
  to learn clear lessons from).
- **Your own losses, played from your opponent's side.** Anywhere you're
  surprised is somewhere you got outplayed at the time and didn't notice.
- **A player you enjoy, over several games.** Style is hard to describe and
  easy to feel once you're trying to anticipate it. Shusaku and a modern
  AI-trained player will beat you in different places.
- **The same game, months apart.** A hit rate is crude, but it's a number,
  which is more than a sense of improvement gives you.

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

Because Node's resolver needs explicit extensions, relative imports carry them
(`./rules.ts`), enabled by `allowImportingTsExtensions`.

Source lives in `src/`, which is also the Vite root; tests and SGF fixtures in
`test/`. Bottom-up, the modules are `sgf-parser` (text to game trees), `rules`
(positions, captures, ko, suicide, legality), `goban` (renders a position to
SVG and reports clicks), `game` (a record read as one playable game), and
`session` (the prompt → reveal → advance loop and its scoring).

The rules engine has been checked on real games against an independent
implementation, but could use more testing against unusual edge cases.

## Documents

- [`docs/prd-proof-of-concept.md`](docs/prd-proof-of-concept.md) — what the
  proof of concept does. §8 catalogues deliberately deferred features.
- [`docs/design-proof-of-concept.md`](docs/design-proof-of-concept.md) — how it
  gets built: layering, reuse, testing, deployment, risks.
- [`docs/reuse-notes.md`](docs/reuse-notes.md) — divergences from
  [kifu](https://github.com/hyponymous/kifu), a sibling project for sharing
  static SGF diagrams. lituus borrows its SGF parser and adapts its board
  renderer, with the intent of extracting a shared package once both have
  settled.

## The name

A *lituus* is the curved staff a Roman augur carried, used to mark out the
field of sky they watched for signs. Reading a board for what comes next is
much the same job.
