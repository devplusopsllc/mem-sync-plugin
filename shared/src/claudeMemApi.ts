import type { ImportBody, Kind } from "./types";

export interface ImportStats {
  sessionsImported: number;
  sessionsSkipped: number;
  summariesImported: number;
  summariesSkipped: number;
  observationsImported: number;
  observationsSkipped: number;
  /** claude-mem 13.x only: rows it refused (validation, foreign key or unique constraint). */
  sessionsRejected?: number;
  summariesRejected?: number;
  observationsRejected?: number;
}

/** One record claude-mem refused, by kind and index in the caller's ImportBody arrays. */
export interface RejectedRecord {
  kind: Kind;
  index: number;
  reason: string;
}

/**
 * claude-mem 13.x answered 200 but refused some rows. Every other row was imported. The message
 * says "returned 200" so callers that tell HTTP failures from network failures treat it as HTTP.
 */
export class ClaudeMemRejectedError extends Error {
  constructor(readonly rejected: RejectedRecord[], message?: string) {
    super(message ?? `claude-mem /api/import returned 200 with ${rejected.length} rejected rows: ${rejected[0]?.reason ?? ""}`);
    this.name = "ClaudeMemRejectedError";
  }
}

/** A row by kind and index in the caller's ImportBody arrays. */
export interface RowRef {
  kind: Kind;
  index: number;
}

/**
 * One request of a split import failed. Rows of the requests answered before it landed, except
 * `rejected`. `uncertain` rows were in the failed request (it may have committed some of them);
 * `notSent` rows were never sent. The message starts with the failure's own message, so an HTTP
 * failure still says "returned NNN" and a network failure or timeout still reads as one.
 */
export class ClaudeMemPartialImportError extends ClaudeMemRejectedError {
  constructor(
    rejected: RejectedRecord[],
    readonly uncertain: RowRef[],
    readonly notSent: RowRef[],
    readonly failure: unknown,
    part: string,
  ) {
    const why = failure instanceof Error ? failure.message : String(failure);
    super(rejected, `${why} (request ${part} of a split import${rejected.length ? `; ${rejected.length} rows refused before it` : ""})`);
    this.name = "ClaudeMemPartialImportError";
  }
}

/** Largest /api/import body sent at once. claude-mem 13.x refuses bodies over 5 MB with 413. */
export const IMPORT_BODY_LIMIT = 4_000_000;

type Group = "sessions" | "summaries" | "observations";
/** Send order: parents before children. */
const GROUPS: readonly [Group, Kind][] = [["sessions", "session"], ["summaries", "summary"], ["observations", "observation"]];
type WireBody = ImportBody & { prompts: never[] };
interface Chunk {
  body: WireBody;
  /** origin[group][i] = index in the caller's array of the chunk's i-th row. */
  origin: Record<Group, number[]>;
}

const bytes = (s: string) => Buffer.byteLength(s);
const emptyChunk = (): Chunk => ({
  body: { sessions: [], observations: [], summaries: [], prompts: [] },
  origin: { sessions: [], summaries: [], observations: [] },
});

/**
 * Packs the rows, sessions then summaries then observations, into bodies of at most `limit`
 * serialized bytes. A single row larger than the limit goes alone (the worker then answers 413).
 */
function chunkBody(body: ImportBody, limit: number): Chunk[] {
  const base = bytes(JSON.stringify(emptyChunk().body));
  const chunks: Chunk[] = [];
  let cur = emptyChunk();
  let size = base;
  let rows = 0;
  for (const [group] of GROUPS) {
    body[group].forEach((row, index) => {
      const add = bytes(JSON.stringify(row)) + 1; // + separating comma
      if (rows > 0 && size + add > limit) {
        chunks.push(cur);
        cur = emptyChunk();
        size = base;
        rows = 0;
      }
      (cur.body[group] as unknown[]).push(row);
      cur.origin[group].push(index);
      size += add;
      rows++;
    });
  }
  chunks.push(cur);
  return chunks;
}

interface ImportResponse {
  stats: ImportStats;
  rejected?: Partial<Record<Group | "prompts", { index: number; reason: string }[]>>;
}

export class ClaudeMemApi {
  constructor(private readonly baseUrl: string, private readonly timeoutMs = 10_000) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(this.baseUrl + path, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`claude-mem ${path} returned ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return (await res.json()) as T;
  }

  /** Up for any 2xx, and for 13.x's 503 {status:"degraded"} answer (queue trouble; the worker still serves). */
  async health(): Promise<boolean> {
    try {
      const res = await fetch(this.baseUrl + "/api/health", { signal: AbortSignal.timeout(this.timeoutMs) });
      if (res.ok) return true;
      if (res.status !== 503) return false;
      const body = (await res.json().catch(() => null)) as { status?: unknown } | null;
      return body?.status === "degraded";
    } catch {
      return false;
    }
  }

  async listProjects(): Promise<string[]> {
    const body = await this.request<{ projects?: string[] }>("/api/projects");
    return body.projects ?? [];
  }

  /**
   * Prompts are never sent. claude-mem skips duplicates itself. Large bodies are sent in several
   * requests, parents first; an HTTP failure stops there (earlier requests stay committed). Rows
   * claude-mem 13.x refused are reported together at the end as a ClaudeMemRejectedError.
   */
  async importRecords(body: ImportBody): Promise<ImportStats> {
    const total: ImportStats = {
      sessionsImported: 0, sessionsSkipped: 0, summariesImported: 0,
      summariesSkipped: 0, observationsImported: 0, observationsSkipped: 0,
    };
    const rejected: RejectedRecord[] = [];
    const chunks = chunkBody(body, IMPORT_BODY_LIMIT);
    const rows = (cs: Chunk[]): RowRef[] =>
      cs.flatMap((c) => GROUPS.flatMap(([group, kind]) => c.origin[group].map((index) => ({ kind, index }))));
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        const res = await this.request<ImportResponse>("/api/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(chunk.body),
        });
        const refused: RejectedRecord[] = [];
        for (const [group, kind] of GROUPS) {
          for (const r of res.rejected?.[group] ?? []) {
            const index = chunk.origin[group][r.index];
            // Cannot tell which row it was, so no row of this request may be treated as landed.
            if (index === undefined) throw new Error(`claude-mem /api/import returned 200 with a rejected ${kind} at unknown index ${r.index}`);
            refused.push({ kind, index, reason: String(r.reason ?? "rejected") });
          }
        }
        rejected.push(...refused);
        for (const [k, v] of Object.entries(res.stats ?? {})) {
          if (typeof v === "number") (total as unknown as Record<string, number>)[k] = ((total as unknown as Record<string, number>)[k] ?? 0) + v;
        }
      } catch (e) {
        if (chunks.length === 1) throw e;
        throw new ClaudeMemPartialImportError(rejected, rows([chunk]), rows(chunks.slice(i + 1)), e, `${i + 1}/${chunks.length}`);
      }
    }
    if (rejected.length) throw new ClaudeMemRejectedError(rejected);
    return total;
  }
}
