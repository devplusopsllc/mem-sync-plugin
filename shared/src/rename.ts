import { withoutGit } from "./git";
import type { ImportBody, Kind, PulledRecord, SyncRecord } from "./types";

export function withProject<T extends SyncRecord>(rec: T, project: string): T {
  return { ...rec, payload: { ...rec.payload, project } } as T;
}

export function stripPrompt<T extends SyncRecord>(rec: T): T {
  if (rec.kind !== "session") return rec;
  return { ...rec, payload: { ...rec.payload, user_prompt: "" } } as T;
}

export function authorLabel(name: string): string {
  return `[mem-sync] shared by ${name}`;
}

/** claude-mem never sees git: its import validation may refuse unknown fields. */
export function toImportBody(records: readonly (SyncRecord | PulledRecord)[]): ImportBody {
  const body: ImportBody = { sessions: [], observations: [], summaries: [] };
  for (const r of records) {
    if (r.kind === "session") body.sessions.push(withoutGit(r.payload));
    else if (r.kind === "observation") body.observations.push(withoutGit(r.payload));
    else body.summaries.push(withoutGit(r.payload));
  }
  return body;
}

/**
 * Stamps the author into the field claude-mem's viewer shows on a note card: an observation's
 * subtitle or a summary's request. Never the title (part of claude-mem's dedup keys). Idempotent:
 * a field that already carries a label, under any name (the author may have been renamed since),
 * is left as it is. Sessions carry the author in user_prompt (authorLabel) instead and are
 * returned unchanged.
 */
export function withAuthorLabel<T extends object>(kind: Kind, payload: T, name: string): T {
  const field = kind === "observation" ? "subtitle" : kind === "summary" ? "request" : null;
  if (!field) return payload;
  const sep = kind === "observation" ? " · " : " — ";
  const cur = (payload as Record<string, unknown>)[field];
  const text = typeof cur === "string" ? cur : "";
  if (text.startsWith("Shared by ") || text.includes(`${sep}shared by `)) return payload;
  return { ...payload, [field]: text.trim() ? `${text}${sep}shared by ${name}` : `Shared by ${name}` };
}
