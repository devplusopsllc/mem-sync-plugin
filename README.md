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

Needs [Bun](https://bun.sh) (the plugin offers to install it) and Node.js 18 or newer.

## Connect

Ask Claude: "connect mem-sync to https://<team>.getmemsync.com". A browser tab opens:
paste a machine key from the portal, or sign in with Cloudflare if your team uses it.
Then link a folder to a shared space on the settings page (http://127.0.0.1:37778) or
ask Claude to do it.

## What leaves your machine

Only notes from folders you link, and only to the hub they are linked to. Your prompts,
raw tool output and file contents stay on your machine. Details:
https://getmemsync.com/security

This repository is published from DevPlusOps' source; please report issues to
support via https://getmemsync.com.
