import { Database } from "bun:sqlite";
import { existsSync, linkSync, renameSync, rmSync } from "fs";
import type { PrState } from "../../shared/src/git";
import type { SyncRecord } from "../../shared/src/types";

export type PushTable = "sessions" | "observations";
export type LedgerKind = "session" | "observation" | "summary" | "session_mem";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS push_cursors (local_project TEXT NOT NULL, table_name TEXT NOT NULL,
  last_local_id INTEGER NOT NULL, PRIMARY KEY (local_project, table_name));
CREATE TABLE IF NOT EXISTS pull_cursors (hub_id TEXT NOT NULL, space_id INTEGER NOT NULL, last_seq INTEGER NOT NULL,
  PRIMARY KEY (hub_id, space_id));
CREATE TABLE IF NOT EXISTS deletion_cursors (hub_id TEXT NOT NULL, space_id INTEGER NOT NULL, last_id INTEGER NOT NULL,
  PRIMARY KEY (hub_id, space_id));
CREATE TABLE IF NOT EXISTS pushed (kind TEXT NOT NULL, global_key TEXT NOT NULL, pushed_at INTEGER NOT NULL,
  PRIMARY KEY (kind, global_key));
CREATE TABLE IF NOT EXISTS imported (kind TEXT NOT NULL, global_key TEXT NOT NULL, imported_at INTEGER NOT NULL,
  PRIMARY KEY (kind, global_key));
