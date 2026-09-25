---
name: interview
description: Interview the human until the design is settled — rounds of numbered questions on a board they click through, each question carrying your recommended answer. Use when scoping work, stress-testing a plan, or when a request is underspecified and guessing would be expensive.
---

# interview — settle the design before you write code

Ask questions until you and the human agree on what to build. Map the work as a **decision tree**: every decision branches into the ones hanging off it.

The method is [Matt Pocock's `grilling` skill](https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md) — the decision tree, the frontier, and "recommend, don't just ask" are all his. Credit where it's due. What this skill adds is somewhere to put it: rounds become **board versions** the human clicks through, answers come back as **structured data**, and the tree survives as immutable history instead of scrollback.

## When to do this

- The request is underspecified and guessing costs more than asking.
- A plan has branch points whose answers change what you build.
- You are about to write code whose shape depends on a preference you have not heard.

Do **not** interview about a question with one defensible answer. Make the call, say what you assumed, move.

## The frontier

The **frontier** is every decision whose prerequisites are already settled — the questions you can ask *now* without guessing at answers you have not heard yet.

1. Ask the **whole frontier** in one round. Not one question at a time.
2. A question whose answer depends on another question open in this round belongs in a **later** round.
3. Each round's answers reshape the tree: settled decisions push the frontier outward.
4. You are done when the frontier is empty. **Do not start building until the human confirms you have it right.**

**Finding facts is your job, never the human's.** When a question needs a fact about the environment — an API's real response shape, what a config file contains, whether a route exists — go get it. Read the code, call the API, dispatch a subagent. Never ask a human something you could look up.

Don't block on that digging. A running investigation is an unsettled prerequisite, so only the questions *downstream* of it wait; ask the rest of the frontier now.

**Every question carries your recommended answer.** Not optional, and not hedging. A recommendation gives the human something to push against — faster for them than a blank prompt, and more informative for you, because the disagreements are the signal. If you cannot recommend, you have not researched enough to ask yet.

## The loop

1. **Get a board.** `board_status`; if nothing is up, start a session board (`board up` — the D21 default). Chat rounds are the fallback, and they cost you click-to-choose.
2. **Say where the outcome will land** before round 1 (see *Where the answers end up*).
3. **Publish round N** as an html board built from `templates/interview-round.html` (see *Building the board*).
4. **Hand over the link** and say what you will be doing while you wait.
5. **Keep working.** Poll only when genuinely blocked — `board_get_comments` with a `since` cursor, exactly as the `board` skill prescribes.
6. **Recompute the frontier** from the answers. Publish round N+1 as a new version of the *same* board.
7. **When the frontier is empty**, post the shared understanding as a comment, ask for confirmation, then build.

One interview is one board. Rounds are versions of it, so the whole tree reads top to bottom in the version history.

## Question types

Six. Do not invent a seventh without a board that needs it.

| Type | Use for | What comes back |
|---|---|---|
| `pick_one` | mutually exclusive options | `"B"` |
| `pick_many` | independent choices | `["A", "C"]` |
| `confirm` | a yes/no gate | `true` |
| `rank` | ordering priorities | `["C", "A", "B"]` |
| `ask_text` | anything unlisted | `"free text"` |
| `ask_image` | a screenshot or diagram | `{asset_id, filename}` |

Every question also gets a visible free-text note field. The template puts it there for you — it is where the human tells you your option list itself was wrong, which is the most valuable thing they can say.

## Writing a round people can actually answer

- **Write for someone who just switched gears** — the `board` skill's section of that name has the rules; they apply here more than anywhere.
- **Number the questions** and keep numbering across rounds. Q7 in round 2 is never also Q7 in round 3.
- **Give each option a one-line consequence**, not just a label. "Fastest, and accepts NAR-1863 as a documented exposure" beats "use it now."
- **Lead with what is settled.** Open every round after the first with the decisions already made (`SETTLED` in the template), so nothing gets silently re-litigated.
- **Say what changed your mind.** If research moved your recommendation between rounds, show the evidence that moved it, not just the new conclusion.
- **Draw the thing.** If answering means holding a picture in your head, put the picture in the question — options against criteria as a table, the two topologies as a diagram, the contract as ten lines of pseudocode. `board` skill → *"Reach for a picture"* has what renders where.
- **Three to six questions per round.** More is a wall; fewer usually means you computed the frontier too narrowly.

## Building the board

Start from `templates/interview-round.html`, in this skill's own directory: fill in the heading, the intro line, and the `QUESTIONS` array. Everything else renders itself.

It already handles styling — `class="board-ui"` for form chrome plus Tailwind loaded and ready (D28) — and the IIFE your script must live in. The `board` skill has the rules behind both, plus what a diagram or chart needs. If you use Tailwind, take colors from Board's tokens (`bg-[var(--bg-subtle)]`), never from Tailwind's palette.

**The one thing not to work around: the submit call lives in that file.** Do not hand-roll that fetch in a board, even when it looks like three lines — when the narrow answer channel lands (NAR-1862), one file changes instead of every board any agent ever published.

Images come from `board_upload_image`. Never invent an asset id.

## Reading the answers

They arrive as one comment per round, carrying JSON:

```json
{"round": 2, "answers": {
  "askfile": {"chose": "A", "note": "just drop it for now"}}}
```

- **Compare against your recommendation yourself.** The board does not tell you whether the human agreed, because you already know what you recommended. Where they overruled you is the most informative part of the round — read for it deliberately.
- **Read `note` even when `chose` matches.** Agreement plus a caveat is common, and the caveat usually changes the build.
- **Read the whole comment, not just the JSON.** A human who cannot work out how to submit will file a separate comment as insurance, and that comment is real feedback about the page you built.

## Where the answers end up

A board is a vehicle, never a home (D6). Before round 1, say where the settled design will land; before the board closes, put it there.

**You decide where.** Suggest, then commit to one:

- architecture, or a deviation from plan → `docs/decisions.md`
- a scoping session with no obvious home → `docs/decisions_{board_id}.md`
- product scope, *when the project already uses an issue tracker* — never assume one exists

If closing the board would destroy the only copy of a decision, the interview is not finished.
