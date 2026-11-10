#!/usr/bin/env node
// Run by Claude Code hooks. Starts the mem-sync agent if needed (replacing one older than this
// plugin, e.g. after /plugin update) and asks it to sync. If Bun is missing it starts a one-time
// background install (bun-bootstrap.mjs) instead. It also warns when sync isn't working
// (`kick.mjs prompt`, on every prompt, does only that, and sends the folder's git branch to the agent).
// It must never block a session: it always exits 0 within 4 seconds.
const hookStart = Date.now();
/** Starting or replacing the agent must be done by then, leaving time for the sync request. */
const AGENT_DEADLINE = hookStart + 3000;
/** A missing agent whose agent.log changed this recently is probably still starting. */
const AGENT_START_GRACE_MS = 20_000;
/** SessionStart/End: the sync request ends by then, the sign-in request by START_SIGNIN_BY (exit at 4 s). */
const SYNC_BY = hookStart + 3500;
const START_SIGNIN_BY = hookStart + 3900;
/** UserPromptSubmit: the sign-in request ends by then (exit at 1.5 s). */
const PROMPT_SIGNIN_BY = hookStart + 1400;
/** A timeout for one request: at most `max`, ending by `until`, never under 50 ms. */
const timeLeft = (until, max) => Math.max(50, Math.min(max, until - Date.now()));
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireInstallLock, agentVerdict, bunLogPath, ensureAgent, entry, findBun, gitContext, home, installedVersion, MANUAL_BUN_INSTALL,
  noteKeptAgent, noticeMessage, noticeProblem, planNotice, postGitContext, probeHealth, readBunMarkerState, readHookInput, readNoticeState, releaseInstallLock,
  requestSignin, requestSync, SIGNIN_RETRY_MS, STALE_INSTALL_MS, stateFromHealth, writeBunMarker, writeNoticeState,
} from "./common.mjs";

const hook = process.argv[2];
const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const bootstrapScript = join(dirname(fileURLToPath(import.meta.url)), "bun-bootstrap.mjs");

const CLAUDE_MEM_NOTICE =
  "mem-sync needs claude-mem. Run: /plugin marketplace add thedotmack/claude-mem then /plugin install claude-mem@thedotmack, and start a new session.";
const BUN_INSTALLING_NOTICE =
  "mem-sync is installing Bun in the background (one time). Sync starts automatically when it finishes.";
const BUN_FAILED_NOTICE = `mem-sync couldn't install Bun automatically. Install it with: ${MANUAL_BUN_INSTALL} — then start a new session.`;

const DAY_MS = 24 * 3600_000;

/** Notices for the user, shown as the hook's systemMessage. */
const notices = [];

