#!/usr/bin/env node
// Run by Claude Code hooks. Starts the mem-sync agent if needed (replacing one older than this
// plugin, e.g. after /plugin update) and asks it to sync. If Bun is missing it says how to install
// it; it never installs anything itself. It also warns when sync isn't working (`kick.mjs prompt`,
// on every prompt, does only that, and sends the folder's git branch to the agent). It never opens
// the browser. It must never block a session: it always exits 0 within 4 seconds.
const hookStart = Date.now();
/** Starting or replacing the agent must be done by then, leaving time for the sync request. */
const AGENT_DEADLINE = hookStart + 3000;
/** A missing agent whose agent.log changed this recently is probably still starting. */
const AGENT_START_GRACE_MS = 20_000;
/** SessionStart/End: the sync request ends by then (exit at 4 s). */
const SYNC_BY = hookStart + 3500;
/** A timeout for one request: at most `max`, ending by `until`, never under 50 ms. */
const timeLeft = (until, max) => Math.max(50, Math.min(max, until - Date.now()));
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  agentVerdict, ensureAgent, entry, findBun, gitContext, home, installedVersion, manualBunInstall, noteKeptAgent, noticeMessage,
  noticeProblem, planNotice, postGitContext, probeHealth, readHookInput, readNoticeState, requestSync, stateFromHealth, writeNoticeState,
} from "./common.mjs";

const hook = process.argv[2];
const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

const CLAUDE_MEM_NOTICE =
  "mem-sync needs claude-mem. Run: /plugin marketplace add thedotmack/claude-mem then /plugin install claude-mem@thedotmack, and start a new session.";
// The person runs it, or asks Claude to (in the open, through the normal Bash permission).
const BUN_MISSING_NOTICE =
  `mem-sync needs Bun (https://bun.sh) to run its local sync agent. Install it with: ${manualBunInstall()} — then start a new session. Claude can run that command for you if you ask.`;

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

async function main() {
  if (hook === "start" && !claudeMemInstalled()) notices.push(CLAUDE_MEM_NOTICE);
  // Started before the health probe so their delays overlap.
  const git = hook === "prompt" ? captureGit() : null;
  const health = await probeHealth();
  if (hook === "prompt") return Promise.all([notify(health), git]);
  const { syncable, started } = await keepAgentRunning(health);
  // A cold start or a replacement changed what answers: ask the agent that is there now.
  const current = started ? await probeHealth(timeLeft(SYNC_BY - 400, 400)) : health;
  if (syncable && current) await requestSync(timeLeft(SYNC_BY, 400));
  await notify(current);
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
  // only a missing agent needs Bun, and SessionStart says how to install it.
  if (!existsSync(entry)) return { syncable: verdict !== "down", started: false };
  const bun = findBun(Math.max(100, Math.min(1000, AGENT_DEADLINE - Date.now() - 1500)));
  if (!bun) {
    if (verdict === "down" && hook === "start") notices.push(BUN_MISSING_NOTICE);
    return { syncable: verdict !== "down", started: false };
  }
  // Waits for a cold start for at most ~1.5 s; a replacement is bounded by AGENT_DEADLINE.
  const notice = await ensureAgent(bun, { deadline: AGENT_DEADLINE, waitMs: 1500, health });
  if (notice && hook === "start") notices.push(notice);
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

/**
 * Tells the user when sync isn't working, throttled by notice.json (see planNotice). "down" is
 * only reported per prompt: SessionStart has just tried to start the agent, which may still be
 * booting; while it is, SessionStart still shows the problem notice.json knows of.
 */
async function notify(health) {
  const now = Date.now();
  const stored = readNoticeState();
  if (!health && hook === "start" && stored && stored.problem !== "down") {
    writeNoticeState({ ...stored, lastShownAt: now });
    notices.push(noticeMessage(stored.problem, null));
    return;
  }
  let problem = noticeProblem(health, now);
  if (problem === "down" && (hook !== "prompt" || agentJustStarted(now))) problem = null;
  const plan = planNotice(stored, problem, { hook, now, ok: stateFromHealth(health) === "ok" });
  if (JSON.stringify(plan.state) !== JSON.stringify(stored)) writeNoticeState(plan.state);
  if (plan.show === "recovered") notices.push(noticeMessage("recovered", health));
  // Without Bun the agent can't start, so a new session wouldn't help: say what's missing instead.
  else if (plan.show) notices.push(problem === "down" && !findBun(300) ? BUN_MISSING_NOTICE : noticeMessage(problem, health));
}

// UserPromptSubmit probes health and captures git (stdin 200 ms + git 500 ms + post 300 ms at worst).
setTimeout(done, hook === "prompt" ? 1500 : 4000).unref();
main().catch(() => {}).finally(done);
