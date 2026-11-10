export type PrState = "OPEN" | "MERGED" | "CLOSED" | "DRAFT";
export interface GitPr { number: number; state: PrState; url: string; checked_at: number }
export interface GitContext { remote: string | null; branch: string | null; commit: string | null; pr?: GitPr }

export const GIT_HOSTS = ["github.com", "gitlab.com", "bitbucket.org"];
const MAX_URL = 300;
const PR_STATES: readonly string[] = ["OPEN", "MERGED", "CLOSED", "DRAFT"];
// No all-dots segment, so a link can never climb out of the repo path.
const SEGMENT = /^(?!\.+$)[A-Za-z0-9._~-]+$/;

/** A git remote (ssh, scp-like or http(s)) as its https web URL on an allowed host, without credentials; else null. */
export function webRemote(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > MAX_URL) return null;
  let host: string;
  let path: string;
  if (raw.includes("://")) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:"].includes(u.protocol)) return null;
    host = u.hostname;
    path = u.pathname;
  } else {
    const m = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(raw); // git@host:owner/repo.git
    if (!m) return null;
    [, host, path] = m;
  }
  host = host.toLowerCase();
  if (!GIT_HOSTS.includes(host)) return null;
  const segs = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "").split("/");
  if (segs.length < 2 || !segs.every((s) => SEGMENT.test(s))) return null;
  const out = `https://${host}/${segs.join("/")}`;
  return out.length <= MAX_URL ? out : null;
}

const posInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

// Canonical form only: the stored string becomes an href on teammates' pages.
const prUrl = (v: unknown): v is string => typeof v === "string" && webRemote(v) === v;

/** The git field rebuilt from its allowed parts when every bound holds, else null (dropped whole). A bad pr drops only the pr. */
export function cleanGit(v: unknown): GitContext | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const g = v as Record<string, unknown>;
  const remote = g.remote ?? null;
  const branch = g.branch ?? null;
  const commit = g.commit ?? null;
  if (remote !== null && (typeof remote !== "string" || webRemote(remote) !== remote)) return null;
  if (branch !== null && (typeof branch !== "string" || branch.length < 1 || branch.length > 200 || /[\p{Cc}\p{Cf}]/u.test(branch) || branch.split("/").some((x) => x === "." || x === ".."))) return null;
  if (commit !== null && (typeof commit !== "string" || !/^[0-9a-f]{7,40}$/.test(commit))) return null;
  if (branch === null && commit === null) return null;
  const out: GitContext = { remote, branch, commit };
  // A null or invalid pr drops only the pr.
  const p = g.pr as Record<string, unknown> | null | undefined;
  if (p && typeof p === "object" && posInt(p.number) && PR_STATES.includes(p.state as string) && prUrl(p.url) && posInt(p.checked_at)) {
    out.pr = { number: p.number, state: p.state as PrState, url: p.url, checked_at: p.checked_at };
  }
  return out;
}

/** A copy of the payload without its git field. */
export function withoutGit<T extends object>(payload: T): T {
  const { git: _, ...rest } = payload as T & { git?: unknown };
  return rest as T;
}
