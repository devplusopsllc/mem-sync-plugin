/** GET /local/health on the mem-sync agent. */
export type Health = {
  state: string
  version: string
  last_error: string
  last_success_at: number | null
  failing_since: number | null
}

/** GET /local/status on the mem-sync agent (the fields this mod reads). */
export type Status = {
  configured: boolean
  busy: boolean
  hub_url: string | null
  signed_in_as?: string | null
  auth?: string | null
  last_pushed?: string
  last_pulled?: string
}

/** One row of GET /local/hubs; a 0.9 agent gets one, with id '', made from its status. */
export type Hub = {
  id: string
  label: string
  hub_url: string
  auth: string
  state: string
  last_error: string
  last_success_at: number | null
  signed_in_as: string | null
}

export type Mapping = {
  id: number
  local_project: string
  space_id: number
  space_name: string | null
  space_access?: boolean
  space_archived: boolean
  enabled: boolean
}

/** One row of GET /local/projects. */
export type Folder = {
  project: string
  state: 'mapped' | 'unmapped' | 'never'
  mapping: Mapping | null
  present_locally: boolean
  /** The hub whose mapping is shown; null when unlinked (absent from a 0.9 agent). */
  hub_id: string | null
  /** Other hubs that link this folder too (another laptop, or the hub admin UI). */
  also_linked_on?: string[]
  /** False when sharing this folder's branch, commit and PR is off (absent from agents before git details). */
  git_details?: boolean
}

/** One row of GET /local/hub/spaces. */
export type Space = {
  id: number
  name: string
  archived: boolean
  /** The hub sends project_*; client_* is what a hub not yet updated sends. */
  project_name?: string | null
  client_name?: string | null
  hub_id: string
}

/** One row of GET /local/hub/projects (admins only); the fields this mod reads. */
export type Client = {
  id: number
  name: string
  spaces?: { id: number; name: string; is_main: boolean; archived: boolean }[]
  hub_id: string
}

/** A member's access to one project: every space, or the ones listed. */
export type Membership = {
  project_id?: number
  project_name?: string
  client_id: number
  client_name: string
  scope: 'all' | 'selected'
  space_ids: number[]
}

/** One row of GET /local/hub/users (admins only), without the API key fields this mod never reads. */
export type HubUser = {
  id: number
  name: string
  email: string
  role: 'admin' | 'member'
  status: string
  clients: Membership[]
  /** What a hub that has moved to projects sends beside clients. */
  projects?: Membership[]
  hub_id: string
}

export type Snapshot = {
  /** False when nothing answers on 127.0.0.1:37778. */
  isUp: boolean
  health: Health | null
  status: Status | null
  hubs: Hub[] | null
  folders: Folder[] | null
  /** Every hub's spaces, each tagged with its hub_id. */
  spaces: Space[] | null
  /** The signed-in user's role on each hub, by hub id, from GET /local/hubs/:id/me. */
  roles: Record<string, 'admin' | 'member'>
  /** Every project on the hubs where this person is an admin. */
  clients: Client[] | null
  error: string | null
  checkedAt: number
}

/** One row of GET /local/hub/spaces/:id/standards (the fields this mod reads). */
export type Standard = { id: number; name: string; body: string; enabled: boolean }

/** This folder's project and its enabled standards; null when the folder has none to show. */
export type Standards = { hubId: string; spaceId: number; project: string | null; standards: Standard[] }

export type Notice = { text: string; isError: boolean }

declare module 'claude-code' {
  interface PluginState {
    'mem-sync-ui': {
      snapshot: Shaped<Snapshot>
      notice: Notice | null
      /** The enabled standards of this folder's project, cached by the status refresh. */
      standards: Standards | null
      /** The action a button started and is still running. */
      busy: string | null
      /** The folder whose Unlink waits for a Yes. */
      confirm: string | null
      /** The project the Admin section's new space goes under. */
      spaceClient: number | null
      /** What the admin has typed for a new project and a new space. */
      clientDraft: string
      spaceDraft: string
    }
  }
}
