# lituus — Product Requirements: Proof of Concept

Scope is the initial proof of concept only. Later phases — AI scoring,
predict-vs-AI, sharing — get their own PRDs; §7 here is a sketch, not a spec.

**Status:** draft · proof of concept
**Last updated:** 2026-08-17

## 1. Summary

`lituus` is a static site for studying Go (weiqi/baduk) game records by
prediction. The user loads an SGF, picks a color, and steps through the game.
At each of that color's moves the board pauses and the user guesses where the
move was played. The site reveals the answer, scores the guess, and moves on.

The premise: passively replaying a pro game teaches much less than committing
to a guess first. Being wrong — and noticing *how* wrong — is the lesson.

Two modes are envisioned. Only the first is in scope for the PoC:

1. **Predict-only** — score against what was actually played. (This document.)
2. **Predict-vs-AI** — score against an engine's evaluation, so a good move
   that wasn't the played move still gets credit. (Sketched in §7.)

## 2. Goals and non-goals

### Goals

- Load an arbitrary SGF and run a prediction session over its main line.
- Make the predict → reveal → advance loop fast enough to sustain a full
  game (200+ moves) without friction.
- Give the user an honest, legible score at the end of the session.
- Stay a static site: no server, no accounts, no stored user data.

### Non-goals (PoC)

- Full SGF editing, variation trees, or game annotation.
- Accounts, cloud sync, leaderboards, or social features.
- Mobile-first design. It should not be *broken* on a phone, but the target
  is a desktop browser with a mouse.
- Tsumego, endgame counting, or any study mode that isn't move prediction.

Features that are plainly in the product's direction but deliberately held
back — alternate answer mechanics, richer scoring, sharing — are catalogued
with their reasoning in §8.

## 3. Users

The intended user is an amateur player (roughly 15k–3d) who already reviews
pro games and wants a more active way to do it. They can read an SGF file,
know what a joseki is, and are comfortable being told they're wrong.

Secondary: a stronger player using it as a self-assessment tool — "how often
do I find the professional move in this opening?"

## 4. Core user flow

```
load SGF → choose color → [predict → reveal → advance]* → session summary
```

### 4.1 Loading a game

The user provides an SGF by either:

- **Pasting SGF text** into a text area on the landing view, or
- **Dropping a `.sgf` file** onto the page.

Both paths run through the same parser and produce the same in-memory game.
Parse failures show a human-readable error naming what went wrong and where,
and leave the user on the landing view to try again.

*Deliberately deferred:* URL-fragment encoding (as in `kifu`, §6), a
bundled sample-game library, and fetching by game ID from an
external server. All three are natural follow-ons; none is needed to
validate the core loop.

### 4.2 SGF scope

The PoC handles the **main line only** — the first variation at every branch
point. Alternate variations are parsed (so the file loads) but not traversed
or offered to the user.

Required support:

- Board size from `SZ` (19×19 primary; 9×9 and 13×13 should work).
- Handicap and setup stones (`HA`, `AB`, `AW`) applied before move 1, so the
  starting position is correct.
- Passes (`B[]` / `W[]`), which are skipped rather than prompted.
- Standard capture and ko rules, so the displayed position is legal and
  correct at every step.

Node comments (`C`) and board markup are ignored in the PoC. Comments are a
likely early addition — they frequently explain the move that was just
revealed — but they are not required for the loop to work.

### 4.3 Choosing a color

After a successful load the user picks **Black** or **White** for the
session. Only that color's moves are prompted; the opponent's moves play
automatically as the session advances. The choice is fixed for the session —
to study the other side, start a new session.

Handicap games start with Black's stones already placed, so a White session
begins at move 1 and a Black session begins at the first Black move after
the handicap placement.

### 4.4 The prediction loop

At each prompted move:

1. The board shows the position immediately before the move. A move counter
   and the color to play are visible.
2. The user **clicks an intersection** to commit a guess. There is no
   confirmation step — the click is the answer. Clicking is only permitted on
   legal points (empty, not suicide, not ko).
