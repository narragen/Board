---
name: interview
description: Interview the human until the design is settled — rounds of numbered questions on a board they click through, each question carrying your recommended answer. Use when scoping work, stress-testing a plan, or when a request is underspecified and guessing would be expensive.
---

# interview — settle the design before you write code

Ask questions until you and the human actually agree on what to build. Map the work as a **decision tree**: every decision branches into the decisions that hang off it.

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

**Finding facts is your job, never the human's.** When a question needs a fact about the environment — an API's real response shape, what a config file already contains, whether a route exists — go get it. Read the code, call the API, dispatch a subagent. Never ask a human something you could look up.

Don't block on that digging, though. A running investigation is an unsettled prerequisite, so only the questions *downstream* of it wait. Ask the rest of the frontier now.

**Every question carries your recommended answer.** This is not optional and it is not hedging. A recommendation gives the human something to push against, which is faster for them than a blank prompt and more informative for you — the disagreements are the signal. If you cannot recommend, you have not researched enough to ask yet.

## The loop

1. **Get a board.** `board_status`; if nothing is up, start a session board (`board up` — the D21 default). Chat rounds are the fallback when that fails, and they cost you click-to-choose.
2. **Say where the outcome will land** before round 1 (see *Where the answers end up*).
3. **Publish round N** as an html board built from `skills/templates/interview-round.html`.
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

- **Write for someone who just switched gears.** They have not been reading what you have been reading. Name the subject in plain language before any internal term shows up; define any term they cannot be assumed to know, in-line, on first use.
- **Number the questions** and keep numbering across rounds. Q7 in round 2 is never also Q7 in round 3.
- **Give each option a one-line consequence**, not just a label. "Fastest, and accepts NAR-1863 as a documented exposure" beats "use it now."
- **Lead with what is settled.** Open every round after the first with the decisions already made (`SETTLED` in the template), so nothing gets silently re-litigated.
- **Say what changed your mind.** If research moved your recommendation between rounds, show the evidence that moved it, not just the new conclusion.
- **Draw the thing.** If answering a question means holding a picture in your head, put the picture in the question — a table of options against criteria, a diagram of the two topologies, ten lines of pseudocode for the contract. `board` skill → *"Reach for a picture"* has what renders where.
- **Three to six questions per round.** More is a wall; fewer usually means you computed the frontier too narrowly.

## Building the board

Start from `skills/templates/interview-round.html`. Fill in its CONFIG block — board id, round number, and the `QUESTIONS` array. That is the whole job; everything else renders itself.

Two things the template is doing for you, so you don't have to:

- **Styling.** The board app styles `<div class="board-ui">` with its own theme tokens, dark mode included. Write semantic HTML inside it and it looks right. Only add a `<style>` block to override something, and scope every rule you add to your own wrapper id — an html board mounts into the host page with no iframe (D18), so a bare `body`, `h1` or `:root` rule restyles the board app itself.
- **The submit call.** It lives in that one file. **Do not hand-roll that fetch in a board**, even when it looks like three lines — when the narrow answer channel lands (NAR-1862), one file changes instead of every board any agent ever published.

Never invent asset ids. Images come from `board_upload_image`; reference exactly what it returns.

## Reading the answers

They arrive as one comment per round, carrying JSON:

```json
{"round": 2, "answers": {
  "askfile": {"chose": "A", "note": "just drop it for now"}}}
```

- **Compare against your own recommendation yourself.** The board does not tell you whether the human agreed, because you already know what you recommended. Where they overruled you is the most informative part of the round — read for it deliberately.
- **Read `note` even when `chose` matches your recommendation.** Agreement plus a caveat is common, and the caveat is usually the part that changes the build.
- **Read the whole comment, not just the JSON.** A human who cannot work out how to submit will file a separate comment as insurance, and that comment is real feedback about the page you built.

## Where the answers end up

A board is a vehicle, never a home (D6). Before round 1, say where the settled design will land; before the board closes, put it there.

**You decide where.** Suggest, then commit to one:

- architecture, or a deviation from plan → `docs/decisions.md`
- a scoping session with no obvious home → `docs/decisions_{board_id}.md`
- product scope, *when the project already uses an issue tracker* — never assume one exists

If closing the board would destroy the only copy of a decision, the interview is not finished.
