import type { Kind, ObservationRow, SessionRow, SummaryRow, SyncRecord } from "./types";

export function sessionKey(r: Pick<SessionRow, "content_session_id">): string {
  return r.content_session_id;
}

/** Mirrors claude-mem 10.5.6 importObservation: memory_session_id + title + created_at_epoch. */
export function observationKey(
  r: Pick<ObservationRow, "memory_session_id" | "title" | "created_at_epoch">,
): string {
  return `${r.memory_session_id}|${r.title ?? ""}|${r.created_at_epoch}`;
}

/** claude-mem imports at most one summary per session. */
export function summaryKey(r: Pick<SummaryRow, "memory_session_id">): string {
  return r.memory_session_id;
}

export function keyFor(kind: Kind, payload: object): string {
  switch (kind) {
    case "session":
      return sessionKey(payload as unknown as SessionRow);
    case "observation":
      return observationKey(payload as unknown as ObservationRow);
    case "summary":
      return summaryKey(payload as unknown as SummaryRow);
  }
}

type PayloadOf<K extends Kind> = Extract<SyncRecord, { kind: K }>["payload"];

export function toRecord<K extends Kind>(kind: K, payload: PayloadOf<K>): Extract<SyncRecord, { kind: K }> {
  return {
    kind,
    key: keyFor(kind, payload),
    payload,
  } as Extract<SyncRecord, { kind: K }>;
}