3. The site **reveals** the played move immediately:
   - The guess and the actual move are both marked, visually distinct.
   - A hit is stated plainly; a miss shows both points.
4. The user **advances** — by clicking an advance control, or by clicking
   anywhere on the board — and any intervening opponent moves are played out
   before the next prompt.

The loop is mouse-driven end to end. Guessing is inherently a pointing task,
and adding a keyboard path for advancing alone would make the user shuttle
between mouse and keyboard on every move. Keyboard operation is deferred
(§8.1).

### 4.5 Navigation

Navigation is **strictly forward**. There is no stepping back and no undo.
A session is one honest pass through the game; the score means nothing if
the user can retry a move they just saw the answer to.

The user may abandon a session at any time and return to the landing view.
Abandoning discards the session.

### 4.6 Session summary

The session ends when the main line is exhausted, or when the user chooses to
end it early. The summary shows:

- Moves predicted, moves hit, hit rate.
- Hit rate broken down by phase of the game (opening / middle / endgame,
  split by simple move-number thresholds).
- A per-move list: move number, guess, actual, hit or miss.

The summary is **exportable** — the user can copy or download it (JSON, plus
a plain-text form suitable for pasting into notes). Nothing is written to
browser storage; a reload loses the session. Persistence and resumable
sessions are deferred until the loop itself is proven worth returning to.

## 5. Scoring (PoC)

Scoring is **binary exact match**: the guess is a hit if and only if it is
the same intersection as the played move.

This is knowingly harsh. A guess one point away from the played move is
usually a good move and sometimes a better one, and exact match calls it a
total failure. That is acceptable for the PoC precisely because the fix is
the AI layer (§7) rather than a proximity heuristic — board distance is a
poor proxy for move quality, and a "close" score computed from geometry
would teach the wrong lesson.

Recorded per prediction: move number, color, guessed point, actual point,
hit/miss. That record is the input to any later scoring model.

## 6. Interface sketch

Three views:

- **Landing** — paste area / drop target, brief explanation, error surface.
- **Setup** — game metadata from the SGF (players, ranks, date, result,
  handicap, komi), color choice, start control.
- **Session** — board, move counter, color to play, guess/reveal markers,
  running hit count, advance control, end-session control.
- **Summary** — the stats and per-move table from §4.6, export controls, and
  a route back to the landing view.