function done() {
  const message = notices.join("\n");
  // UserPromptSubmit output never carries a decision: a notice must not block the prompt.
  const out = !notices.length
    ? { continue: true, suppressOutput: true }
    : hook === "prompt"
      ? { continue: true, systemMessage: message }
      : { continue: true, suppressOutput: false, systemMessage: message };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

function claudeMemInstalled() {
  try {
    if (readdirSync(join(claudeDir, "plugins", "cache", "thedotmack", "claude-mem")).length) return true;
  } catch {}
  return existsSync(join(claudeDir, "plugins", "marketplaces", "thedotmack"));
}

/**
 * What to do about a missing Bun, given the marker: "installing" (one is running), "failed"
 * (one failed, was interrupted, or finished without Bun, within 24 h) or "start".
 */
function bunVerdict(marker) {
  if (!marker) return "start";
  const age = Date.now() - Number(marker.startedAt ?? 0);
  if (marker.status === "running" && age < STALE_INSTALL_MS) return "installing";
  return age < DAY_MS ? "failed" : "start";
}

/** Writes the running marker and starts bun-bootstrap.mjs detached; it releases the lock when done. */
function launchBootstrap() {
  try {
    writeBunMarker({ startedAt: Date.now(), status: "running" });
    const log = openSync(bunLogPath, "a");
    const child = spawn(process.execPath, [bootstrapScript], {
      detached: true,
      stdio: ["ignore", log, log],
      windowsHide: true,
      env: process.env,
    });
    // A spawn that fails has no pid; its "error" event may only fire after this hook exits.
    if (!child.pid) throw new Error("could not start the Bun installer");
    child.on("error", () => {});
    child.unref();
    return "installing";
  } catch (e) {
    try {
      writeBunMarker({ startedAt: Date.now(), status: "failed", error: e instanceof Error ? e.message : String(e) });
    } catch {}
    releaseInstallLock();
    return "failed";
  }
}

/** Bun is missing: start the background install once, or report one in progress or failed. */
function bootstrapBun() {
  mkdirSync(home, { recursive: true });
  let verdict = bunVerdict(readBunMarkerState());
  if (verdict === "start") {
    if (!acquireInstallLock()) verdict = "installing"; // another session is installing
    else {
      verdict = bunVerdict(readBunMarkerState()); // an install may have finished before we got the lock
      if (verdict === "start") verdict = launchBootstrap();
      else releaseInstallLock();
    }
  }
  notices.push(verdict === "failed" ? BUN_FAILED_NOTICE : BUN_INSTALLING_NOTICE);
}

async function main() {
  if (hook === "start" && !claudeMemInstalled()) notices.push(CLAUDE_MEM_NOTICE);
  // Started before the health probe so their delays overlap.
  const git = hook === "prompt" ? captureGit() : null;
  const health = await probeHealth();
  if (hook === "prompt") return Promise.all([notify(health, PROMPT_SIGNIN_BY), git]);
  const { syncable, started } = await keepAgentRunning(health);
  // A cold start or a replacement changed what answers: ask the agent that is there now.
  const current = started ? await probeHealth(timeLeft(SYNC_BY - 400, 400)) : health;
  // The sync comes before the sign-in request so both fit in the hook's 4 s.
  if (syncable && current) await requestSync(timeLeft(SYNC_BY, 400));
  await notify(current, START_SIGNIN_BY);
}

/** Sends the prompt folder's branch, commit and remote to the agent's timeline. Silent; never throws. */
async function captureGit() {
  try {
    const input = await readHookInput();
    if (typeof input?.cwd !== "string" || input.cwd === "") return;
    const g = await gitContext(input.cwd);
    if (g) await postGitContext({ cwd: input.cwd, session_id: typeof input.session_id === "string" ? input.session_id : null, ...g });
  } catch {}
}

/**
 * Starts, keeps or replaces the agent. `syncable`: false when no agent will be there to sync;
 * `started`: an agent was started (cold start or replacement), so the first health probe is stale.
 */
async function keepAgentRunning(health) {
  const installed = installedVersion();
  const verdict = agentVerdict(health, installed);
  if (verdict === "keep") {
    noteKeptAgent(health, installed);
    return { syncable: true, started: false };
  }
  // Without the agent entry or Bun an outdated agent keeps running (and still gets the sync);
  // only a missing agent triggers the Bun install.
  if (!existsSync(entry)) return { syncable: verdict !== "down", started: false };
  const bun = findBun(Math.max(100, Math.min(1000, AGENT_DEADLINE - Date.now() - 1500)));
  if (!bun) {
    if (verdict === "down") bootstrapBun();
    return { syncable: verdict !== "down", started: false };
  }
  // Waits for a cold start for at most ~1.5 s; a replacement is bounded by AGENT_DEADLINE.
  await ensureAgent(bun, { deadline: AGENT_DEADLINE, waitMs: 1500, health });
  return { syncable: true, started: true };
}

/** True when agent.log was written moments ago: an agent is (re)starting, so "down" may be a cold start. */
function agentJustStarted(now) {
  try {
    return now - statSync(join(home, "agent.log")).mtimeMs < AGENT_START_GRACE_MS;
  } catch {
    return false;
  }
}

/** The "down" notice, unless Bun is still being installed or its install failed. */
function downMessage() {
  const marker = readBunMarkerState();
  const verdict = marker && marker.status !== "done" ? bunVerdict(marker) : "start";
  if (verdict === "installing") return BUN_INSTALLING_NOTICE;
  if (verdict === "failed") return BUN_FAILED_NOTICE;
  return noticeMessage("down", null);
}

/**
 * Tells the user when sync isn't working, throttled by notice.json (see planNotice), and opens the
 * Cloudflare sign-in once per lapse; the sign-in request must end by `signinBy`. notice.json is
 * written before that request, so a hook killed mid-request never opens the browser twice. "down"
 * is only reported per prompt: SessionStart has just tried to start the agent, which may still be
 * booting; while it is, SessionStart still shows the problem notice.json knows of.
 */
async function notify(health, signinBy) {
  const now = Date.now();
  const stored = readNoticeState();
  if (!health && hook === "start" && stored && stored.problem !== "down") {
    writeNoticeState({ ...stored, lastShownAt: now });
    notices.push(noticeMessage(stored.problem, null));
    return;
  }
  let problem = noticeProblem(health, now);
  if (problem === "down" && (hook !== "prompt" || agentJustStarted(now))) problem = null;
  const plan = planNotice(stored, problem, { hook, now, ok: stateFromHealth(health) === "ok", lastSuccessAt: health?.last_success_at });
  if (JSON.stringify(plan.state) !== JSON.stringify(stored)) writeNoticeState(plan.state);
  let opened = false;
  if (plan.autoOpen) {
    const result = await requestSignin(timeLeft(signinBy, 500));
    opened = result === "opened";
    // No answer: one retry later (a 409 is final; a failed retry is not retried again).
    if (result === "failed" && plan.autoOpen === "first") writeNoticeState({ ...plan.state, signinRetryAt: Date.now() + SIGNIN_RETRY_MS });
  }
  if (plan.show === "recovered") notices.push(noticeMessage("recovered", health));
  else if (plan.show) notices.push(problem === "down" ? downMessage() : noticeMessage(problem, health, { opened }));
}

// UserPromptSubmit probes health, may open the browser and captures git (stdin 200 ms + git 500 ms + post 300 ms at worst).
setTimeout(done, hook === "prompt" ? 1500 : 4000).unref();
main().catch(() => {}).finally(done);
