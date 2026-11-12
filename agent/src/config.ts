import { createHash } from "crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import type { AuthMethodType } from "./auth/adapter";

export interface HubConfig {
  id: string;
  hubUrl: string;
  auth: AuthMethodType;
  apiKey?: string;
  cfClientId?: string;
  cfClientSecret?: string;
  label?: string;
}
export type HubSave = Omit<HubConfig, "id" | "label">;

export interface AgentConfig {
  hubs: HubConfig[];
  claudeMemUrl: string;
  claudeMemDbPath: string;
  port: number;
  syncIntervalMs: number;
  summaryQuietMs: number;
}

export class LabelTaken extends Error {
  constructor(label: string) {
    super(`a hub is already called "${label}"`);
  }
}

export class HubUrlTaken extends Error {
  constructor(hubUrl: string) {
    super(`${hubUrl} is already connected`);
  }
}

export const DEFAULTS = {
  claudeMemUrl: "http://127.0.0.1:37777",
  claudeMemDbPath: join(homedir(), ".claude-mem", "claude-mem.db"),
  port: 37778,
  syncIntervalMs: 5 * 60_000,
  summaryQuietMs: 30 * 60_000,
};

export function memSyncHome(): string {
  return process.env.MEM_SYNC_HOME ?? join(homedir(), ".mem-sync");
}

