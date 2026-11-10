export type Kind = "session" | "observation" | "summary";

export interface SessionRow {
  content_session_id: string;
  memory_session_id: string;
  project: string;
  user_prompt: string | null;
  started_at: string;
  started_at_epoch: number;
  completed_at: string | null;
  completed_at_epoch: number | null;
  status: "active" | "completed" | "failed";
}

/** A session as read from local claude-mem; memory_session_id can still be null. */
export type LocalSessionRow = Omit<SessionRow, "memory_session_id"> & {
  memory_session_id: string | null;
};

export interface ObservationRow {
  memory_session_id: string;
  project: string;
  text: string | null;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string | null;
  narrative: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  discovery_tokens: number;
  created_at: string;
  created_at_epoch: number;
}

export interface SummaryRow {
  memory_session_id: string;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  files_read: string | null;
  files_edited: string | null;
  notes: string | null;
  prompt_number: number | null;
  discovery_tokens: number;
  created_at: string;
  created_at_epoch: number;
}

export type SyncRecord =
  | { kind: "session"; key: string; payload: SessionRow }
  | { kind: "observation"; key: string; payload: ObservationRow }
  | { kind: "summary"; key: string; payload: SummaryRow };

export type PulledRecord = SyncRecord & { seq: number; author: string };

export interface ImportBody {
  sessions: SessionRow[];
  observations: ObservationRow[];
  summaries: SummaryRow[];
}
