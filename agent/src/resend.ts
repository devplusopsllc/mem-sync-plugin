/**
 * Re-send one shared folder from the start: `bun agent/src/resend.ts <local_project>`.
 *
 * For notes the hub refused before 0.2.4 (a session renamed by claude-mem 10.x), which the agent's
 * push cursor already passed. Works on the ledger only (~/.mem-sync/ledger.db, or MEM_SYNC_HOME):
 * deletes the folder's push cursors and the summary/session_mem "pushed" marks of its sessions.
 * claude-mem's database is only read. The next sync re-sends the folder; the hub skips what it
 * already has. Stop the agent first: this refuses to run while the agent answers on its port.
 */
import { existsSync } from "fs";
import { join } from "path";
import { ClaudeMemReader } from "./claudeMemDb";
import { DEFAULTS, loadConfig, memSyncHome } from "./config";
import { Ledger } from "./ledger";

/** Resets the project's push state; memory ids come from its sessions in claude-mem (read-only). */
export function resetPushState(ledger: Pick<Ledger, "resetPush">, reader: Pick<ClaudeMemReader, "readSessions">, project: string) {
  const memIds: string[] = [];
  for (let after = 0; ; ) {
    const rows = reader.readSessions(project, after, 500);
    for (const r of rows) if (r.row.memory_session_id) memIds.push(r.row.memory_session_id);
    if (rows.length < 500) break;
    after = rows[rows.length - 1].id;
  }
  return ledger.resetPush(project, memIds);
}

/** True when anything answers HTTP on the agent's port (or the check cannot tell in time). */
async function agentAnswers(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/local/health`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch (e) {
    return e instanceof Error && e.name === "TimeoutError";
  }
}

async function main(): Promise<number> {
  const project = process.argv[2];
  if (!project) {
    console.error("usage: bun agent/src/resend.ts <local_project>");
    return 2;
  }
  const port = Number(process.env.MEM_SYNC_PORT ?? loadConfig().port ?? DEFAULTS.port);
  if (await agentAnswers(port)) {
    console.error(`the mem-sync agent is running on port ${port}: stop the mem-sync agent first, then run this again`);
    return 1;
  }
  const ledgerPath = join(memSyncHome(), "ledger.db");
  if (!existsSync(ledgerPath)) {
    console.error(`no ledger at ${ledgerPath}`);
    return 1;
  }
  const cfg = loadConfig();
  const dbPath = cfg.claudeMemDbPath ?? DEFAULTS.claudeMemDbPath;
  const ledger = new Ledger(ledgerPath, cfg.hubs[0]?.id);
  try {
    const r = resetPushState(ledger, new ClaudeMemReader(dbPath), project);
    console.log(`${project}: removed ${r.cursors} push cursors and ${r.marks} pushed marks; the next sync re-sends it`);
    return 0;
  } finally {
    ledger.close();
  }
}

if (import.meta.main) process.exit(await main());
