# lituus — Product Requirements: Move Selection

**Status:** draft · not started
**Last updated:** 2026-08-20

Which moves a session asks about. The proof of concept prompts on every move
of the chosen color ([PoC PRD](prd-proof-of-concept.md) §4.2); this phase makes
that one option among several.

Nothing here blocks the post-playthrough polish. It is written now because the
idea arrived with the playthrough, and because two of its consequences —
scoring comparability and criterion leakage — are easier to design for than to
retrofit.

## 1. Problem

A 200-move game gives each side about a hundred prompts. Two separate
complaints hide inside that number, and conflating them leads to the wrong fix.

**Length.** A hundred predictions is a long sitting, and knowing that in
advance is a reason not to start. Sessions should be able to be short.

**Density.** Not every move is worth predicting. Answering an atari, following
a joseki to its known end, filling a dame — these are near-forced, and finding
them proves little. The moves that teach are the ones with a real choice in
them, and they are a minority.

Sampling at random fixes length only. It shortens the session while leaving the
ratio of interesting to obvious moves exactly where it was.

## 2. Goals

- Let a user run a meaningfully shorter session on the same record.
- Let a user aim a session at a phase or a region of the game they want to work
  on.
- Keep a sampled session feeling like one game rather than a slideshow of
  unrelated positions.
- Make it clear, in the summary and in any stored result, which selection
  produced a score.

### Non-goals

- Engine integration. AI-driven selection is described here so the interface
  can accommodate it, but it depends on work that is out of scope (PoC PRD §7).
- Difficulty rating or adaptive selection that responds to how the user is
  doing.
- Persistence. Storing results is its own decision; see §7.

## 3. Selection modes

A ladder, cheapest first. Each is a filter over the moves of the chosen color.

| Mode | Selects | Needs | Leaks |
| --- | --- | --- | --- |
| Full | every move | — | no |
| Range | a phase, or an explicit move range | — | no |
| Every Nth | one move in N | — | no |
| Runs | blocks of *k* consecutive prompts | — | no |
| Commented | moves the record annotates (`C`) | a commented record | yes |
| Engine | moves meeting a criterion | an engine | yes |

**Full** stays the default. Sampling should be something a user opts into, not
a change that happens to them.

**Range** is the most useful cheap mode. Players describe their weaknesses by
phase — a bad opening, an endgame that leaks points — and the summary already
reports hit rate by phase, so a poor phase score has an obvious next action.

**Runs** matter more than the count suggests. Predicting move 87 having watched
the game arrive there is not the same task as being dropped into move 87 cold;
the second is harder in a way that has little to do with reading, and it loses
the thread that makes a sequence satisfying. Sampling blocks of consecutive
prompts keeps local continuity while skipping whole stretches.

**Commented** is free curation. A commented professional record is already
marked up by someone who decided which moves were worth discussing, and the PoC
ignores `C` entirely. No engine required.

**Engine** selection — score swing, position entropy, moves where the played
move surprised the engine — is the most powerful and the furthest away.

## 4. Criterion leakage

Every selection method that is worth using tells the user something.

Being asked about a move implies the move was chosen, and *why* it was chosen
is often part of the answer. "The commentator discussed this position" narrows
it. "A large swing is available here" is half the read. Range and every-Nth do
not leak, and they are also the least discriminating; the useful selectors leak
by construction.

This is not a bug to be fixed so much as a fork to be taken deliberately:

- **Keep the leak.** Accept that curated selection changes the exercise from
  "follow this game" to "here is a moment that mattered — what would you play?"
  That is a legitimate exercise, closer to a tsumego set than to a game replay,
  and arguably a better one. It should be named as a different thing rather
  than presented as a filter.
- **Dilute it.** Mix unselected moves in with the chosen ones, so being asked
  carries less information. Costs the length benefit in proportion.
- **Hide the criterion.** Tell the user how many moves, not why those. Weak:
  users will infer it, and a tool that is coy about its own behavior is worse
  than one that leaks.

Recommendation: keep the leak, and name curated modes for what they are.

## 5. Continuity

Skipped moves must still be seen. A board that teleports between prompts asks
the user to re-read a position they never watched develop.

Play the skipped moves out on the board before the next prompt, quickly —
fast enough not to be a wait, slow enough to follow. The stone animation
already exists; this needs sequencing and a rate. A run of forty skipped moves
should probably compress rather than take forty beats.

## 6. Scoring

**A hit rate belongs to its selection.** Twelve of twenty on engine-selected
critical moments and twelve of twenty on every second move are different
achievements, and nothing in the summary should invite comparing them.

The selection mode and its parameters are part of the result. They belong in
the summary, in both exports, and in the root comment of the annotated SGF.

This is the same shape of problem as the replay flag, and both should be
solved once: a result carries the conditions that produced it.

## 7. Interactions

**Streaks** thin out under sampling, and a run of three non-adjacent
predictions is not the thing that felt good in the first place. Another
argument for runs over singles.

**Phase breakdown** gets noisy at low counts. Either suppress a phase below
some minimum, or say how few moves it rests on.

**Tenuki stats** are unaffected. The reference point is the preceding move in
the record, which exists whether or not it was prompted.

**Annotated SGF** stays correct without changes: unprompted moves have no
guess, so they grow no variation.

**Persistence** is a separate decision (PoC PRD §4.6 rules out browser storage,
and that document is closed). If results are ever stored, §6 is a precondition.

## 8. Open questions

- Where does selection get chosen — alongside color at setup, or as a mode
  before it?
- What is a good default length once sampling exists? Twenty prompts? Thirty?
  It should be tested rather than picked.
- Should the user set a target length and let the tool derive the selection,
  rather than choosing a mode and discovering the length? That framing is
  friendlier but needs a sense of pace, which means timing moves first.
- Does a commented-record mode need a fallback when the record has no comments,
  or should it simply be unavailable?
