import type { HubLedger } from "./ledger";
import type { CycleResult } from "./sync";

/** One hub's sync cycle. */
export interface HubJob {
  id: string;
  label: string;
  run: () => Promise<CycleResult>;
  /** Where a job that throws records its error, so the hub's status shows it. */
  ledger?: Pick<HubLedger, "recordStatus">;
}

export interface AllHubsResult {
  status: CycleResult["status"];
  pushed: number;
  pulled: number;
  error?: string;
  hubs: ({ id: string; label: string } & CycleResult)[];
}

/**
 * Runs each hub's cycle in turn; one hub failing (or throwing) never stops the next. The overall status
 * is the first non-ok hub's; its error is prefixed with the hub's label when there are several hubs.
 */
export async function runAllHubs(jobs: HubJob[]): Promise<AllHubsResult> {
  const hubs: AllHubsResult["hubs"] = [];
  for (const j of jobs) {
    let r: CycleResult;
    try {
      r = await j.run();
    } catch (e) {
      r = { status: "error", pushed: 0, pulled: 0, error: e instanceof Error ? e.message : String(e) };
      j.ledger?.recordStatus(r.status, r.error!);
    }
    hubs.push({ id: j.id, label: j.label, ...r });
  }
  const bad = hubs.find((h) => h.status !== "ok");
  const out: AllHubsResult = {
    status: bad?.status ?? "ok",
    pushed: hubs.reduce((n, h) => n + h.pushed, 0),
    pulled: hubs.reduce((n, h) => n + h.pulled, 0),
    hubs,
  };
  if (bad?.error !== undefined) out.error = hubs.length > 1 ? `${bad.label}: ${bad.error}` : bad.error;
  return out;
}

/** Runs at most one cycle (over every hub) at a time; extra triggers join the running one. */
export class SyncRunner {
  private running: Promise<AllHubsResult | null> | null = null;

  constructor(
    private readonly makeJobs: () => HubJob[],
    private readonly run: (jobs: HubJob[]) => Promise<AllHubsResult> = runAllHubs,
  ) {}

  get busy(): boolean {
    return this.running !== null;
  }

  /** Resolves when no cycle is running (whether the running one succeeds or fails). */
  idle(): Promise<void> {
    return this.running ? this.running.then(() => {}, () => {}) : Promise.resolve();
  }

  trigger(): Promise<AllHubsResult | null> {
    if (this.running) return this.running;
    const jobs = this.makeJobs();
    if (jobs.length === 0) return Promise.resolve(null);
    this.running = this.run(jobs).finally(() => {
      this.running = null;
    });
    return this.running;
  }
}
