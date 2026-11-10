#!/usr/bin/env node
// Started detached by kick.mjs when Bun is missing, holding bun-install.lock. Runs Bun's official
// installer, records the outcome in bun-install.json, releases the lock, then starts the mem-sync
// agent and asks it to sync. Its stdout/stderr (and the installer's) go to bun-install.log.
import { spawn } from "node:child_process";
import {
  bunInstallCommand, ensureAgent, findBun, readBunMarkerState, releaseInstallLock, requestSync, writeBunMarker,
} from "./common.mjs";

function runInstaller() {
  // MEM_SYNC_BUN_INSTALL_CMD is for tests only (a fake installer, no download); don't set it in normal use.
  const custom = process.env.MEM_SYNC_BUN_INSTALL_CMD?.trim();
  const [cmd, args] = custom ? [custom, []] : bunInstallCommand();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { shell: Boolean(custom), stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
    } catch (e) {
      return resolve(`installer could not start: ${e instanceof Error ? e.message : String(e)}`);
    }
    child.on("error", (e) => resolve(`installer could not start: ${e.message}`));
    child.on("exit", (code, signal) => resolve(code === 0 ? null : `installer exited with ${code ?? signal}`));
  });
}

let finished = false;

function finish(status, error) {
  if (finished) return;
  finished = true;
  try {
    const { error: _old, ...prev } = readBunMarkerState() ?? { startedAt: Date.now() };
    writeBunMarker({ ...prev, status, ...(error ? { error } : {}), finishedAt: Date.now() });
  } finally {
    releaseInstallLock();
  }
  console.log(`[${new Date().toISOString()}] bun install ${status}${error ? `: ${error}` : ""}`);
}

async function main() {
  console.log(`[${new Date().toISOString()}] installing Bun for mem-sync`);
  const failure = await runInstaller();
  if (failure) return finish("failed", failure);
  const bun = findBun();
  if (!bun) return finish("failed", "the installer finished but Bun was not found");
  finish("done");
  await ensureAgent(bun, { deadline: Date.now() + 20_000, waitMs: 15_000 });
  await requestSync();
}

main().catch((e) => {
  console.error(e);
  finish("failed", e instanceof Error ? e.message : String(e));
});