/** Creates the mem-sync home private to this user (0700); an existing one is tightened on POSIX. */
export function ensureHome(): void {
  mkdirSync(memSyncHome(), { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  try {
    chmodSync(memSyncHome(), 0o700);
  } catch {
    // Not ours to change (another owner): startup must not fail over it.
  }
}

const configPath = () => join(memSyncHome(), "config.json");

const LEGACY = ["hubUrl", "auth", "apiKey", "cfClientId", "cfClientSecret"] as const;
const CREDS = ["apiKey", "cfClientId", "cfClientSecret"] as const;

function readRaw(): Record<string, any> {
  const p = configPath();
  if (!existsSync(p)) return {};
  const text = readFileSync(p, "utf8");
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {};
  } catch {
    // Corrupt or truncated file: treat as unconfigured so setup can overwrite it.
    return {};
  }
}

const chmod600 = (p: string) => {
  try {
    chmodSync(p, 0o600);
  } catch {
    // Windows ignores POSIX modes; the file is in the user's profile.
    // shortcut: no icacls on Windows; config.json relies on the profile folder's per-user ACL. Restrict it with icacls (by SID) once that can be tested on Windows.
  }
};

/** Every write: temp file beside the target, mode 600, then rename; legacy top-level hub fields are dropped. */
function writeConfigAtomic(obj: Record<string, unknown>): void {
  ensureHome();
  const out = { ...obj };
  for (const k of LEGACY) delete out[k];
  const tmp = `${configPath()}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(out, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmod600(tmp);
    renameSync(tmp, configPath());
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
  chmod600(configPath());
}

export const newHubId = (): string => crypto.randomUUID().slice(0, 8);

export function defaultLabel(hubUrl: string): string {
  try {
    const u = new URL(hubUrl);
    return u.hostname.endsWith(".getmemsync.com") ? u.hostname.slice(0, -".getmemsync.com".length) : u.host;
  } catch {
    return hubUrl;
  }
}

/** A failed migration write is retried on every loadConfig and logged once per config path. */
const unsaved = new Set<string>();

/** The migrated 0.9 hub's id comes from its URL, so it stays the same across restarts even if config.json can't be written. */
export const migratedHubId = (hubUrl: string): string => createHash("sha256").update(urlKey(hubUrl)).digest("hex").slice(0, 8);

/** Reads hubs from the file; a 0.9.x top-level hub is migrated into hubs[0] and written back once. */
function readHubs(raw: Record<string, any>): HubConfig[] {
  if (Array.isArray(raw.hubs)) return raw.hubs;
  if (!raw.hubUrl) return [];
  const { hubUrl, auth, apiKey, cfClientId, cfClientSecret } = raw;
  const hub: HubConfig = { id: migratedHubId(hubUrl), hubUrl, auth: auth ?? "api-key", label: defaultLabel(hubUrl) };
  for (const [k, v] of Object.entries({ apiKey, cfClientId, cfClientSecret })) if (v) (hub as any)[k] = v;
  // Two agents may start at once: one migrates under a lock, the other waits and takes the id on disk,
  // so both key the ledger by the same hub id.
  const lock = `${configPath()}.migrating`;
  let fd: number | undefined;
  try {
    fd = openSync(lock, "wx");
  } catch (e) {
    // Only a lock held by another agent is waited for; an unwritable folder goes straight to the (failing) write.
    if ((e as NodeJS.ErrnoException).code === "EEXIST") for (const until = Date.now() + 3000; Date.now() < until; Bun.sleepSync(20)) {
      const disk = readRaw().hubs;
      if (Array.isArray(disk)) return disk;
    }
    // shortcut: a lock left by a crashed agent is taken over after 3s; two agents doing so at once could still race.
  }
  try {
    const now = readRaw();
    if (Array.isArray(now.hubs)) return now.hubs;
    const bak = `${configPath()}.pre-0.10`;
    if (!existsSync(bak)) {
      copyFileSync(configPath(), bak);
      chmod600(bak);
    }
    writeConfigAtomic({ ...raw, hubs: [hub] });
    const disk = readRaw().hubs;
    return Array.isArray(disk) ? disk : [hub];
  } catch (e) {
    if (!unsaved.has(configPath())) {
      unsaved.add(configPath());
      console.error(`mem-sync: could not save the migrated config.json (${(e as NodeJS.ErrnoException).code ?? "error"}); using it in memory`);
    }
    return [hub];
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {}
  }
}

export function loadConfig(): AgentConfig {
  const raw = readRaw();
  const hubs = readHubs(raw);
  const { hubs: _h, ...rest } = raw;
  for (const k of LEGACY) delete rest[k];
  return { ...DEFAULTS, ...rest, hubs } as AgentConfig;
}

/** True when config.json holds a hubs[] list (not a 0.9 config migrated only in memory). */
export const hubsSaved = (): boolean => Array.isArray(readRaw().hubs);

export const usableHub = (h: HubConfig): boolean => h.auth === "cloudflare-access" || !!h.apiKey;

/** A hub URL without a trailing slash and with the host lower-cased. */
function urlKey(u: string): string {
  try {
    const x = new URL(u);
    return (x.origin + x.pathname).replace(/\/+$/, "");
  } catch {
    return u.replace(/\/+$/, "");
  }
}

/** Compares hub URLs ignoring a trailing slash and the host's case. */
const sameHubUrl = (a: string, b: string): boolean => urlKey(a) === urlKey(b);

export const findHubByUrl = (c: AgentConfig, hubUrl: string): HubConfig | undefined => c.hubs.find((h) => sameHubUrl(h.hubUrl, hubUrl));

function uniqueLabel(hubs: HubConfig[], want: string): string {
  const taken = new Set(hubs.map((h) => h.label?.toLowerCase()));
  let label = want;
  for (let n = 2; taken.has(label.toLowerCase()); n++) label = `${want} ${n}`;
  return label;
}

function rawWithHubs(hubs: HubConfig[]): Record<string, unknown> {
  return { ...DEFAULTS, ...readRaw(), hubs };
}

export function upsertHub(id: string, c: HubSave & { label?: string }): HubConfig {
  const hubs = loadConfig().hubs;
  const i = hubs.findIndex((h) => h.id === id);
  const prev: Record<string, any> = i >= 0 ? { ...hubs[i] } : {};
  // Switching to Access or to another hub never carries credentials over.
  if (c.auth !== "api-key" || prev.hubUrl !== c.hubUrl) for (const k of CREDS) delete prev[k];
  const chosen: Record<string, unknown> = { hubUrl: c.hubUrl, auth: c.auth };
  if (c.auth === "api-key") {
    // A key present in the input (even undefined or empty) replaces the stored value; empty removes it.
    // Only keys absent from the input are carried over (same hub only).
    for (const k of CREDS) {
      if (!(k in c)) continue;
      const v = c[k];
      if (v) chosen[k] = v;
      else delete prev[k];
    }
  }
  const others = hubs.filter((h) => h.id !== id);
  if (others.some((h) => sameHubUrl(h.hubUrl, c.hubUrl))) throw new HubUrlTaken(c.hubUrl);
  // A label still at the old URL's default follows the URL.
  const keptLabel = prev.hubUrl !== c.hubUrl && prev.label === defaultLabel(prev.hubUrl) ? uniqueLabel(others, defaultLabel(c.hubUrl)) : prev.label;
  const label =
    i < 0 ? uniqueLabel(others, c.label ?? defaultLabel(c.hubUrl)) : c.label && c.label !== prev.label ? checkedLabel(others, c.label) : keptLabel;
  const hub = { ...prev, ...chosen, id, label } as HubConfig;
  if (i >= 0) hubs[i] = hub;
  else hubs.push(hub);
  writeConfigAtomic(rawWithHubs(hubs));
  return hub;
}

function checkedLabel(others: HubConfig[], label: string): string {
  if (others.some((h) => h.label?.toLowerCase() === label.toLowerCase())) throw new LabelTaken(label);
  return label;
}

export function renameHub(id: string, label: string): HubConfig {
  const hubs = loadConfig().hubs;
  const hub = hubs.find((h) => h.id === id);
  if (!hub) throw new Error(`no hub ${id}`);
  hub.label = checkedLabel(hubs.filter((h) => h.id !== id), label);
  writeConfigAtomic(rawWithHubs(hubs));
  return hub;
}

export function removeHub(id: string): boolean {
  const hubs = loadConfig().hubs;
  const rest = hubs.filter((h) => h.id !== id);
  if (rest.length === hubs.length) return false;
  writeConfigAtomic(rawWithHubs(rest));
  return true;
}
