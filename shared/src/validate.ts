import { keyFor } from "./keys";

export function validateRecord(rec: unknown): string | null {
  if (!rec || typeof rec !== "object") return "record must be an object";
  const r = rec as { kind?: unknown; key?: unknown; payload?: unknown };
  if (r.kind !== "session" && r.kind !== "observation" && r.kind !== "summary") return "unknown kind";
  if (typeof r.key !== "string" || r.key === "") return "missing key";
  if (!r.payload || typeof r.payload !== "object") return "missing payload";
  const p = r.payload as Record<string, unknown>;
  const has = (f: string, t: "string" | "number") => typeof p[f] === t;
  if (r.kind === "session" && !(has("content_session_id", "string") && has("memory_session_id", "string") && has("started_at_epoch", "number"))) {
    return "session is missing required fields";
  }
  if (r.kind === "observation" && !(has("memory_session_id", "string") && has("type", "string") && has("created_at_epoch", "number"))) {
    return "observation is missing required fields";
  }
  if (r.kind === "summary" && !(has("memory_session_id", "string") && has("created_at_epoch", "number"))) {
    return "summary is missing required fields";
  }
  if (keyFor(r.kind, p) !== r.key) return "key does not match payload";
  return null;
}
