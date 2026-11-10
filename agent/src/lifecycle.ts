import { readFileSync, rmSync } from "fs";
import { join } from "path";
import type { SyncRunner } from "./runner";

/**
 * The plugin version from <pluginRoot>/.claude-plugin/plugin.json, else package.json, else
 * "unknown". Never throws.
 */
export function readAgentVersion(pluginRoot: string): string {
  for (const file of [[".claude-plugin", "plugin.json"], ["package.json"]]) {
    try {
      const v = JSON.parse(readFileSync(join(pluginRoot, ...file), "utf8"))?.version;
      if (typeof v === "string" && v.trim() !== "") return v.trim();
    } catch {}
  }
  return "unknown";
}

/** Deletes the pid file only when it holds `pid`, so a newer agent's file is left alone. */
export function removePidFileIfOwned(pidPath: string, pid: number): boolean {
  try {
    if (readFileSync(pidPath, "utf8").trim() !== String(pid)) return false;
    rmSync(pidPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

export interface ShutdownOptions {
  server: { stop(): unknown };
  runner: SyncRunner;
  ledger: { close(): void };
  pidPath: string;
  pid: number;
  /** How long a running sync cycle may take to finish. */
  graceMs?: number;
  /** How long server.stop() may take to finish in-flight responses. */
  stopTimeoutMs?: number;
  exit?: (code: number) => void;
}

/** Waits for `p`, but at most `ms`. Never rejects. */
async function within(p: unknown, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.resolve(p).catch(() => {}), new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
  clearTimeout(timer);
}

/**
 * Lets a running sync cycle finish (at most graceMs; the caller already refuses new ones), then
 * stops the server and waits for that (so the 202 for /local/shutdown is flushed), closes the
 * ledger, removes this process's pid file and exits 0.
 */
export async function shutdownAgent(o: ShutdownOptions): Promise<void> {
  await within(o.runner.idle(), o.graceMs ?? 2000);
  try {
    await within(o.server.stop(), o.stopTimeoutMs ?? 1000);
  } catch {}
  try {
    o.ledger.close();
  } catch {}
  removePidFileIfOwned(o.pidPath, o.pid);
  (o.exit ?? process.exit)(0);
}
