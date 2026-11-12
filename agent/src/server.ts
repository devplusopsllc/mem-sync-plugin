import { join } from "path";
import { HubUnreachable } from "./cloudflared";
import { LabelTaken, usableHub, type HubConfig } from "./config";
import { normalizeHubUrl } from "./discovery";
import { HubError, type MappingView } from "./hubClient";
import type { GitContextStore } from "./gitContext";
import type { HubHandle, HubSet } from "./hubs";
import type { Ledger } from "./ledger";
import type { SyncRunner } from "./runner";

const ASK_TIMEOUT_MS = 70_000;

export interface ProjectView {
  project: string;
  state: "mapped" | "unmapped" | "never";
  mapping: MappingView | null;
  present_locally: boolean;
  /** The hub whose mapping is shown: the folder's owner, else the first hub (config order) that maps it. */
  hub_id: string | null;
  /** Other hubs that map the folder too. */
  also_linked_on: string[];
  /** False when the person turned off sharing this folder's branch, commit and PR. */
  git_details: boolean;
}

type MyMappings = { mappings: MappingView[]; never_sync: string[] };

export function mergeProjects(local: string[], perHub: { hubId: string; mine: MyMappings }[], owner: (project: string) => string | null): Omit<ProjectView, "git_details">[] {
  const all = perHub.flatMap((h) => h.mine.mappings.map((m) => ({ hubId: h.hubId, m })));
  const never = new Set(perHub.flatMap((h) => h.mine.never_sync));
  const present = new Set(local);
  const names = [...new Set([...local, ...all.map((x) => x.m.local_project), ...never])].sort((a, b) => a.localeCompare(b));
  return names
    .filter((p) => present.has(p) || all.some((x) => x.m.local_project === p))
    .map((project) => {
      const on = all.filter((x) => x.m.local_project === project);
      const o = owner(project);
      const shown = on.find((x) => x.hubId === o) ?? on[0];
      const state = shown ? "mapped" : never.has(project) ? "never" : "unmapped";
      return {
        project,
        state,
        mapping: shown?.m ?? null,
        present_locally: present.has(project),
        hub_id: shown?.hubId ?? null,
        also_linked_on: on.filter((x) => x !== shown).map((x) => x.hubId),
      };
    });
}

export interface HubStatus {
  id: string;
  label: string;
  hub_url: string;
  auth: HubConfig["auth"];
  usable: boolean;
  state: HealthState;
  last_error: string;
  last_success_at: number | null;
  failing_since: number | null;
  signed_in_as: string | null;
  session_expires_at: number | null;
  busy: boolean;
}

export interface AgentServerDeps {
  port: number;
  runner: SyncRunner;
  /** Starts a sync cycle (logs it); every trigger goes through this. */
  triggerSync: () => Promise<unknown>;
  /** The laptop's ledger; the server reads and sets which hub owns a folder's push state. */
  ledger: Ledger;
  /** The per-folder git timeline the prompt hook feeds. */
  git: GitContextStore;
  listProjects: () => Promise<string[]>;
  hubs: HubSet;
  uiDir: string;
  /** The plugin version, reported by /local/health so the hook can replace an outdated agent. */
  version: string;
  /** Stops the agent; called after POST /local/shutdown has been answered. */
  shutdown: () => void;
  /** True once shutdown has begun: new sync requests are refused with 503. */
  isStopping: () => boolean;
}

const STATIC: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/theme.js": "theme.js",
  "/catchup.js": "catchup.js",
  "/hubs.js": "hubs.js",
  "/style.css": "style.css",
  "/signin": "signin.html",
};
const FONTS: Record<string, string> = {
  "/fonts/newsreader.woff2": "fonts/newsreader.woff2",
  "/fonts/newsreader-italic.woff2": "fonts/newsreader-italic.woff2",
  "/fonts/public-sans.woff2": "fonts/public-sans.woff2",
  "/fonts/jetbrains-mono.woff2": "fonts/jetbrains-mono.woff2",
};

