# mem-sync for Claude Code

mem-sync shares [claude-mem](https://github.com/thedotmack/claude-mem) memory across a team.
Each teammate's Claude Code notes about a shared project sync through a hub, so everyone's
Claude starts with what the team already learned. Hosted hubs: https://getmemsync.com

## Install

In Claude Code (terminal, or the Code tab of the desktop app):

```
/plugin marketplace add thedotmack/claude-mem
/plugin marketplace add devplusopsllc/mem-sync-plugin
/plugin install mem-sync@devplusopsllc
```

From a terminal instead: `claude plugin marketplace add devplusopsllc/mem-sync-plugin`, then
`claude plugin install mem-sync@devplusopsllc --scope user`.

Needs Node.js 18 or newer and [Bun](https://bun.sh). If Bun is missing, the first session
shows the command that installs it. mem-sync never installs it by itself: run the command
yourself, or ask Claude to run it (you approve it like any other command).

## Connect

Ask Claude: "connect mem-sync to https://<team>.getmemsync.com". A browser tab opens:
paste a machine key from the portal, or sign in with Cloudflare if your team uses it.
Claude never sees or handles the key. Then link a folder to a shared space on the
settings page (http://127.0.0.1:37778) or ask Claude to do it.

Skills in `skills/` help Claude catch up on the team's work, answer "why did we...",
share a decision when you agree, set mem-sync up, and (for hub admins) manage people
and access.

## What it runs and where data goes

**Hooks.** Each runs `node hooks/kick.mjs` and finishes within a few seconds. None of
them installs anything or opens your browser.

- **SessionStart** starts the local agent if it isn't running, or replaces an agent
  from an older version of this plugin. It only stops a process on port 37778 that it
  can confirm is mem-sync's agent; otherwise it leaves it running and tells you. It
  then asks the agent to sync, and shows a notice if sync needs attention (sign-in,
  missing Bun or claude-mem, and so on).
- **UserPromptSubmit** checks the agent's health, shows the same notices (at most
  every 30 minutes), and sends this folder's git branch, short commit and `origin`
  URL (with any credentials removed) to the local agent. It reads them with `git` in
  your folder. It never sends your prompt anywhere.
- **SessionEnd** does what SessionStart does, without notices: it keeps the agent
  running and asks it to sync once more.

**The local agent** runs with Bun on 127.0.0.1:37778, on this machine only. It reads
claude-mem's database (`~/.claude-mem/claude-mem.db`), imports teammates' notes through
claude-mem's local API (127.0.0.1:37777), and keeps its own files in `~/.mem-sync`
(settings, including your key, in `config.json`; a sync ledger; a log). On macOS and
Linux the folder is mode 700 and `config.json` mode 600.
The mem-sync-ui part adds the status line, the `/mem-sync` panel and Claude's mem-sync
tools. At session start it fetches the project's team standards from your hub and
adds them to the session as one note.

**What goes to the hub.** Only folders you link, and only to the hub you linked them
to. For those folders the agent sends claude-mem's note and summary fields, plus the
git remote, branch, commit and pull request they came from (you can turn git details
off per folder). The text of your prompts is blanked before sending, but claude-mem's
summaries paraphrase what you asked for, so a summary can describe your request. Raw
tool output and file contents are not sent unless claude-mem quoted them in a note.
Folders you don't link never leave your machine.

**Other destinations.**

- **bun.sh**, only if you install Bun with the command mem-sync shows.
- **GitHub releases**, only for hubs behind Cloudflare Access: the agent downloads a
  pinned version of `cloudflared` once into `~/.mem-sync/bin`, unless it is already
  on your PATH, and checks it against a pinned SHA-256.
- **The `gh` CLI**, if installed and signed in: for linked folders whose `origin` is
  on github.com, the agent runs `gh pr view` to get the number, state and URL of the
  pull request for your branch, using your own `gh` login.
- **Anthropic**, only when someone uses Ask: the hub sends the question and the team
  notes that relate to it to Anthropic for the answer. In Claude Code, the `ask`
  tool asks you once per session before the first question goes out.

Your browser opens only when you or Claude ask for it: connecting a hub, the sign-in,
the settings page, or the `/mem-sync` panel's buttons.

## Privacy, security and support

- Privacy: https://getmemsync.com/privacy
- Security: https://getmemsync.com/security
- Support: support@getmemsync.com

This repository is published from DevPlusOps' source under the Apache License 2.0
(see `LICENSE`). The hosted hub is a separate service and is not part of this repository.
