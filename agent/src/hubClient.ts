import type { AuthAdapter } from "./auth/adapter";
import { SignInNeeded } from "./cloudflared";
import type { PulledRecord, SyncRecord } from "../../shared/src/types";

export class HubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface MappingView {
  id: number;
  local_project: string;
  space_id: number;
  space_name: string | null;
  space_access?: boolean;
  space_archived: boolean;
  enabled: boolean;
}

export interface HubConnection {
  hubUrl: string;
  apiKey: string;
  cfClientId?: string;
  cfClientSecret?: string;
}

export class HubClient {
  constructor(private readonly hubUrl: string, private readonly adapter: AuthAdapter, private readonly timeoutMs = 15_000) {}

  get url(): string {
    return this.hubUrl;
  }

  async raw(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    const res = await fetch(new URL(path, this.hubUrl), {
      method,
      headers: { "content-type": "application/json", "x-mem-sync": "1", ...(await this.adapter.headers()) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data: ({ error?: string } & Record<string, unknown>) | null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = null;
    }
    if (!res.ok && this.adapter.classify(res, data !== null) === "signin") {
      this.adapter.invalidate();
      throw new SignInNeeded(this.adapter.signInMessage());
    }
    if (data === null) {
      throw new HubError(res.status, `hub response was not JSON (status ${res.status}); check the hub URL and Cloudflare Access service token`);
    }
    if (!res.ok) throw new HubError(res.status, data.error ?? `hub returned ${res.status}`);
    return data;
  }

  features(): Promise<{ ask?: boolean; git_context?: boolean }> {
    return this.raw("GET", "/v1/features") as Promise<{ ask?: boolean; git_context?: boolean }>;
  }

  me(): Promise<unknown> {
    return this.raw("GET", "/v1/me");
  }

  myMappings(): Promise<{ mappings: MappingView[]; never_sync: string[] }> {
    return this.raw("GET", "/v1/me/mappings") as Promise<{ mappings: MappingView[]; never_sync: string[] }>;
  }

  /** Turns "never share" on or off for a folder; turning it on drops the folder's link first. */
  async setNeverSync(project: string, on: boolean): Promise<void> {
    const mine = await this.myMappings();
    const m = mine.mappings.find((x) => x.local_project === project);
    if (on && m) await this.raw("DELETE", `/v1/me/mappings/${m.id}`);
    const list = mine.never_sync.filter((x) => x !== project);
    await this.raw("PUT", "/v1/me/never-sync", { projects: on ? [...list, project] : list });
  }

  push(spaceId: number, records: SyncRecord[]): Promise<{ accepted: number; skipped: number; rejected: string[] }> {
    return this.raw("POST", "/v1/push", { space_id: spaceId, records }) as Promise<{ accepted: number; skipped: number; rejected: string[] }>;
  }

  pull(spaceId: number, after: number, limit = 500, deletedAfter = 0): Promise<PullPage> {
    return this.raw("GET", `/v1/pull?space_id=${spaceId}&after=${after}&limit=${limit}&deleted_after=${deletedAfter}`) as Promise<PullPage>;
  }
}

export interface PullPage {
  records: PulledRecord[];
  next_after: number;
  has_more: boolean;
  deletions: { id: number; kind: "observation" | "summary"; keys: string[] }[];
  next_deleted_after: number;
}