/** What /local/health reports as `state`; the Claude Code hook turns the non-"ok" ones into notices. */
export type HealthState = "ok" | "paused" | "signin" | "revoked" | "not_allowed" | "need_key" | "unreachable" | "error" | "unconfigured";

const PASSTHROUGH = new Set(["paused", "signin", "revoked", "not_allowed", "need_key", "unreachable", "error"]);

/** Maps the ledger's last_status; a value this build doesn't know reads as "error". */
export function ledgerHealthState(configured: boolean, lastStatus: string | undefined): HealthState {
  if (!configured) return "unconfigured";
  const s = lastStatus ?? "";
  if (s === "" || s === "ok") return "ok";
  return PASSTHROUGH.has(s) ? (s as HealthState) : "error";
}

function epochMs(v: string | undefined): number | null {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Sent on every response: no page of the agent may be framed (clickjacking the sign-in or settings), and a
 * page that opened one of ours keeps no handle to it.
 */
const NO_FRAMING: Record<string, string> = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
};
/** /signin differs by how it was opened; never serve one variant from cache for the other. */
const SIGNIN_HEADERS = { "content-type": "text/html;charset=utf-8", "cache-control": "no-store", vary: "Sec-Fetch-Site" };

function noFraming(res: Response): Response {
  for (const [k, v] of Object.entries(NO_FRAMING)) res.headers.set(k, v);
  return res;
}

