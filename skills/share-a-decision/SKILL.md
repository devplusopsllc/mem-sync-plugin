---
name: share-a-decision
description: Use when a decision gets made, an approach is ruled out, a dead end or gotcha is found, or the person says "remember this for the team" in a project shared through mem-sync.
---

# Share a decision with the team

Teammates' Claude sessions learn from shared notes. A short note about a
decision or a dead end saves the next person from redoing the work.

## When to offer

- A choice was made between options ("we'll use X, not Y, because...").
- Something was tried and failed, and the reason is not obvious from the code.
- A gotcha that cost real time: a config quirk, an API limit, a flaky test.

Offer once, in one line: "Want me to save this for the team?" Don't save
anything unless the person agrees. Don't offer for routine edits.

## Writing the note

- Title: one line that someone would search for ("Chose Postgres over
  SQLite for the hub").
- Body: what was decided, why, what was ruled out and why. Three to six
  sentences. Name the files it is about.
- Leave out secrets, keys, customer data and personal details. If the
  context holds any, write around them or ask the person what to leave out.

## Saving it

- Where `save_note` is available (the claude.ai connector), call it with the
  space, title, body, `type` (`decision`, or `discovery` for a dead end) and
  the files. Show the person the title and body first.
- In Claude Code with mem-sync, claude-mem records the session's notes and
  mem-sync shares them from linked folders on the next sync. Make sure the
  decision and its reason are stated clearly in the conversation, then call
  `sync_now` if the person wants it shared right away.
- If the folder isn't linked to a space, nothing is shared. Say so and offer
  the setup skill.