The board renderer is the one substantial UI component. The sibling project
[kifu](https://github.com/hyponymous/kifu) has an SVG board renderer and a
recursive-descent SGF parser that should be lifted rather than rewritten —
the parser especially, since SGF's escaping rules are fiddly enough to get
wrong twice.

## 7. AI scoring (future direction)

Exact match answers "did you find the move." The more useful question is
"how much did your move cost." That requires an engine.

The intended integration is **KataGo**, which is the tracked next step for
this project. The shape of it:

- For each prompted position, obtain an evaluation of the played move and of
  the user's guessed move — winrate and score lead, ideally with a policy
  prior over candidate moves.
- Grade the guess against the **best available move**, not against the move
  that was played. A guess that beats the professional's move should be
  recognized as beating it, because that is the single most motivating thing
  this tool could ever tell an amateur.

An engine evaluation supports several different feedback signals, and which
one a user finds legible is a matter of taste and strength. Candidates:

- **Point loss** — how many points the guess gave up. Familiar to anyone who
  has used an AI review tool.
- **Winrate delta** — the swing in win probability. More intuitive in close
  or unsettled positions, noisier when the game is already decided.
- **Policy rank** — "the engine's 4th choice." Softer than a number, and
  meaningful even where the top few moves are near-equivalent.
- **Candidate set membership** — whether the guess was among the engine's
  plausible moves at all, without further precision.

None of these is designated as *the* metric. Which to show by default,
whether to show more than one, and whether it should be user-configurable
are open. Session-level aggregation should follow whichever signal is
chosen rather than being decided separately.

Open questions, all unresolved:

- **Where the engine runs.** A static site cannot run KataGo. Options are a
  WASM build in the browser (large download, slow, but preserves the
  no-server property), a self-hosted analysis endpoint (fast, but abandons
  the static-site constraint), or precomputed analysis shipped alongside the
  SGF (fast and static, but only works for games that have been analyzed
  ahead of time). The third is the most promising for a PoC follow-on.
- **Latency budget.** The predict → reveal loop must stay fast. Any engine
  call slower than roughly a second per move breaks the rhythm and probably
  needs to be moved off the critical path — evaluate in the background and
  enrich the session summary rather than blocking the reveal.
- **Which feedback signal.** Per above — point loss, winrate delta, policy
  rank, or candidate-set membership; one, several, or user's choice. Worth
  settling with real users rather than by argument.
- **Predict-vs-AI as a distinct mode.** Whether AI scoring is a toggle on the
  existing mode or a separate mode with its own flow (e.g. predicting the
  engine's move rather than the played move) is not yet decided.

## 8. Deferred features

Everything below is **out of scope for the PoC**. This section is the single
index of deferred work — where an earlier section notes a deferral (§4.2 game
sources, §4.6 persistence, §5 proximity scoring, §7 AI), the entry here is
the canonical one.

These are recorded because each one is a plausible answer to a question the
PoC settles by fiat, and the reasoning for the fiat is worth keeping.

### 8.1 Answer mechanics

- **Top-N guesses.** Let the user name up to three candidate points, scored
  by rank — full credit for a first-choice hit, partial for a third. This is
  closer to how players actually read: a strong player narrows to a handful
  of candidates rather than one point. Deferred because it complicates both
  the input affordance and the scoring model before either is proven.
- **Retry until correct.** Wrong guesses get marked and the user keeps
  guessing until they find the played move. Turns the tool into a puzzle
  rather than an assessment. Interesting as a separate *practice* mode, but
  incompatible with a meaningful hit rate.
- **Confirm step.** Click places a ghost stone the user can drag before
  committing. Reduces misclick frustration; costs an interaction per move,
  which is the wrong trade in a loop repeated 200 times. Revisit if
  misclicks turn out to be common.
- **Quiet feedback.** Not a fully "blind" mode — deferring *all* feedback to
  the summary is impossible, because the played move has to be shown to build
  the position for the next prompt, and a user who remembers their guess has
  therefore been told the answer. What can be withheld is the *verdict*: show
  the played move but drop the hit/miss statement, the guess marker, and the
  running tally, leaving the score for the summary. A modest variation on
  §4.4 rather than a distinct mode.
- **Keyboard operation.** Selecting an intersection with arrow keys is poor
  UX — a 19×19 grid is up to 18 keypresses from the cursor to the target, and
  the user is thinking in board coordinates anyway. **Typing the coordinate**
  (`D4`, `Q16`) is the plausible mechanism, and would suit a user who reads
  and discusses moves by name; it also gives accessibility a path that
  clicking does not. Deferred until the mouse loop is proven, since a
  keyboard path for advancing alone would just make the user shuttle between
  devices (§4.4).
- **Skip / "no idea".** An explicit way to decline a position rather than
  guessing randomly. See §10 — it may be a genuine need or may just be an
  escape hatch that corrupts the score.
- **Time settings.** A per-move time limit; expiry auto-advances to the next
  move and the position scores zero. Adds pressure that resembles playing a
  real game, and stops a session stalling on one hard position. Design notes:
  - A timeout is *not* the same as a wrong guess, and the record should
    distinguish them — "didn't know" and "ran out of time" are different
    diagnoses, and the summary (§4.6) is more useful if it can say which.
  - Sensible controls are a per-move limit and an off switch; a whole-session
    budget (chess-clock style) is a further variation. Byo-yomi is the
    idiomatic Go analogue if this ever wants to feel like real play.
  - This partly subsumes the skip affordance above — running the clock out is
    a way to decline a position — which may resolve the §10 question about
    whether an explicit skip is needed.
  - Timing also yields per-move latency data, which is a plausible input to
    difficulty weighting (§8.3).

### 8.2 Sides and session shape

- **Predict both colors.** Prompt on every move in the record, alternating.
  Doubles the work per game and mixes two quite different skills (finding
  your own move vs. anticipating the opponent's), so the PoC picks one side.
- **Switch color mid-session.** A control to change sides partway, or to
  predict both from a given move onward.
- **Free navigation.** Step backward through the record with already-answered
  moves locked to their first recorded guess — review what happened without
  being able to re-score it. The strictly-forward rule (§4.5) exists to keep
  the score honest, and locked guesses would preserve that; it was dropped
  from the PoC for implementation simplicity, not principle.
- **Re-guessing.** Free navigation *with* overwrite. Rejected rather than
  merely deferred: it makes the score meaningless.
- **Resumable sessions.** Leave a game partway and come back to it, which
  requires the persistence in §8.4.

### 8.3 Scoring models

- **"Right area" credit.** Partial credit for a guess in the same local
  context as the played move — same corner, same group, same fight. Note
  this is *not* the same as board distance: a point two lines from the played
  move can be a different fight entirely, and a point ten lines away can be
  the same large-scale exchange. Doing this properly needs either engine
  analysis or human-labeled regions, which is why §5 declines to approximate
  it with geometry.
- **Difficulty weighting.** Not all moves are equally findable — a forced
  capture and a whole-board strategic choice should not count the same. A
  weighted hit rate needs a difficulty signal, most plausibly the engine's
  policy distribution (a sharply peaked policy means an obvious move).
- **Streaks and per-phase drill-down.** Longest correct streak, or a
  breakdown finer than the opening/middle/endgame split in §4.6.

### 8.4 Game sources and persistence

- **URL-fragment sharing.** Compressed SGF in the fragment, as in `kifu`,
  making a link a shareable study session. The most attractive near-term
  addition, since that encoding is already written and proven (§6).
- **Bundled sample games.** A small set of pro games so there is something to
  do on first load, without hunting for an SGF.
- **Remote fetch.** Load by game ID or URL from a public archive or go server.
- **Multi-game SGF collections.** Pick which game to study rather than
  silently taking the first (§10).
- **Local persistence.** `localStorage` per game: resume partial sessions and
  keep a history to track improvement over time. The PoC exports instead
  (§4.6), on the theory that a tool nobody returns to does not need a
  history.

### 8.5 SGF handling

- **Variation trees.** Navigate branches, with predictions scored against the
  current line. Substantially more UI, and the main line is what a study
  session follows anyway.
- **Comments on reveal.** Show node comments (`C`) after the answer — they
  frequently explain the move that was just played. The cheapest genuinely
  valuable addition on this list.
- **Board markup.** Render `TR`/`SQ`/`CR`/`MA` and friends, which commonly
  accompany commented records.
- **Respect the declared ruleset (`RU`).** Rulesets differ on suicide, on ko
  versus superko, and on scoring. The PoC applies one rule set to every
  record — permissive when replaying, simple ko when judging a guess — which
  is close enough that a normal game never notices. Reading `RU` would make
  legality exactly right for the record in hand.

### 8.6 AI scoring

Covered in full in §7. It is the largest deferred item and the tracked next
step for the project.

## 9. Success criteria

The PoC succeeds if:

- An arbitrary real-world SGF from a public archive loads and runs to
  completion without a parse or rules error.
- A full 19×19 game can be predicted end to end without the interface
  becoming tedious — measured bluntly by whether the author finishes one.
- The score at the end is one the user believes, i.e. no known cases of a
  correct guess being scored as a miss or vice versa.

## 10. Open questions

- Should the opponent's moves animate or appear instantly? Instant is
  faster; animation makes it clearer what changed, especially after a
  capture.
- Should the user see the game result and player names before the session?
  Knowing "Black won by resignation" may bias predictions, but hiding the
  metadata makes the setup view thin.
- What happens on a `.sgf` file containing multiple games (a collection)?
  Simplest answer for the PoC is to take the first and say so.
- Is a "skip this move" affordance needed for positions the user genuinely
  cannot read, or does it just become an escape hatch that corrupts the score?
