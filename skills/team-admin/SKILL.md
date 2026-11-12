---
name: team-admin
description: Use when a mem-sync hub admin wants to add or change people, give or take access to projects and spaces, or create, rename, archive or move spaces and projects.
disable-model-invocation: true
---

# Team admin for mem-sync

These tools change who can see the team's notes. Only hub admins can use
them; the hub refuses everyone else. Each change asks the person first.

## Look before changing

- `users`: everyone on the hub, their role, and which projects and spaces
  each member can reach. API keys are never shown.
- `spaces`: the shared spaces, by project.

Read these first, and repeat back what you are about to change.

## People

- `add_user`: add someone by name and email, as a member unless they should
  be an admin. Admins see every space.
- `edit_user`: change a role, or disable someone. Disabling blocks them
  from the hub until they are enabled again. The hub refuses to remove its last admin.

## Access

- `grant_access`: give a member a project's named spaces, or every space in it.
- `revoke_access`: take spaces, or a whole project, away. They can no longer
  read or sync those spaces' notes.

## Projects and spaces

- `create_project`, `rename_project`.
- `create_space`, and `edit_space` to rename, archive or set the main space.
- `move_space`: call it without `confirm` first. It lists who would lose
  access. Tell the person, then call it again with `confirm` true and `keep`
  for anyone who should keep access.

## Rules

- One change at a time, with the person's go-ahead for each.
- Never handle API keys. People get keys from the portal or settings page.
- If a tool says the person isn't an admin, stop and say so.
