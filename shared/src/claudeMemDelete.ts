import { Database } from "bun:sqlite";
import { observationKey, summaryKey } from "./keys";

/**
 * claude-mem has no delete API, so remove the rows straight from its database; its own AFTER DELETE
 * triggers keep the keyword index in step. Throws when the database is missing or locked so the
 * caller can retry later. `project` limits the match to one claude-mem project (the hub passes the space name).
 */
export function deleteFromClaudeMem(dbPath: string, kind: "observation" | "summary", keys: string[], opts: { project?: string } = {}): number {
  const db = new Database(dbPath, { create: false, readwrite: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const want = new Set(keys);
    const table = kind === "observation" ? "observations" : "session_summaries";
    const keyOf = kind === "observation" ? observationKey : summaryKey;
    // The session id is everything before the first "|" (titles may hold "|", ids do not).
    const ids = [...new Set(keys.map((k) => (kind === "observation" ? k.slice(0, Math.max(k.indexOf("|"), 0)) : k)))];
    const cols = kind === "observation" ? "id, memory_session_id, title, created_at_epoch" : "id, memory_session_id";
    const scope = opts.project === undefined ? "" : " AND project = ?";
    const rows: { id: number; memory_session_id: string; title: string | null; created_at_epoch: number }[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      rows.push(...(db.query(`SELECT ${cols} FROM ${table} WHERE memory_session_id IN (${chunk.map(() => "?").join(",")})${scope}`).all(...chunk, ...(opts.project === undefined ? [] : [opts.project])) as typeof rows));
    }
    const del = db.query(`DELETE FROM ${table} WHERE id = ?`);
    let n = 0;
    db.transaction(() => {
      for (const r of rows) if (want.has(keyOf(r))) { del.run(r.id); n++; } // .changes also counts trigger writes
    })();
    return n;
  } finally {
    db.close();
  }
}
