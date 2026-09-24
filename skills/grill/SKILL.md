---
name: grill
description: Interrogate a plan, decision, or vague request until the design is actually settled — as rounds of numbered questions on a board the human clicks through, each question carrying your recommended answer. Use when scoping work, stress-testing a plan, or when a request is underspecified and guessing would be expensive.
---

# grill — settle the design before writing code

Interview the human until you reach a shared understanding. Map the work as a **design tree**: every decision branches into the decisions that hang off it.

The method is [mattpocock/skills `grilling`](https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md). What this skill adds is the transport: rounds are **board versions**, answers are **structured data**, and the decision tree survives as an immutable history instead of scrollback.

## When to grill

- A request is underspecified and guessing costs more than asking.
- A plan has branch points whose answers change what you build.
- You are about to write code whose shape depends on a preference you have not heard.

Do **not** grill a question with one defensible answer. Make the call, state the assumption, move.

## The frontier

The **frontier** is every decision whose prerequisites are already settled — the questions you can ask *now* without guessing at answers you have not heard yet.

1. Ask the **whole frontier** in one round. Not one question at a time.
2. A question whose answer depends on another question open in this round belongs to a **later** round.
3. Each round's answers reshape the tree: settled decisions push the frontier outward.
4. The session ends when the frontier is empty. **Do not act until the human confirms the shared understanding.**

**Finding facts is your job, never the human's.** When a frontier question needs a fact about the environment — an API's real response shape, what a config file already contains, whether a route exists — go get it. Dispatch a subagent, read the code, call the API. Never ask the human something you could look up.

Do not block on that fact-finding: a running exploration is an unsettled prerequisite, so only the questions *downstream* of it wait. Ask the rest of the frontier now.

**Every question carries your recommended answer.** This is not optional and it is not hedging. A recommendation gives the human something to push against, which is faster for them than an open prompt and more informative for you — the disagreements are the signal. If you cannot recommend, you have not researched enough to ask yet.

## The loop

1. **Get a board.** `board_status`; if nothing is up, start a session board (`board up` — the D21 default). Chat rounds are the fallback when that fails, and they forfeit click-to-choose.
2. **Declare where the outcome will land** before round 1 (see *Durable outcomes*).
3. **Publish round N** as an html board built from `skills/templates/grill-round.html`.
4. **Hand over the link** and say what you will do while you wait.
5. **Keep working.** Poll only when genuinely blocked — read feedback via `board_get_comments` with a `since` cursor, exactly as the `board` skill prescribes.
6. **Recompute the frontier** from the answers. Publish round N+1 as a new version of the *same* board.
7. **When the frontier is empty**, post the shared understanding as a comment, ask for confirmation, then build.

One grilling is one board. Rounds are versions of it, so the whole tree reads top to bottom in the version history.

## Question types

Six. Do not invent a seventh without a board that needs it.

| Type | Use for | Answer shape |
|---|---|---|
| `pick_one` | mutually exclusive options | `"B"` |
| `pick_many` | independent choices | `["A", "C"]` |
| `confirm` | a yes/no gate | `true` |
| `rank` | ordering priorities | `["C", "A", "B"]` |
| `ask_text` | anything unlisted | `"free text"` |
| `ask_image` | a screenshot or diagram | `{asset_id}` |

Every question also gets a **visible** free-text note field. Not collapsed, not behind a disclosure triangle — the note is where the human tells you the option list itself was wrong, which is the most valuable answer they can give.

## Writing a good round

- **Number the questions** and keep numbering across rounds. Q7 in round 2 is never also Q7 in round 3.
- **Give each option a one-line consequence**, not just a label. "Fastest, accepts NAR-1863 as a documented exposure" beats "use it now."
- **Lead with what is settled.** Open each round after the first with the decisions already made, so nothing is silently re-litigated.
- **Say what changed your mind.** If research moved your recommendation between rounds, show the evidence — the table that moved it, not the conclusion alone.
- **Three to six questions per round.** More is a wall; fewer usually means the frontier was computed too narrowly.

## Building the board

Start from `skills/templates/grill-round.html`. Its header documents the question schema and the one function you fill in.

The template is the single place the answer-submission call lives. **Do not hand-roll that fetch in a board**, even when it looks like three lines — when the narrow answer channel lands (NAR-1862), one file changes instead of every board any agent ever published.

Two rules that are easy to get wrong, both learned the hard way:

- **Scope every CSS rule under `#grill`.** Board html mounts into the host document with no iframe (D18), so a bare `body`, `h1`, `*` or `:root` rule restyles the board app itself. A stray `body { max-width: 760px }` once shrank the host's content column from 1169px to 312px.
- **Never invent asset ids.** Images come from `board_upload_image`; reference exactly what it returns.

## Reading answers

Answers arrive as one comment per round, carrying JSON:

```json
{"round": 2, "answers": {
  "askfile": {"chose": "A", "agreed_with_recommendation": true, "note": "just drop it for now"}}}
```

Read `note` even when `chose` matches your recommendation — agreement plus a caveat is common, and the caveat is usually the part that changes the build. Read the whole comment, not just the JSON: a human who cannot find the submit button will file a separate comment as insurance, and that comment is real feedback about your UI.

## Durable outcomes

A board is a vehicle, never a home (D6). Before round 1, say where the settled design will land; before the board closes, put it there.

**You decide where.** Suggest, then commit to one:

- architecture or a deviation from plan → `docs/decisions.md`
- a scoping session with no obvious home → `docs/decisions_{board_id}.md`
- product scope, *when the project already uses an issue tracker* — never assume one exists

If closing the board would destroy the only copy of a decision, the grilling is not finished.
