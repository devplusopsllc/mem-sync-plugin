---
name: setup
description: Use when the person wants to connect mem-sync to a team hub, link a folder to a shared space, pause or stop sharing a folder, or fix "mem-sync needs re-authentication" or "agent isn't running".
---

# Set up mem-sync

mem-sync runs a small agent on this machine (http://127.0.0.1:37778). It
syncs notes from linked folders to the team's hub.

## Check first

Call `status`. It shows the hubs, whether this machine is signed in, and each
folder's link. Read it before changing anything.

## Connect a hub

1. Get the hub URL from the person, for example `https://<team>.getmemsync.com`.
   Only `https://` hubs are accepted, except `http://localhost` and
   `http://127.0.0.1` for testing.
2. Call `connect_hub` with that URL. The person approves it first.
   - A hub that uses API keys opens mem-sync's local settings page in the
     browser. The person pastes their key there and presses Connect.
   - A hub with Cloudflare sign-in opens its sign-in page.
3. Never ask for, accept, repeat or store an API key in the chat. If the
   person pastes one, tell them to treat it as exposed, revoke it in the
   portal, and use the settings page instead.

## Link a folder

1. Call `spaces` to list the shared spaces this person can reach.
2. Ask which space the folder belongs to, then call `link_folder`. The person
   approves it. From then on the folder's notes sync with everyone in that space.
3. `set_folder_sync` pauses or resumes a folder, or turns off sharing its
   branch, commit and PR. `never_share_folder` keeps a folder private for good.
   `unlink_folder` stops sharing it.

## Fixing problems

- "needs re-authentication": call `open` with `signin`, or give the person the
  sign-in link from the notice.
- "agent isn't running": start a new Claude Code session. If the notice says
  Bun is missing, show the install command from the notice. Run it only if
  the person asks you to.
- Anything else: `open` with `web` shows the settings page with details.
