import { Database } from "bun:sqlite";
import type { LocalSessionRow, ObservationRow, SummaryRow } from "../../shared/src/types";

const SESSION_COLUMNS = ["content_session_id", "memory_session_id", "project", "user_prompt", "started_at",
  "started_at_epoch", "completed_at", "completed_at_epoch", "status"] as const;
const OBS_COLUMNS = ["memory_session_id", "project", "text", "type", "title", "subtitle", "facts", "narrative",
  "concepts", "files_read", "files_modified", "prompt_number", "discovery_tokens", "created_at",
  "created_at_epoch"] as const;
const SUM_COLUMNS = ["memory_session_id", "project", "request", "investigated", "learned", "completed",
  "next_steps", "files_read", "files_edited", "notes", "prompt_number", "discovery_tokens", "created_at",
  "created_at_epoch"] as const;

const SESSION_COLS = SESSION_COLUMNS.join(", ");
const OBS_COLS = OBS_COLUMNS.join(", ");
const SUM_COLS = SUM_COLUMNS.join(", ");

/**
 * Every table and column the queries below select or filter on. Sync runs against any claude-mem
 * version whose database has all of them; keep this in step with the queries.
 */
export const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  schema_versions: ["version"],
  sdk_sessions: ["id", ...SESSION_COLUMNS],
  observations: ["id", ...OBS_COLUMNS],
  session_summaries: ["id", ...SUM_COLUMNS],
};

export interface SchemaCheck {
  /** max(schema_versions.version), or null when that table is missing. */
  version: number | null;
  /** "table" for a missing table, "table.column" for a missing column. Empty when sync can run. */
  missing: string[];
}

/** Read-only view of a claude-mem database. Never writes. */
export class ClaudeMemReader {
  constructor(private readonly dbPath: string) {}

  private use<T>(fn: (db: Database) => T): T {
    const db = new Database(this.dbPath, { readonly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  schemaVersion(): number {
    return this.use((db) => (db.query("SELECT MAX(version) AS v FROM schema_versions").get() as { v: number | null }).v ?? 0);
  }

  /** Checks claude-mem's tables against REQUIRED_COLUMNS with PRAGMA table_info. */
  checkSchema(): SchemaCheck {
    return this.use((db) => {
      const missing: string[] = [];
      for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
        const have = new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
        if (have.size === 0) missing.push(table);
        else for (const c of cols) if (!have.has(c)) missing.push(`${table}.${c}`);
      }
      const version = missing.some((m) => m.startsWith("schema_versions"))
        ? null
        : ((db.query("SELECT MAX(version) AS v FROM schema_versions").get() as { v: number | null }).v ?? 0);
      return { version, missing };
    });
  }

  readSessions(project: string, afterId: number, limit: number): { id: number; row: LocalSessionRow }[] {
    return this.use((db) =>
      (db.query(`SELECT id, ${SESSION_COLS} FROM sdk_sessions WHERE project = ? AND id > ? ORDER BY id LIMIT ?`)
        .all(project, afterId, limit) as (LocalSessionRow & { id: number })[])
        .map(({ id, ...row }) => ({ id, row })),
    );
  }

  findSessionByMemoryId(project: string, memorySessionId: string): { id: number; row: LocalSessionRow } | null {
    return this.use((db) => {
      const r = db
        .query(`SELECT id, ${SESSION_COLS} FROM sdk_sessions WHERE project = ? AND memory_session_id = ? ORDER BY id LIMIT 1`)
        .get(project, memorySessionId) as (LocalSessionRow & { id: number }) | null;
      if (!r) return null;
      const { id, ...row } = r;
      return { id, row };
    });
  }

  readObservations(project: string, afterId: number, limit: number): { id: number; row: ObservationRow }[] {
    return this.use((db) =>
      (db.query(`SELECT id, ${OBS_COLS} FROM observations WHERE project = ? AND id > ? ORDER BY id LIMIT ?`)
        .all(project, afterId, limit) as (ObservationRow & { id: number })[])
        .map(({ id, ...row }) => ({ id, row })),
    );
  }

  /**
   * Every folder claude-mem knows about. claude-mem's /api/projects only lists projects with
   * observations, so a folder opened in Claude that hasn't recorded a note yet would be missing.
   */
  listProjects(): string[] {
    return this.use((db) =>
      (db.query(`SELECT project FROM sdk_sessions WHERE project IS NOT NULL AND project != ''
                 UNION SELECT project FROM observations WHERE project IS NOT NULL AND project != ''
                 UNION SELECT project FROM session_summaries WHERE project IS NOT NULL AND project != ''
                 ORDER BY project`).all() as { project: string }[]).map((r) => r.project),
    );
  }

  /** One observation of the project by its local id, or null when it is gone. */
  readObservationById(project: string, id: number): ObservationRow | null {
    return this.use((db) =>
      db.query(`SELECT ${OBS_COLS} FROM observations WHERE project = ? AND id = ?`).get(project, id) as ObservationRow | null,
    );
  }

  /** One summary of the project by its local id, or null when it is gone. */
  readSummaryById(project: string, id: number): SummaryRow | null {
    return this.use((db) =>
      db.query(`SELECT ${SUM_COLS} FROM session_summaries WHERE project = ? AND id = ?`).get(project, id) as SummaryRow | null,
    );
  }

  /** Latest summary of each session whose newest summary is older than the cutoff, with its local id. */
  readQuietSummaries(project: string, cutoffEpochMs: number): { id: number; row: SummaryRow }[] {
    return this.use((db) =>
      (db.query(`SELECT s.id, ${SUM_COLS.split(",").map((c) => "s." + c.trim()).join(", ")}
                FROM session_summaries s
                JOIN (SELECT memory_session_id, MAX(id) AS max_id, MAX(created_at_epoch) AS last
                      FROM session_summaries WHERE project = ? GROUP BY memory_session_id) l
                  ON s.id = l.max_id
                WHERE l.last < ? ORDER BY s.id`)
        .all(project, cutoffEpochMs) as (SummaryRow & { id: number })[])
        .map(({ id, ...row }) => ({ id, row })),
    );
  }
}