export function createAgentServer(d: AgentServerDeps) {
  const st: ServerState = {};
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: d.port,
    async fetch(req) {
      return noFraming(await handle(req));
    },
  });
  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const self = new Set([`127.0.0.1:${server.port}`, `localhost:${server.port}`]);
    if (!self.has(req.headers.get("host") ?? "")) return new Response("forbidden host", { status: 403 });
    const origin = req.headers.get("origin");
    if (origin && !self.has(origin.replace(/^https?:\/\//, ""))) return Response.json({ error: "forbidden origin" }, { status: 403 });
    if (req.method !== "GET" && req.headers.get("x-mem-sync") !== "1") {
      return Response.json({ error: "missing X-Mem-Sync header" }, { status: 403 });
    }
    try {
      return await route(d, st, req, url);
    } catch (e) {
      if (e instanceof BadJson) return Response.json({ error: "invalid JSON body" }, { status: 400 });
      if (e instanceof LabelTaken) return Response.json({ error: e.message }, { status: 409 });
      if (e instanceof HubError) return Response.json({ error: e.message }, { status: e.status });
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }
  return server;
}

class BadJson extends Error {}

interface ServerState {
  /** The hub whose sign-in a bare /local/signin last started; its status and result keep answering there. */
  signInHub?: string;
}

/** A typed or bookmarked URL, a same-origin link, or a client that sends no Fetch Metadata (curl, old browsers). */
function directOpen(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  return site === null || site === "none" || site === "same-origin";
}

/** The hub URL as an origin, or null when it isn't https (or http on localhost). A hub already saved over http keeps working. */
function normalized(input: string, hubs: HubSet): string | null {
  try {
    return normalizeHubUrl(input);
  } catch {
    try {
      const u = new URL(input.trim());
      return u.protocol === "http:" && hubs.byUrl(u.origin) ? u.origin : null;
    } catch {
      return null;
    }
  }
}

/** Empty body gives undefined; a present but malformed body throws BadJson. */
async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new BadJson();
  }
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const notConfigured = () => json({ error: "not configured" }, 409);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function hubStatus(d: AgentServerDeps, h: HubHandle): HubStatus {
  const st = h.ledger.status();
  const a = h.auth.status();
  const usable = usableHub(h.config);
  return {
    id: h.config.id,
    label: h.label,
    hub_url: h.config.hubUrl,
    auth: h.config.auth,
    usable,
    state: ledgerHealthState(usable, st.last_status),
    last_error: st.last_error ?? "",
    last_success_at: epochMs(st.last_success_at),
    failing_since: epochMs(st.failing_since),
    signed_in_as: a.signed_in_as,
    session_expires_at: a.session_expires_at,
    // shortcut: one runner syncs every hub, so busy is laptop-wide; per hub once cycles run in parallel.
    busy: d.runner.busy,
  };
}

/** The key-hub body of POST /local/config and POST /local/hubs, or null when it isn't valid. */
async function keyHubBody(req: Request, hubs: HubSet) {
  const c = ((await readJson(req)) ?? {}) as Record<string, unknown>;
  const hubUrl = typeof c.hubUrl === "string" ? normalized(c.hubUrl, hubs) : null;
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  if (hubUrl === null || !str(c.apiKey) || (c.auth !== undefined && c.auth !== "api-key")) return null;
  return { hubUrl, apiKey: c.apiKey as string, cfClientId: str(c.cfClientId), cfClientSecret: str(c.cfClientSecret), label: str(c.label) };
}

const methodOf = (v: unknown) => (v === "cloudflare-access" || v === "api-key" ? v : undefined);

async function connectReply(run: () => Promise<unknown>): Promise<Response> {
  try {
    return json(await run());
  } catch (e) {
    if (e instanceof HubUnreachable) return json({ error: "can't reach the hub" }, 502);
    throw e;
  }
}

/** The hub a bare /local/signin is for: a running sign-in it started, a hub that needs one, the last it started, a Cloudflare hub, the first. */
function bareSignInHub(d: AgentServerDeps, st: ServerState): HubHandle | undefined {
  const all = d.hubs.list();
  const last = all.find((h) => h.config.id === st.signInHub);
  if (last?.auth.signInState()?.state === "running") return last;
  return all.find((h) => h.auth.signInNeeded()) ?? last ?? all.find((h) => h.auth.signInState() !== null) ?? all[0];
}

async function signIn(st: ServerState, h: HubHandle | undefined, req: Request): Promise<Response> {
  const notCloudflare = () => json({ error: "this hub doesn't use Cloudflare sign-in", reason: "not_cloudflare" }, 409);
  if (req.method === "POST") {
    const body = (await readJson(req)) as { reauth?: unknown } | undefined;
    const cur = h?.auth.signInState();
    if (!h || !cur) return notCloudflare();
    // Joining a running sign-in is harmless; a new one starts only when wanted, or when the user asks
    // for it explicitly (settings "Sign in again"). Keeps a reload or a stray POST from opening a login.
    if (cur.state !== "running" && body?.reauth !== true && !h.auth.signInNeeded()) {
      return json({ error: "no sign-in needed", reason: "not_needed" }, 409);
    }
    const s = h.auth.startSignIn();
    if (!s) return notCloudflare();
    st.signInHub = h.config.id;
    return json(s, 202);
  }
  if (req.method === "GET") {
    const s = h?.auth.signInState();
    return s ? json(s) : notCloudflare();
  }
  return json({ error: "not found" }, 404);
}

async function proxy(d: AgentServerDeps, h: HubHandle, req: Request, rest: string, search: string): Promise<Response> {
  if (!usableHub(h.config)) return notConfigured();
  const body = req.method === "GET" || req.method === "DELETE" ? undefined : await readJson(req);
  if (req.method === "PUT" && rest === "me/mappings") return linkFolder(d, h, body);
  // The hub allows Ask 60 s; wait a little longer than that so a slow answer is not dropped (and still billed).
  const slow = req.method === "POST" && rest.endsWith("/ask");
  return json(await h.client().raw(req.method, "/v1/" + rest + search, body, slow ? ASK_TIMEOUT_MS : undefined));
}

/**
 * One folder, one hub. The other hubs are asked where the folder is linked; linked elsewhere is refused
 * unless it is a move, which unlinks it there. The request changes no ledger state: the next cycle sees
 * the owner no longer links the folder and moves its push state here (serialized with every push).
 */
async function linkFolder(d: AgentServerDeps, h: HubHandle, body: unknown): Promise<Response> {
  const { move, ...rest } = (body ?? {}) as Record<string, unknown>;
  const project = rest.local_project;
  let moved = false;
  const owner = typeof project === "string" ? d.ledger.folderHub(project) : null;
  // A toggle on the hub that owns the folder and still links it asks no other hub. Ownership alone can be
  // stale (moved away, not yet seen by a cycle), so the hub's own links are checked too.
  const toggle = typeof project === "string" && owner === h.config.id && move !== true &&
    (await h.client().myMappings()).mappings.some((m) => m.local_project === project);
  if (typeof project === "string" && !toggle) {
    const others = d.hubs.list().filter((o) => o.config.id !== h.config.id && usableHub(o.config));
    const read = await Promise.all(others.map((o) => o.client().myMappings().then((mine) => ({ o, mine }), () => ({ o, mine: null }))));
    // A hub that can't be read is skipped (claimFolder still stops a double push), unless it owns the folder.
    const down = read.find((r) => r.mine === null && r.o.config.id === owner);
    if (down) return json({ error: `can't reach ${down.o.label} to check where ${project} is linked; try again or remove that hub` }, 502);
    const linked = read.flatMap(({ o, mine }) => (mine?.mappings ?? []).filter((m) => m.local_project === project).map((m) => ({ o, m })));
    if (linked.length > 0 && move !== true) {
      const { o } = linked[0];
      return json({ error: `${project} is linked on ${o.label}; move it or unlink it there first`, reason: "linked_elsewhere", hub_id: o.config.id }, 409);
    }
    for (const { o, m } of linked) await o.client().raw("DELETE", `/v1/me/mappings/${m.id}`);
    moved = linked.length > 0;
  }
  const res = json(await h.client().raw("PUT", "/v1/me/mappings", rest));
  if (moved) d.triggerSync().catch((e) => console.error("sync failed:", e));
  return res;
}

/** Writes "never share" for a folder to every usable hub; a hub that misses it gets it from its next cycle. */
async function neverSync(d: AgentServerDeps, project: string, on: boolean): Promise<{ ok: boolean; failed: { hub_id: string; error: string }[] }> {
  const failed: { hub_id: string; error: string }[] = [];
  for (const h of d.hubs.list().filter((x) => usableHub(x.config))) {
    try {
      await h.client().setNeverSync(project, on);
      h.ledger.clearNeverPending(project);
    } catch (e) {
      h.ledger.addNeverPending(project, on);
      failed.push({ hub_id: h.config.id, error: errMsg(e) });
    }
  }
  return { ok: failed.length === 0, failed };
}

/**
 * A 0.9 client's never-share: the whole list, read from the first hub. Each change goes to every hub,
 * as PUT /local/never-sync does.
 */
async function oldNeverSync(d: AgentServerDeps, first: HubHandle, req: Request): Promise<Response> {
  const { projects } = ((await readJson(req)) ?? {}) as { projects?: unknown };
  if (!Array.isArray(projects) || !projects.every((x) => typeof x === "string" && x !== "")) return json({ error: "projects must be an array of folder names" }, 400);
  const was = (await first.client().myMappings()).never_sync;
  const changes: [string, boolean][] = [
    ...[...new Set(projects as string[])].filter((x) => !was.includes(x)).map((x): [string, boolean] => [x, true]),
    ...was.filter((x) => !projects.includes(x)).map((x): [string, boolean] => [x, false]),
  ];
  const failed = [];
  for (const [x, on] of changes) failed.push(...(await neverSync(d, x, on)).failed);
  return json({ ok: failed.length === 0, failed });
}

async function route(d: AgentServerDeps, st: ServerState, req: Request, url: URL): Promise<Response> {
  const p = url.pathname;
  if (p === "/local/health") {
    // Polled by the hook with a short timeout: ledger and config only, never the hub.
    const all = d.hubs.list();
    const states = all.map((h) => ledgerHealthState(usableHub(h.config), h.ledger.status().last_status));
    const i = Math.max(0, states.findIndex((s) => s !== "ok"));
    const shown = all[i];
    const s = shown?.ledger.status() ?? {};
    const err = s.last_error ?? "";
    return json({
      ok: true,
      service: "mem-sync-agent",
      version: d.version,
      pid: process.pid,
      signin_needed: s.last_status === "signin",
      state: states[i] ?? "unconfigured",
      last_error: all.length > 1 && err ? `${shown.label}: ${err}` : err,
      last_success_at: epochMs(s.last_success_at),
      failing_since: epochMs(s.failing_since),
      // With one hub the reply keeps the 0.9.2 shape.
      ...(all.length > 1 ? { hubs: all.map((h, j) => ({ id: h.config.id, label: h.label, state: states[j] })) } : {}),
    });
  }
  if (p === "/local/shutdown" && req.method === "POST") {
    setTimeout(d.shutdown, 0);
    return json({ stopping: true }, 202);
  }
  if (p === "/local/sync" && req.method === "POST") {
    if (d.isStopping()) return json({ error: "stopping" }, 503);
    d.triggerSync().catch((e) => console.error("sync failed:", e));
    return json({ started: true }, 202);
  }
  if (p === "/local/git-context" && req.method === "POST") {
    const b = ((await readJson(req)) ?? {}) as Record<string, unknown>;
    if (typeof b.cwd !== "string" || b.cwd === "" || b.cwd.length > 4096) return json({ error: "cwd is required" }, 400);
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    const sid = str(b.session_id);
    d.git.capture({ cwd: b.cwd, session_id: sid !== null && sid.length <= 200 ? sid : null, branch: str(b.branch), commit: str(b.commit), remote: str(b.remote) });
    return json({ ok: true });
  }
  if (p === "/local/status") {
    const all = d.hubs.list();
    const first = all[0];
    const configured = first !== undefined && usableHub(first.config);
    return json({
      configured,
      busy: d.runner.busy,
      hubs: all.map((h) => hubStatus(d, h)),
      hub_url: configured ? first.config.hubUrl : null,
      ...first?.ledger.status(),
      ...(first?.auth.status() ?? { auth: null, signed_in_as: null, session_expires_at: null }),
    });
  }
  if (p === "/local/hubs" && req.method === "GET") return json({ hubs: d.hubs.list().map((h) => hubStatus(d, h)) });
  if ((p === "/local/hubs" || p === "/local/config") && req.method === "POST") {
    const c = await keyHubBody(req, d.hubs);
    if (!c) return json({ error: "hubUrl must be an http(s) URL and apiKey is required" }, 400);
    const added = await d.hubs.addKeyHub(p === "/local/config" ? { ...c, label: undefined } : c);
    return p === "/local/config" ? json({ saved: true }) : json({ hub: hubStatus(d, d.hubs.get(added.id)!) });
  }
  if (p === "/local/connect" && req.method === "POST") {
    const c = ((await readJson(req)) ?? {}) as { hubUrl?: unknown; method?: unknown };
    const hubUrl = typeof c.hubUrl === "string" ? normalized(c.hubUrl, d.hubs) : null;
    if (!hubUrl) return json({ error: "hubUrl must be an https URL (http only for localhost)" }, 400);
    return connectReply(() => d.hubs.connect(hubUrl, methodOf(c.method)));
  }
  if (p === "/local/signin") return signIn(st, bareSignInHub(d, st), req);
  if (p === "/local/never-sync" && req.method === "PUT") {
    const b = ((await readJson(req)) ?? {}) as { project?: unknown; on?: unknown };
    if (typeof b.project !== "string" || b.project === "" || typeof b.on !== "boolean") return json({ error: "project and on are required" }, 400);
    return json(await neverSync(d, b.project, b.on));
  }
  if (p === "/local/git-details" && req.method === "PUT") {
    const b = ((await readJson(req)) ?? {}) as { project?: unknown; on?: unknown };
    if (typeof b.project !== "string" || b.project === "" || b.project.length > 4096 || typeof b.on !== "boolean") return json({ error: "project and on are required" }, 400);
    d.ledger.setGitOff(b.project, !b.on);
    return json({ project: b.project, on: b.on });
  }
  if (p === "/local/projects") {
    const usable = d.hubs.list().filter((h) => usableHub(h.config));
    if (usable.length === 0) return notConfigured();
    const [local, ...read] = await Promise.all([
      d.listProjects().then(
        (names) => ({ names, error: undefined as string | undefined }),
        (e) => ({ names: null as string[] | null, error: errMsg(e) }),
      ),
      ...usable.map((h) => h.client().myMappings().then((mine) => ({ hubId: h.config.id, mine }), (e: unknown) => ({ hubId: h.config.id, e }))),
    ]);
    const ok = read.filter((r): r is { hubId: string; mine: MyMappings } => "mine" in r);
    // Every hub failed (always so with one hub): its error, as in 0.9.
    if (ok.length === 0) throw (read[0] as { e: unknown }).e;
    const hub_errors = Object.fromEntries(read.flatMap((r) => ("e" in r ? [[r.hubId, errMsg(r.e)]] : [])));
    // Without claude-mem we can't list its projects; show what the hubs already know about.
    const names = local.names ?? ok.flatMap((r) => [...r.mine.mappings.map((m) => m.local_project), ...r.mine.never_sync]);
    return json({
      projects: mergeProjects(names, ok, (x) => d.ledger.folderHub(x)).map((v): ProjectView => ({ ...v, git_details: !d.ledger.gitOff(v.project) })),
      hub_errors,
      ...(local.error !== undefined ? { claude_mem_error: local.error } : {}),
    });
  }
  if (p.startsWith("/local/hub/")) {
    const first = d.hubs.first();
    if (!first) return notConfigured();
    const rest = p.slice("/local/hub/".length);
    // 0.9 clients: link ids in /local/projects come from the folder's own hub, but this route reaches the first hub.
    if (d.hubs.list().length > 1 && usableHub(first.config)) {
      if (req.method === "DELETE" && /^me\/mappings\/[^/]+$/.test(rest)) {
        return json({ error: "Update mem-sync to 0.10 to change links while several hubs are connected." }, 409);
      }
      if (req.method === "PUT" && rest === "me/never-sync") return oldNeverSync(d, first, req);
    }
    return proxy(d, first, req, rest, url.search);
  }
  const m = /^\/local\/hubs\/([^/]+)(?:\/(.*))?$/.exec(p);
  if (m) {
    const h = d.hubs.get(m[1]);
    if (!h) return json({ error: "no such hub" }, 404);
    const rest = m[2];
    if (rest === undefined && req.method === "PATCH") {
      const { label } = ((await readJson(req)) ?? {}) as { label?: unknown };
      if (typeof label !== "string" || label.trim() === "") return json({ error: "label is required" }, 400);
      d.hubs.rename(h.config.id, label.trim());
      return json({ hub: hubStatus(d, d.hubs.get(h.config.id)!) });
    }
    if (rest === undefined && req.method === "DELETE") {
      await d.hubs.remove(h.config.id);
      return json({ removed: true });
    }
    if (rest === "connect" && req.method === "POST") {
      const c = ((await readJson(req)) ?? {}) as { method?: unknown };
      return connectReply(() => h.auth.connect(h.config.hubUrl, methodOf(c.method)));
    }
    if (rest === "signin") return signIn(st, h, req);
    if (rest) return proxy(d, h, req, rest, url.search);
  }
  const file = STATIC[p];
  if (req.method === "GET" && p === "/signin") {
    const html = await Bun.file(join(d.uiDir, file!)).text();
    // Reached from another site (a link or redirect): show the page, but the user must click to sign in.
    return new Response(directOpen(req) ? html : html.replace("<body>", '<body data-autostart="0">'), { headers: SIGNIN_HEADERS });
  }
  if (req.method === "GET" && file) return new Response(Bun.file(join(d.uiDir, file)));
  const font = FONTS[p];
  if (req.method === "GET" && font) return new Response(Bun.file(join(d.uiDir, font)), { headers: { "content-type": "font/woff2" } });
  return Response.json({ error: "not found" }, { status: 404 });
}
