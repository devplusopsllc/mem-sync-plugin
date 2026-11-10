import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { ClaudeMemApi } from "../../shared/src/claudeMemApi";
import { ClaudeMemReader } from "./claudeMemDb";
import { DEFAULTS, loadConfig, memSyncHome, usableHub } from "./config";
import { GitContextStore } from "./gitContext";
import { HubSet, type HubHandle } from "./hubs";
import { Ledger } from "./ledger";
import { readAgentVersion, shutdownAgent } from "./lifecycle";
import { SyncRunner } from "./runner";
import { createAgentServer } from "./server";
import type { SyncDeps } from "./sync";

const home = memSyncHome();
mkdirSync(home, { recursive: true });
const startCfg = loadConfig();
const port = Number(process.env.MEM_SYNC_PORT ?? startCfg.port ?? DEFAULTS.port);
const ledger = new Ledger(join(home, "ledger.db"), startCfg.hubs[0]?.id);
const version = readAgentVersion(join(import.meta.dir, "..", ".."));
const pidPath = join(home, "agent.pid");
let syncTimer: ReturnType<typeof setInterval> | undefined;
let stopping = false;

// Every hub has its own AuthFlow (connect, Cloudflare sign-in, method re-discovery). Token sources,
// sign-in processes and the cloudflared binary are shared per hub URL (auth/adapter.ts); a sign-in
// starts only from POST /local/signin or /local/hubs/:id/signin.
const hubs = new HubSet({ ledger, config: startCfg, triggerSync: () => triggerSync(), idle: () => runner.idle() });

// One git timeline for the server (captures) and every hub (attaching git to pushed notes).
// The store itself skips folders with git details off: no git on their notes, no PR lookups.
const git = new GitContextStore({ ledger });

const depsFor = (h: HubHandle): SyncDeps => {
  const c = loadConfig();
  const reader = new ClaudeMemReader(c.claudeMemDbPath);
  return {
    hub: h.client(),
    mem: new ClaudeMemApi(c.claudeMemUrl),
    reader,
    claudeMemDbPath: c.claudeMemDbPath,
    ledger: h.ledger,
    // A folder whose owning hub no longer links it moves to the hub that does.
    ownerMaps: (project) => hubs.ownerKeeps(project),
    summaryQuietMs: c.summaryQuietMs,
    gitFor: (project, payload) =>
      git.forNote(project, payload, reader.findSessionByMemoryId(project, payload.memory_session_id)?.row.content_session_id ?? null),
  };
};

// One cycle syncs every usable hub in turn. A hub's cycle ending "revoked" or "signin" re-reads that
// hub's methods once, inside the same busy period.
const runner = new SyncRunner(() =>
  hubs.list().filter((h) => usableHub(h.config)).map((h) => ({ id: h.config.id, label: h.label, ledger: h.ledger, run: () => h.auth.runCycle()(depsFor(h)) })),
);

/** Every sync trigger (timer, hook, UI button) goes through here so each cycle is logged, one line per hub. */
const triggerSync = async () => {
  if (stopping) return null;
  const r = await runner.trigger();
  for (const h of r?.hubs ?? []) {
    console.log(`${new Date().toISOString()} sync hub=${h.label} status=${h.status} pushed=${h.pushed} pulled=${h.pulled}${h.error ? ` error=${h.error}` : ""}`);
  }
  return r;
};

// The hook sets MEM_SYNC_PORT_WAIT_MS when it replaces an outdated agent: the old one may still
// hold the port for a moment while it finishes, so keep trying to bind for that long.
const portWaitUntil = Date.now() + (Number(process.env.MEM_SYNC_PORT_WAIT_MS) || 0);

/** True when an agent of this same version already answers on the port. */
async function sameVersionRunning(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/local/health`, { signal: AbortSignal.timeout(400) });
    return ((await r.json()) as { version?: unknown })?.version === version;
  } catch {
    return false;
  }
}

let server!: ReturnType<typeof createAgentServer>;
for (;;) {
  try {
    server = serve();
    break;
  } catch (e) {
    if (!/EADDRINUSE|in use/i.test(String(e))) throw e;
    if (Date.now() >= portWaitUntil || (await sameVersionRunning())) {
      console.log(`mem-sync agent already running on port ${port}`);
      ledger.close();
      process.exit(0);
    }
    await Bun.sleep(100);
  }
}

function serve() {
  return createAgentServer({
    port,
    runner,
    triggerSync,
    ledger,
    git,
    hubs,
    listProjects: async () => {
      // Read the folder list straight from claude-mem's database (read-only); its API leaves out
      // folders that have no observations yet. Fall back to the API if the file can't be read.
      try {
        return new ClaudeMemReader(loadConfig().claudeMemDbPath ?? DEFAULTS.claudeMemDbPath).listProjects();
      } catch {
        return new ClaudeMemApi(loadConfig().claudeMemUrl ?? DEFAULTS.claudeMemUrl).listProjects();
      }
    },
    uiDir: join(import.meta.dir, "..", "ui"),
    version,
    shutdown: () => {
      if (stopping) return;
      stopping = true;
      clearInterval(syncTimer);
      console.log(`${new Date().toISOString()} mem-sync agent ${version} stopping (shutdown requested)`);
      void shutdownAgent({ server, runner, ledger, pidPath, pid: process.pid });
    },
    isStopping: () => stopping,
  });
}

writeFileSync(pidPath, String(process.pid));
console.log(`${new Date().toISOString()} mem-sync agent ${version} on http://127.0.0.1:${server.port}`);

// cloudflared is fetched in the background when a hub uses Access (one shared download); a failure lands
// in that hub's status. The first sync waits only for every hub's discovery (which may switch a method),
// never for the download.
for (const h of hubs.list()) if (h.config.auth === "cloudflare-access") h.auth.prepareCloudflared();
void Promise.all(hubs.list().map((h) => h.auth.rediscover())).finally(() => void triggerSync());
syncTimer = setInterval(() => void triggerSync(), loadConfig().syncIntervalMs ?? DEFAULTS.syncIntervalMs);
