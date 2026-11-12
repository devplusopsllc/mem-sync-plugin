# mem-sync-ui

mem-sync inside Claude Code. Installed with mem-sync (it is a dependency);
see the [main README](../README.md#in-claude-code) for what it shows.

- `hooks/register.tsx`: the hooks module. It reads and changes sync state only
  through the local agent API (`http://127.0.0.1:37778/local/...`), the same
  calls the agent's web page (`agent/ui/app.js`) makes.
- `types/index.d.ts`: the shapes it keeps in session state.
- `tests/`: run with `claude plugin test mem-sync-ui` from the repo root
  (`bun test` skips this folder; see `bunfig.toml`).

Claude's tools (`mcp__mem-sync-ui__<name>`) cover what the agent's web page and
the hub admin page do, so nobody has to open either:

- Everyone: `status`, `spaces`, `sync_now`, `open`, `link_folder`,
  `unlink_folder`, `set_folder_sync` (pause/resume), `never_share_folder`,
  `connect_hub` (Cloudflare sign-in only), `recent` (what teammates did lately
  in this folder's space, by person) and `ask` (a question answered from the
  space's notes, with sources; needs `ANTHROPIC_API_KEY` on the hub, which
  sends the question and the related notes to Anthropic). The last two are
  read only and say so in plain text when the folder isn't linked.
- Hub admins: `users`, `grant_access`, `revoke_access`, `create_project`,
  `rename_project`, `create_space`, `edit_space` (rename, archive, main),
  `move_space` (previews who loses access; moves only with `confirm`),
  `add_user`, `edit_user` (role, disable).

Every tool that changes something asks the person first; the questions for
`unlink_folder`, `never_share_folder`, `revoke_access` and `edit_user` say
what is lost. `ask` asks once per session before the first question goes to
Anthropic. `status`, `spaces`, `sync_now`, `open`, `users` and `recent` run
without asking. Tools have no MCP `title` or annotations: `$.tool.register`
takes only a name, description, input schema and `isDeferred`. Admin tools refuse a
member before calling the hub, and the hub refuses them anyway. Claude never
sees or handles API keys: `users` drops key fields, and there are no key tools.

For a hub admin, the `/mem-sync` panel also has an Admin section: create a
project, create a space under a project, and open the hub admin page. Members
don't see it, and the hub refuses those calls from anyone but an admin.

From 0.6.0 it also delivers the project's **team standards** to each session in
a linked folder, as one note posted at session start (`session.append`, the
`note` door). It does not use `prompt.compose`: Claude Code's built-in security
default forwards that event past the user tier, so a user-installed plugin's
section is dropped before it is added; the same default lets a user-tier plugin's
`session.append` through, so the standards ride that. Admins write them in the
hub admin UI. Only the folder's current space is used, and the note is posted
once at session start (admin edits mid-session land next session). A session
that starts while the hub can't be reached gets no note; a hub older than 0.6.0,
an unlinked folder, or lost access gets none. Delivery never fails the session.
See [Team standards](../README.md#team-standards).

While working on it, load your checkout instead of the installed copy:
`claude --plugin-dir mem-sync-ui`.