CREATE TABLE IF NOT EXISTS pending_pulls (id INTEGER PRIMARY KEY AUTOINCREMENT, hub_id TEXT NOT NULL, space_id INTEGER NOT NULL,
  payload TEXT NOT NULL, created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS pending_pulls_hub_space ON pending_pulls (hub_id, space_id);
CREATE TABLE IF NOT EXISTS status (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS push_retries (hub_id TEXT NOT NULL, local_project TEXT, kind TEXT, global_key TEXT, local_id INTEGER,
  attempts INTEGER, last_error TEXT, first_failed_at INTEGER, PRIMARY KEY (hub_id, local_project, kind, global_key));
CREATE TABLE IF NOT EXISTS folder_hubs (local_project TEXT PRIMARY KEY, hub_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS git_context (id INTEGER PRIMARY KEY AUTOINCREMENT, local_project TEXT NOT NULL, session_id TEXT, remote TEXT,
  branch TEXT, commit_sha TEXT, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS git_context_project_seen ON git_context (local_project, first_seen_at);
CREATE TABLE IF NOT EXISTS git_prs (remote TEXT NOT NULL, branch TEXT NOT NULL, number INTEGER, state TEXT, url TEXT,
  checked_at INTEGER NOT NULL, PRIMARY KEY (remote, branch));
CREATE TABLE IF NOT EXISTS git_off (local_project TEXT PRIMARY KEY);
`;

/** A capture older than this (since last seen) is not in effect any more. */
export const GIT_MAX_GAP_MS = 12 * 3600_000;
const GIT_KEEP_MS = 30 * 24 * 3600_000;

/** One stretch of a folder's timeline: the same remote, branch and commit from first to last seen. */
export interface GitEntry { remote: string | null; branch: string | null; commit: string | null; first_seen_at: number; last_seen_at: number }

type GitValues = { remote: string | null; branch: string | null; commit: string | null };

/** 0.9 tables that gain a hub_id, and the columns copied over; ids and row order are kept. */
const REKEYED: [table: string, cols: string, order: string][] = [
  ["pull_cursors", "space_id, last_seq", "space_id"],
  ["deletion_cursors", "space_id, last_id", "space_id"],
  ["pending_pulls", "id, space_id, payload, created_at, attempts", "id"],
  ["push_retries", "local_project, kind, global_key, local_id, attempts, last_error, first_failed_at", "rowid"],
];

export interface PushRetry {
  kind: "observation" | "summary";
  global_key: string;
  local_id: number;
  attempts: number;
  last_error: string;
  /** When the hub first rejected it (epoch ms); the agent gives up 7 days after this. */
  first_failed_at: number;
}

/** The laptop's ledger. Hub-specific state is read and written through `forHub(id)`. */
export class Ledger {
  readonly db: Database;

  /** `legacyHubId`: the hub a 0.9 ledger's rows and status belong to (the config's first hub). */
  constructor(path: string, legacyHubId?: string) {
    this.db = new Database(path, { create: true });
    // busy_timeout first: switching to WAL needs a lock, and an agent started at the same moment
    // (two sessions opening at once) may hold it; without the wait both fail with SQLITE_BUSY.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    if (this.version() < 1) this.migrate(path, legacyHubId ?? "");
    this.db.exec(SCHEMA);
  }

  private version(): number {
    return (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  }

  private isOld(table: string): boolean {
    const cols = this.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return cols.length > 0 && !cols.some((c) => c.name === "hub_id");
  }

  /** 0.9 -> 1: rows and status keys move onto the legacy hub; each pushed folder belongs to it. */
  private migrate(path: string, hub: string): void {
    const bak = `${path}.pre-0.10`;
    if (REKEYED.some(([t]) => this.isOld(t)) && !existsSync(bak)) {
      // A consistent snapshot (WAL included), published with link() so a second agent never overwrites the first copy.
      const tmp = `${bak}.${process.pid}.tmp`;
      rmSync(tmp, { force: true });
      this.db.run("VACUUM INTO ?", [tmp]);
      try {
        linkSync(tmp, bak);
      } catch (e) {
        // No hard links here (FAT, exFAT, some shares): rename instead. A backup must never block startup.
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
          try {
            if (!existsSync(bak)) renameSync(tmp, bak);
          } catch (e2) {
            console.error(`mem-sync: could not keep a copy of ledger.db before upgrading (${(e2 as NodeJS.ErrnoException).code ?? "error"}); continuing without it`);
          }
        }
      } finally {
        rmSync(tmp, { force: true });
      }
    }
    this.db.transaction(() => {
      // Re-checked inside the write lock: another agent opening at the same moment may have migrated.
      if (this.version() >= 1) return;
      const old = REKEYED.filter(([t]) => this.isOld(t));
      for (const [t] of old) this.db.exec(`ALTER TABLE ${t} RENAME TO ${t}_old`);
      this.db.exec(SCHEMA);
      for (const [t, cols, order] of old) {
        this.db.run(`INSERT INTO ${t} (hub_id, ${cols}) SELECT ?, ${cols} FROM ${t}_old ORDER BY ${order}`, [hub]);
        this.db.exec(`DROP TABLE ${t}_old`);
      }
      if (old.length > 0) {
        this.db.run("UPDATE status SET key = 'hub.' || ? || '.' || key", [hub]);
        this.db.run("INSERT OR IGNORE INTO folder_hubs (local_project, hub_id) SELECT DISTINCT local_project, ? FROM push_cursors", [hub]);
      }
      this.db.exec("PRAGMA user_version = 1");
    }).immediate();
  }

  forHub(hubId: string): HubLedger {
    return new HubLedger(this, hubId);
  }

  /** Every hub id that has rows or status in the ledger. */
  hubIds(): string[] {
    const rows = this.db.query(
      `SELECT hub_id FROM folder_hubs UNION SELECT hub_id FROM pull_cursors UNION SELECT hub_id FROM deletion_cursors
       UNION SELECT hub_id FROM pending_pulls UNION SELECT hub_id FROM push_retries
       UNION SELECT substr(key, 5, instr(substr(key, 5), '.') - 1) FROM status WHERE key LIKE 'hub.%'`,
    ).all() as { hub_id: string }[];
    return rows.map((r) => r.hub_id);
  }

  folderHub(project: string): string | null {
    return (this.db.query("SELECT hub_id FROM folder_hubs WHERE local_project = ?").get(project) as { hub_id: string } | null)?.hub_id ?? null;
  }

  setFolderHub(project: string, hubId: string): void {
    this.db.run("INSERT INTO folder_hubs (local_project, hub_id) VALUES (?, ?) ON CONFLICT (local_project) DO UPDATE SET hub_id = excluded.hub_id", [project, hubId]);
  }

  /** True when the person turned off sharing this folder's branch, commit and PR. */
  gitOff(project: string): boolean {
    return this.db.query("SELECT 1 FROM git_off WHERE local_project = ?").get(project) !== null;
  }

  /** Off also forgets the folder's timeline, so nothing captured before can label notes pushed after it's back on. */
  setGitOff(project: string, off: boolean): void {
    this.db.transaction(() => {
      this.db.run(off ? "INSERT OR IGNORE INTO git_off (local_project) VALUES (?)" : "DELETE FROM git_off WHERE local_project = ?", [project]);
      if (off) this.db.run("DELETE FROM git_context WHERE local_project = ?", [project]);
    })();
  }

  /**
   * Forgets a removed hub: its cursors, queues and status. Push and import marks stay, and so does its folder
   * ownership: the hub that links such a folder next finds an owner that isn't configured, resets the
   * folder's push state and takes it over with its whole history (runSyncCycle).
   */
  dropHub(hubId: string): void {
    this.db.transaction(() => {
      for (const t of ["pull_cursors", "deletion_cursors", "pending_pulls", "push_retries"]) this.db.run(`DELETE FROM ${t} WHERE hub_id = ?`, [hubId]);
      this.db.run("DELETE FROM status WHERE substr(key, 1, ?) = ?", [statusPrefix(hubId).length, statusPrefix(hubId)]);
    })();
  }

  /**
   * Makes the agent re-send a project from the start: drops its push cursors, its push retries on every
   * hub, its hub ownership, and the summary and session_mem marks of the given memory ids. Imported
   * marks are kept, so teammates' notes are never pushed back. Returns how many cursors and marks were removed.
   */
  resetPush(project: string, memIds: string[]): { cursors: number; marks: number } {
    return this.db.transaction(() => {
      const cursors = this.db.run("DELETE FROM push_cursors WHERE local_project = ?", [project]).changes;
      this.db.run("DELETE FROM push_retries WHERE local_project = ?", [project]);
      this.db.run("DELETE FROM folder_hubs WHERE local_project = ?", [project]);
      const q = this.db.query("DELETE FROM pushed WHERE kind IN ('summary', 'session_mem') AND global_key = ?");
      let marks = 0;
      for (const id of memIds) marks += q.run(id).changes;
      return { cursors, marks };
    })();
  }

  /** Extends the session's latest entry when nothing changed, else starts a new one (and prunes entries unseen for 30 days). */
  recordGit(project: string, sessionId: string | null, g: GitValues, now = Date.now()): void {
    this.db.transaction(() => {
      const last = this.db.query("SELECT id, remote, branch, commit_sha FROM git_context WHERE local_project = ? AND session_id IS ? ORDER BY id DESC LIMIT 1")
        .get(project, sessionId) as { id: number; remote: string | null; branch: string | null; commit_sha: string | null } | null;
      if (last && last.remote === g.remote && last.branch === g.branch && last.commit_sha === g.commit) {
        this.db.run("UPDATE git_context SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?", [now, last.id]);
        return;
      }
      this.db.run(
        "INSERT INTO git_context (local_project, session_id, remote, branch, commit_sha, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [project, sessionId, g.remote, g.branch, g.commit, now, now],
      );
      this.db.run("DELETE FROM git_context WHERE last_seen_at < ?", [now - GIT_KEEP_MS]);
    })();
  }

  /** The entry in effect at `atMs`: the latest started by then (the session's own first), unless last seen over 12 h before. */
  gitAt(project: string, atMs: number, sessionId: string | null = null): GitEntry | null {
    const latest = (session: string | null) =>
      this.db.query(
        `SELECT remote, branch, commit_sha AS "commit", first_seen_at, last_seen_at FROM git_context
         WHERE local_project = ? AND first_seen_at <= ? ${session === null ? "" : "AND session_id = ?"} ORDER BY first_seen_at DESC, id DESC LIMIT 1`,
      ).get(...(session === null ? [project, atMs] : [project, atMs, session])) as GitEntry | null;
    const fresh = (e: GitEntry | null) => (e && atMs - e.last_seen_at <= GIT_MAX_GAP_MS ? e : null);
    return (sessionId === null ? null : fresh(latest(sessionId))) ?? fresh(latest(null));
  }

  /** The last PR lookup for a branch; number, state and url are null when it found no PR. */
  prFor(remote: string, branch: string): { number: number | null; state: PrState | null; url: string | null; checked_at: number } | null {
    return (this.db.query("SELECT number, state, url, checked_at FROM git_prs WHERE remote = ? AND branch = ?").get(remote, branch) as
      { number: number | null; state: PrState | null; url: string | null; checked_at: number } | null) ?? null;
  }

  setPr(remote: string, branch: string, pr: { number: number; state: PrState; url: string } | null, checkedAt: number): void {
    this.db.run("INSERT OR REPLACE INTO git_prs (remote, branch, number, state, url, checked_at) VALUES (?, ?, ?, ?, ?, ?)", [
      remote, branch, pr?.number ?? null, pr?.state ?? null, pr?.url ?? null, checkedAt,
    ]);
  }

  close(): void {
    this.db.close();
  }
}

const statusPrefix = (hubId: string) => `hub.${hubId}.`;

/**
 * One hub's view of the ledger: pull and deletion cursors, pending pulls, push retries and status are
 * that hub's; push cursors and pushed/imported marks are laptop-wide (folder_hubs gives each folder one hub).
 */
export class HubLedger {
  readonly db: Database;

  constructor(private readonly L: Ledger, readonly hubId: string) {
    this.db = L.db;
  }

  /** Claims the folder's push state for this hub when no hub owns it; true when this hub owns it. */
  claimFolder(project: string): boolean {
    this.db.run("INSERT OR IGNORE INTO folder_hubs (local_project, hub_id) VALUES (?, ?)", [project, this.hubId]);
    return this.L.folderHub(project) === this.hubId;
  }

  getPushCursor(project: string, table: PushTable): number {
    const r = this.db.query("SELECT last_local_id FROM push_cursors WHERE local_project = ? AND table_name = ?").get(project, table) as
      | { last_local_id: number }
      | null;
    return r?.last_local_id ?? 0;
  }

  setPushCursor(project: string, table: PushTable, id: number): void {
    this.db.run(
      `INSERT INTO push_cursors (local_project, table_name, last_local_id) VALUES (?, ?, ?)
       ON CONFLICT (local_project, table_name) DO UPDATE SET last_local_id = excluded.last_local_id`,
      [project, table, id],
    );
  }

  getPullCursor(spaceId: number): number {
    const r = this.db.query("SELECT last_seq FROM pull_cursors WHERE hub_id = ? AND space_id = ?").get(this.hubId, spaceId) as { last_seq: number } | null;
    return r?.last_seq ?? 0;
  }

  setPullCursor(spaceId: number, seq: number): void {
    this.db.run(
      "INSERT INTO pull_cursors (hub_id, space_id, last_seq) VALUES (?, ?, ?) ON CONFLICT (hub_id, space_id) DO UPDATE SET last_seq = excluded.last_seq",
      [this.hubId, spaceId, seq],
    );
  }

  getDeletionCursor(spaceId: number): number {
    const r = this.db.query("SELECT last_id FROM deletion_cursors WHERE hub_id = ? AND space_id = ?").get(this.hubId, spaceId) as { last_id: number } | null;
    return r?.last_id ?? 0;
  }

  setDeletionCursor(spaceId: number, id: number): void {
    this.db.run(
      "INSERT INTO deletion_cursors (hub_id, space_id, last_id) VALUES (?, ?, ?) ON CONFLICT (hub_id, space_id) DO UPDATE SET last_id = excluded.last_id",
      [this.hubId, spaceId, id],
    );
  }

  forgetImported(kind: LedgerKind, keys: string[]): void {
    const q = this.db.query("DELETE FROM imported WHERE kind = ? AND global_key = ?");
    this.db.transaction(() => {
      for (const k of keys) q.run(kind, k);
    })();
  }

  isPushed(kind: LedgerKind, key: string): boolean {
    return this.db.query("SELECT 1 FROM pushed WHERE kind = ? AND global_key = ?").get(kind, key) !== null;
  }

  markPushed(kind: LedgerKind, keys: string[]): void {
    const q = this.db.query("INSERT OR IGNORE INTO pushed (kind, global_key, pushed_at) VALUES (?, ?, ?)");
    this.db.transaction(() => {
      for (const k of keys) q.run(kind, k, Date.now());
    })();
  }

  isImported(kind: LedgerKind, key: string): boolean {
    return this.db.query("SELECT 1 FROM imported WHERE kind = ? AND global_key = ?").get(kind, key) !== null;
  }

  markImported(records: { kind: string; key: string }[]): void {
    const q = this.db.query("INSERT OR IGNORE INTO imported (kind, global_key, imported_at) VALUES (?, ?, ?)");
    this.db.transaction(() => {
      for (const r of records) q.run(r.kind, r.key, Date.now());
    })();
  }

  addPendingPull(spaceId: number, records: SyncRecord[]): void {
    this.db.run("INSERT INTO pending_pulls (hub_id, space_id, payload, created_at) VALUES (?, ?, ?, ?)", [this.hubId, spaceId, JSON.stringify(records), Date.now()]);
  }

  pendingPulls(spaceId: number): { id: number; records: SyncRecord[] }[] {
    return (this.db.query("SELECT id, payload FROM pending_pulls WHERE hub_id = ? AND space_id = ? ORDER BY id").all(this.hubId, spaceId) as {
      id: number;
      payload: string;
    }[]).map((r) => ({ id: r.id, records: JSON.parse(r.payload) as SyncRecord[] }));
  }

  /** Keep only these records in a pending batch (the rest were imported). Attempts are kept. */
  replacePendingPull(id: number, records: SyncRecord[]): void {
    this.db.run("UPDATE pending_pulls SET payload = ? WHERE id = ? AND hub_id = ?", [JSON.stringify(records), id, this.hubId]);
  }

  deletePendingPull(id: number): void {
    this.db.run("DELETE FROM pending_pulls WHERE id = ? AND hub_id = ?", [id, this.hubId]);
  }

  bumpPendingAttempts(id: number): number {
    this.db.run("UPDATE pending_pulls SET attempts = attempts + 1 WHERE id = ? AND hub_id = ?", [id, this.hubId]);
    return (this.db.query("SELECT attempts FROM pending_pulls WHERE id = ? AND hub_id = ?").get(id, this.hubId) as { attempts: number } | null)?.attempts ?? 0;
  }

  /**
   * Remembers a row the hub rejected for a missing parent session, to re-send later. A row already
   * held keeps its attempts and first failure time.
   */
  addPushRetry(project: string, kind: PushRetry["kind"], key: string, localId: number, error: string, now = Date.now()): void {
    this.db.run(
      `INSERT INTO push_retries (hub_id, local_project, kind, global_key, local_id, attempts, last_error, first_failed_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT (hub_id, local_project, kind, global_key) DO UPDATE SET local_id = excluded.local_id, last_error = excluded.last_error`,
      [this.hubId, project, kind, key, localId, error, now],
    );
  }

  pushRetries(project: string): PushRetry[] {
    return this.db
      .query("SELECT kind, global_key, local_id, attempts, last_error, first_failed_at FROM push_retries WHERE hub_id = ? AND local_project = ? ORDER BY rowid")
      .all(this.hubId, project) as PushRetry[];
  }

  /** Counts a failed re-send and returns the attempts so far. */
  bumpPushRetry(project: string, kind: PushRetry["kind"], key: string, error: string): number {
    this.db.run(
      "UPDATE push_retries SET attempts = attempts + 1, last_error = ? WHERE hub_id = ? AND local_project = ? AND kind = ? AND global_key = ?",
      [error, this.hubId, project, kind, key],
    );
    return (this.db.query("SELECT attempts FROM push_retries WHERE hub_id = ? AND local_project = ? AND kind = ? AND global_key = ?")
      .get(this.hubId, project, kind, key) as { attempts: number } | null)?.attempts ?? 0;
  }

  deletePushRetry(project: string, kind: PushRetry["kind"], key: string): void {
    this.db.run("DELETE FROM push_retries WHERE hub_id = ? AND local_project = ? AND kind = ? AND global_key = ?", [this.hubId, project, kind, key]);
  }

  resetPush(project: string, memIds: string[]): { cursors: number; marks: number } {
    return this.L.resetPush(project, memIds);
  }

  setStatus(key: string, value: string): void {
    this.db.run("INSERT INTO status (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [statusPrefix(this.hubId) + key, value]);
  }

  /**
   * Records how a sync cycle (or sign-in check) ended. `failing_since` holds the epoch ms of the first
   * failure in the current run of failures: set when a failure follows a non-failure, cleared by "ok".
   * "paused" and "" are not failures.
   */
  recordStatus(status: string, error: string, now = Date.now()): void {
    const failing = status !== "" && status !== "ok" && status !== "paused";
    this.db.transaction(() => {
      this.setStatus("last_status", status);
      this.setStatus("last_error", error);
      if (!failing) this.setStatus("failing_since", "");
      else if (!this.status().failing_since) this.setStatus("failing_since", String(now));
    })();
  }

  /** "Never share" changes this hub missed (folder -> on), reapplied by its next cycle. */
  neverPending(): Record<string, boolean> {
    try {
      return JSON.parse(this.status().never_pending || "{}");
    } catch {
      return {};
    }
  }

  /** Records one folder's missed change; re-reads first, so other folders' entries written meanwhile stay. */
  addNeverPending(project: string, on: boolean): void {
    this.writeNeverPending({ ...this.neverPending(), [project]: on });
  }

  /** Drops one folder's entry; with `applied`, only while it still holds that value (not changed since). */
  clearNeverPending(project: string, applied?: boolean): void {
    const pending = this.neverPending();
    if (!(project in pending) || (applied !== undefined && pending[project] !== applied)) return;
    delete pending[project];
    this.writeNeverPending(pending);
  }

  private writeNeverPending(pending: Record<string, boolean>): void {
    this.setStatus("never_pending", Object.keys(pending).length ? JSON.stringify(pending) : "");
  }

  /** This hub's status keys, unprefixed. */
  status(): Record<string, string> {
    const p = statusPrefix(this.hubId);
    const rows = this.db.query("SELECT key, value FROM status WHERE substr(key, 1, ?) = ?").all(p.length, p) as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key.slice(p.length), r.value]));
  }
}
