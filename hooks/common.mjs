// Used by kick.mjs. Plain Node: it runs before Bun may exist.
import { execFile, spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const IS_WINDOWS = process.platform === "win32";
export const root = process.env.CLAUDE_PLUGIN_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
export const port = Number(process.env.MEM_SYNC_PORT ?? 37778);
export const home = process.env.MEM_SYNC_HOME ?? join(homedir(), ".mem-sync");
export const entry = process.env.MEM_SYNC_AGENT_ENTRY ?? join(root, "agent", "src", "main.ts");
export const base = `http://127.0.0.1:${port}`;

/** Bun's official installer, shown to the person (never run by a hook) when Bun is missing. */
export function manualBunInstall(isWindows = IS_WINDOWS) {
  return isWindows ? 'powershell -c "irm https://bun.sh/install.ps1 | iex"' : "curl -fsSL https://bun.sh/install | bash";
}

/** Creates the mem-sync home private to this user (0700); an existing one is tightened on POSIX. */
export function ensureHome() {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (!IS_WINDOWS) {
    try {
      chmodSync(home, 0o700);
    } catch {}
  }
}

/**
 * Picks Bun from `where bun` (Windows) or `which bun` output lines. On Windows prefers bun.exe,
 * then a .cmd/.bat shim, and skips extensionless results (not runnable without a shell).
 */
export function pickBunFromPathLookup(lines, isWindows = IS_WINDOWS) {
  if (!isWindows) return lines[0] ?? null;
  const lower = (l) => l.toLowerCase();
  return lines.find((l) => lower(l).endsWith(".exe")) ?? lines.find((l) => /\.(cmd|bat)$/.test(lower(l))) ?? null;
}

const env = (name) => (typeof process.env[name] === "string" ? process.env[name].trim() : "");

/**
 * Finds Bun the way claude-mem 13 does: BUN, BUN_PATH, BUN_INSTALL, the usual install folders,
 * then `where`/`which`. MEM_SYNC_BUN_SEARCH_PATHS (path-list) replaces the install folders and
 * the PATH lookup. It is for tests only; don't set it in normal use. Returns null when Bun is not found.
 */
export function findBun(timeoutMs = 1000) {
  const exe = IS_WINDOWS ? "bun.exe" : "bun";
  const bunInstall = env("BUN_INSTALL");
  const override = env("MEM_SYNC_BUN_SEARCH_PATHS");
  const fixed = override
    ? override.split(delimiter)
    : [
        join(homedir(), ".bun", "bin", exe),
        ...(IS_WINDOWS ? [] : ["/usr/local/bin/bun", "/opt/homebrew/bin/bun", "/home/linuxbrew/.linuxbrew/bin/bun"]),
      ];
  const candidates = [
    env("BUN"),
    env("BUN_PATH"),
    bunInstall ? join(bunInstall, "bin", exe) : "",
    bunInstall && IS_WINDOWS ? join(bunInstall, "bun.exe") : "",
    ...fixed,
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  if (override) return null;
  try {
    const r = spawnSync(IS_WINDOWS ? "where" : "which", ["bun"], { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
    if (r.status !== 0 || !r.stdout) return null;
    return pickBunFromPathLookup(r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  } catch {
    return null;
  }
}

export async function healthy(timeoutMs = 400) {
  try {
    const r = await fetch(`${base}/local/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function requestSync(timeoutMs = 400) {
  try {
    await fetch(`${base}/local/sync`, { method: "POST", headers: { "x-mem-sync": "1" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    // The agent's own 5-minute loop will catch up.
  }
}

/** Starts the agent detached with its output in agent.log; `extraEnv` is added to its environment. */
export function startAgent(bun, extraEnv = {}) {
  ensureHome();
  const log = openSync(join(home, "agent.log"), "a");
  const shell = IS_WINDOWS && /\.(cmd|bat)$/i.test(bun); // npm shims need cmd.exe
  const child = spawn(shell ? `"${bun}"` : bun, [shell ? `"${entry}"` : entry], {
    detached: true,
    shell,
    stdio: ["ignore", log, log],
    windowsHide: true,
    env: { ...process.env, MEM_SYNC_HOME: home, MEM_SYNC_PORT: String(port), ...extraEnv },
  });
  child.on("error", () => {});
  child.unref();
}

/** Writes JSON atomically (temp file, then rename) so readers never see half a file. */
function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      // Windows refuses the rename while another process has the file open; retry briefly.
      if (i >= 20) {
        rmSync(tmp, { force: true });
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

// ---- Replacing an outdated agent after /plugin update.

/** "1.2.3" (optionally "v1.2.3" or "1.2.3-x") → [1, 2, 3], else null. */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(typeof v === "string" ? v.trim() : "");
  return m ? m.slice(1).map(Number) : null;
}

/** -1, 0 or 1 comparing a with b by major.minor.patch; null when either is not a version. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * What to do about the agent answering on the port: "down" (nothing answers), "replace" (its
 * version is older than the installed one, or it reports none: a pre-0.2.3 agent) or "keep"
 * (current, newer, or not comparable). Without an installed version nothing is replaced.
 */
export function agentVerdict(health, installed) {
  if (!health) return "down";
  if (!parseVersion(installed)) return "keep";
  // A legacy agent must at least say it is one: a foreign or non-JSON 200 is left alone.
  if (health.version === undefined || health.version === null) return health.service === "mem-sync-agent" ? "replace" : "keep";
  return compareVersions(health.version, installed) === -1 ? "replace" : "keep";
}

/** True for "bun" or "bun.exe", with or without a directory. */
export function isBunImageName(name) {
  if (typeof name !== "string") return false;
  const base = name.trim().split(/[\\/]/).pop().toLowerCase();
  return base === "bun" || base === "bun.exe";
}

/** The installed plugin version from <root>/.claude-plugin/plugin.json, or null. */
export function installedVersion() {
  try {
    const v = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** The agent's /local/health JSON, or null when nothing healthy answers. */
export async function probeHealth(timeoutMs = 400) {
  try {
    const r = await fetch(`${base}/local/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const body = await r.json().catch(() => ({}));
    return body && typeof body === "object" ? body : {};
  } catch {
    return null;
  }
}

/** Appends a timestamped line to agent.log. Never throws. */
export function logAgent(message) {
  try {
    ensureHome();
    appendFileSync(join(home, "agent.log"), `${new Date().toISOString()} [hook] ${message}\n`);
  } catch {}
}

/**
 * True for a command line that is bun running an agent/src/main.ts: how startAgent (in every
 * plugin version) launches the agent. The program may be quoted (Windows); the entry may use / or \.
 */
export function isAgentCommandLine(cmd) {
  const s = typeof cmd === "string" ? cmd.trim() : "";
  const isMain = (rest) => /(^|[\s"'\\/])agent[\\/]src[\\/]main\.ts["']?(\s|$)/.test(rest);
  const q = /^"([^"]+)"\s+(.+)$/.exec(s);
  if (q) return isBunImageName(q[1]) && isMain(q[2]);
  // ps never quotes, so "/Users/Jane Doe/.bun/bin/bun …" splits at a space inside the path: a later
  // split only counts when the part before it is a real file, so "python /x/bun …" never matches.
  return [...s.matchAll(/\s+/g)].some((m, i) => {
    const image = s.slice(0, m.index);
    return isBunImageName(image) && (i === 0 || existsSync(image)) && isMain(s.slice(m.index + m[0].length));
  });
}

/** True only when `pid` is running and its command line is our agent's (see isAgentCommandLine). */
export function isAgentProcess(pid, timeoutMs = 800) {
  try {
    const r = IS_WINDOWS
      ? spawnSync(
          "powershell",
          ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`],
          { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
        )
      : spawnSync("ps", ["-ww", "-p", String(pid), "-o", "args="], { encoding: "utf8", timeout: timeoutMs });
    return r.status === 0 && isAgentCommandLine(String(r.stdout ?? "").trim());
  } catch {
    return false;
  }
}

/** Ends `pid`. True when it was ended or had already exited (ESRCH: nothing left to kill). */
function killPid(pid, timeoutMs = 800) {
  try {
    process.kill(pid);
    return true;
  } catch (e) {
    if (e && e.code === "ESRCH") return true;
  }
  if (!IS_WINDOWS) return false;
  try {
    return spawnSync("taskkill", ["/PID", String(pid), "/F"], { timeout: timeoutMs, windowsHide: true }).status === 0;
  } catch {
    return false;
  }
}

/** False once `pid` has exited; true while it runs or when that can't be told. */
function pidAlive(pid) {
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !(e && e.code === "ESRCH");
  }
}

const toPid = (s) => {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** One pid from a list, or null when there is none or they disagree. */
const onlyPid = (pids) => (pids.length && pids.every((p) => p === pids[0]) ? pids[0] : null);

/**
 * The pid listening on 127.0.0.1:<port> or 0.0.0.0:<port> in `netstat -ano -p TCP` output
 * (Windows), or null. A listening line has foreign address 0.0.0.0:0, so a localized state
 * column still matches.
 */
export function netstatListenerPid(output, port) {
  const pids = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || f[0].toUpperCase() !== "TCP") continue;
    if (f[1] !== `127.0.0.1:${port}` && f[1] !== `0.0.0.0:${port}`) continue;
    if (f[2] !== "0.0.0.0:0" && f[3].toUpperCase() !== "LISTENING") continue;
    const pid = toPid(f[f.length - 1]);
    if (pid) pids.push(pid);
  }
  return onlyPid(pids);
}

/** The pid from `lsof -nP -iTCP:<port> -sTCP:LISTEN -t` output, or null (none, or several). */
export function lsofListenerPid(output) {
  const pids = String(output ?? "").split(/\s+/).filter(Boolean).map(toPid);
  return pids.includes(null) ? null : onlyPid(pids);
}

/** The pid listening on 127.0.0.1:<port>, 0.0.0.0:<port> or *:<port> in `ss -ltnp` output, or null. */
export function ssListenerPid(output, port) {
  const pids = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (!f.some((x) => x === `127.0.0.1:${port}` || x === `0.0.0.0:${port}` || x === `*:${port}`)) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) pids.push(Number(m[1]));
  }
  return onlyPid(pids);
}

/** The pid listening on the agent port on this machine, or null when it can't be determined. */
export function listenerPid(listenPort = port, timeoutMs = 800) {
  const run = (cmd, args) => {
    try {
      const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
      return r.status === 0 && typeof r.stdout === "string" ? r.stdout : null;
    } catch {
      return null;
    }
  };
  if (IS_WINDOWS) {
    const out = run("netstat", ["-ano", "-p", "TCP"]);
    return out === null ? null : netstatListenerPid(out, listenPort);
  }
  const lsof = run("lsof", ["-nP", `-iTCP:${listenPort}`, "-sTCP:LISTEN", "-t"]);
  if (lsof !== null) return lsofListenerPid(lsof);
  const ss = run("ss", ["-ltnp"]);
  return ss === null ? null : ssListenerPid(ss, listenPort);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How long a replacement agent keeps trying to bind the port while the old one finishes. */
const REPLACE_PORT_WAIT_MS = 6000;
/** Kept free before the deadline for starting the new agent after the old one was stopped. */
const START_RESERVE_MS = 300;
/** Below this much time before the deadline an outdated agent is not stopped at all. */
const MIN_REPLACE_MS = 1000;

/** A timeout for one blocking step: at most `max`, ending START_RESERVE_MS before the deadline. */
const stepTimeout = (deadline, max) => Math.max(50, Math.min(max, deadline - Date.now() - START_RESERVE_MS));

const versionOf = (health) => health.version ?? "(no version)";

const LEGACY_LEFT_NOTICE =
  `mem-sync: an older mem-sync agent seems to be running on port ${port}, but it couldn't be confirmed as mem-sync's own process, so it was left running. Stop it yourself, then start a new session.`;

/** Logs why a running agent whose version can't be compared with the installed one is kept. */
export function noteKeptAgent(health, installed) {
  if (!health || !parseVersion(installed)) return;
  if (health.version !== undefined && health.version !== null && compareVersions(health.version, installed) === null) {
    logAgent(`kept running agent with version ${JSON.stringify(health.version)}: it can't be compared with the installed ${installed}`);
  } else if ((health.version === undefined || health.version === null) && health.service !== "mem-sync-agent") {
    logAgent(`port ${port} answers but not as mem-sync-agent; left it alone`);
  }
}

/**
 * Asks an outdated agent to stop. Health is probed again first, and nothing is sent unless the
 * same agent (version and pid) still answers. A 0.2.3+ agent gets POST /local/shutdown; only an
 * HTTP 4xx counts as a refusal, a timeout or reset may just mean it is already stopping. A legacy
 * agent has no such route: the hook kills the process LISTENING on the agent port, only when its
 * command line is bun running an agent/src/main.ts (health already said "mem-sync-agent"). agent.pid
 * is only a detail for the log. Returns { pid, detail } when it asked or killed, { notice } when it
 * left a legacy agent running (logged; the person is told), or null when it left the agent running (logged).
 */
async function stopOutdatedAgent(health, installed, deadline) {
  const running = versionOf(health);
  const now = await probeHealth(stepTimeout(deadline, 400));
  if (!now) return { pid: health.pid, detail: " (it had already stopped)" };
  if (now.version !== health.version || now.pid !== health.pid || now.service !== health.service) {
    logAgent(`agent ${running} changed to ${versionOf(now)} (pid ${now.pid ?? "?"}) before it was stopped; left it running`);
    return null;
  }
  if (health.version !== undefined && health.version !== null) {
    try {
      const r = await fetch(`${base}/local/shutdown`, {
        method: "POST",
        headers: { "x-mem-sync": "1" },
        signal: AbortSignal.timeout(stepTimeout(deadline, 400)),
      });
      if (r.status >= 400 && r.status < 500) {
        logAgent(`agent ${running} refused shutdown (HTTP ${r.status}); left it running`);
        return null;
      }
      return { pid: health.pid, detail: r.ok ? "" : ` (shutdown answered HTTP ${r.status})` };
    } catch (e) {
      return { pid: health.pid, detail: ` (no answer to shutdown: ${e instanceof Error ? e.name : String(e)})` };
    }
  }
  const leave = (why) => {
    logAgent(`agent ${running} is outdated (installed ${installed}) but ${why}; left it running`);
    return { notice: LEGACY_LEFT_NOTICE };
  };
  const pid = listenerPid(port, stepTimeout(deadline, 800));
  if (!pid) return leave(`the process listening on port ${port} could not be identified`);
  if (pid === process.pid) return leave(`port ${port} is held by this hook`);
  // PowerShell can take a second to start on Windows: an answer too late leaves the agent alone.
  if (!isAgentProcess(pid, stepTimeout(deadline, 1500))) return leave(`pid ${pid} listening on port ${port} is not a mem-sync agent (bun running agent/src/main.ts)`);
  let filePid = null;
  try {
    filePid = toPid(readFileSync(join(home, "agent.pid"), "utf8").trim());
  } catch {}
  const detail = filePid === null ? " (agent.pid missing)" : filePid === pid ? " (agent.pid matches)" : ` (agent.pid holds ${filePid}, not the listener ${pid})`;
  if (!killPid(pid, stepTimeout(deadline, 800))) return leave(`killing pid ${pid} failed`);
  return { pid, detail };
}

/** True once health stops answering and `pid` (when known) has exited; false at the deadline. */
async function waitGone(pid, deadline) {
  while (Date.now() < deadline) {
    if (!pidAlive(pid) && !(await healthy(stepTimeout(deadline + START_RESERVE_MS, 400)))) return true;
    await sleep(100);
  }
  return false;
}

/**
 * The one way the hooks start the agent. Looks at what answers on the port: a current (or newer,
 * or not comparable) agent is left alone; a missing one is started; an outdated one is stopped and
 * the agent from this plugin is started with `bun`.
 *
 * Everything is bounded by `deadline`. An outdated agent is only stopped when at least
 * MIN_REPLACE_MS remain, and once it was asked to stop the new agent is always started: it keeps
 * retrying the port (MEM_SYNC_PORT_WAIT_MS), so an old agent still finishing a sync when the
 * deadline comes never leaves the machine without an agent. Then waits up to waitMs (also capped
 * by the deadline) for an agent to answer. Returns a notice for the person when an outdated
 * agent had to be left running because it couldn't be confirmed as ours; otherwise nothing. Never throws.
 */
export async function ensureAgent(bun, { deadline = Date.now() + 3000, waitMs = 1500, health } = {}) {
  if (health === undefined) health = await probeHealth(stepTimeout(deadline, 400));
  const installed = installedVersion();
  const verdict = agentVerdict(health, installed);
  if (verdict === "keep") return noteKeptAgent(health, installed);
  const waitUntil = Math.min(Date.now() + waitMs, deadline);
  if (verdict === "down") {
    startAgent(bun);
    while (Date.now() < waitUntil && !(await healthy())) await sleep(250);
    return;
  }
  if (deadline - Date.now() < MIN_REPLACE_MS) {
    logAgent(`agent ${versionOf(health)} is outdated (installed ${installed}) but this hook has no time left to replace it; left it running`);
    return;
  }
  const stopped = await stopOutdatedAgent(health, installed, deadline);
  if (!stopped) return;
  if (stopped.notice) return stopped.notice;
  const gone = await waitGone(stopped.pid, deadline);
  startAgent(bun, { MEM_SYNC_PORT_WAIT_MS: String(REPLACE_PORT_WAIT_MS) });
  const old = `agent ${versionOf(health)} (pid ${stopped.pid ?? "?"})`;
  logAgent(gone
    ? `replaced ${old} with ${installed}${stopped.detail}`
    : `asked ${old} to stop${stopped.detail}; it still answers, so ${installed} was started to take over the port when it has gone`);
  const until = Math.min(Date.now() + waitMs, deadline);
  while (Date.now() < until && (await probeHealth(stepTimeout(until + START_RESERVE_MS, 400)))?.version !== installed) await sleep(150);
}

// ---- Telling the user when sync isn't working (notice.json throttles the warnings).

export const noticePath = join(home, "notice.json");
/** unreachable/error/paused for less than this (since the failure run began) is a blip and stays quiet. */
const QUIET_BLIP_MS = 15 * 60_000;
/** The same problem is repeated on prompts at most this often (SessionStart always shows it). */
const RENOTICE_MS = 30 * 60_000;
const NOTICE_PROBLEMS = ["signin", "revoked", "not_allowed", "need_key", "unreachable", "error", "paused"];
const QUIET_PROBLEMS = ["unreachable", "error", "paused"];

const isTime = (v) => typeof v === "number" && Number.isFinite(v);
/** True when `ms` have passed since `t`, when `t` is unknown, or when `t` is in the future (the clock went back). */
const elapsed = (now, t, ms) => !isTime(t) || now - t >= ms || now < t;

/** The agent's state from its health; agents up to 0.3.0 have no `state`, only signin_needed. */
export function stateFromHealth(health) {
  if (!health) return "down";
  if (typeof health.state === "string") return health.state;
  return health.signin_needed ? "signin" : "ok";
}

/** The problem to tell the user about, or null: "down" or one of NOTICE_PROBLEMS. */
export function noticeProblem(health, now = Date.now()) {
  const state = stateFromHealth(health);
  if (state === "down") return "down";
  if (!NOTICE_PROBLEMS.includes(state)) return null; // ok, unconfigured (setup handles it), unknown
  if (QUIET_PROBLEMS.includes(state)) {
    // failing_since: when this failure run began. Older agents only have last_success_at, which is
    // too old after a laptop slept overnight, so it is only the fallback.
    const since = "failing_since" in health ? health.failing_since : health.last_success_at;
    if (!elapsed(now, since, QUIET_BLIP_MS)) return null;
  }
  return state;
}

/** Characters never shown from last_error: control, zero-width and bidi (they can disguise text). */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069]/g;

/** last_error made safe to show in one line, or "" when it can't be (too long, or holds a URL). */
function errorDetail(health) {
  if (typeof health?.last_error !== "string") return "";
  const err = health.last_error.replace(UNSAFE_CHARS, "").trim();
  return err.length <= 120 && !err.includes("://") ? err : "";
}

/** The one-line message for a problem (or "recovered"). Hooks never open the browser: the person, or Claude's open tool, does. */
export function noticeMessage(problem, health, { base: url = base } = {}) {
  switch (problem) {
    case "signin":
      return `mem-sync needs re-authentication — sign in at ${url}/signin (or ask Claude to open the mem-sync sign-in)`;
    case "revoked":
      return `mem-sync: your API key was revoked — reconnect at ${url}`;
    case "need_key":
      return `mem-sync needs an API key — open ${url} to connect`;
    case "not_allowed": {
      const err = errorDetail(health);
      return `mem-sync: your account isn't allowed on the hub — ask a mem-sync admin${err ? ` (${err})` : ""}`;
    }
    case "unreachable":
      return "mem-sync can't reach the hub — sync is paused and will catch up";
    case "error":
      return `mem-sync sync is failing — details at ${url}`;
    case "paused":
      return `mem-sync sync is paused — details at ${url}`;
    case "down":
      return "mem-sync agent isn't running — start a new Claude Code session to restart it";
    case "recovered":
      return "mem-sync is syncing again";
    default:
      return null;
  }
}

/**
 * What to tell the user, given the stored notice state and the current problem. Returns
 * { show: "problem" | "recovered" | null, state } where `state` is what notice.json should hold
 * next (null: delete it). `ok` says health is fully ok, so a stored problem is over; no problem
 * without `ok` (a blip, paused, unconfigured) keeps the episode as it is. SessionEnd ("end") never
 * shows anything.
 */
export function planNotice(stored, problem, { hook, now = Date.now(), ok = false }) {
  if (hook === "end") return { show: null, state: stored };
  if (!problem) {
    if (!ok) return { show: null, state: stored };
    return { show: stored?.problem ? "recovered" : null, state: null };
  }
  const same = stored?.problem === problem;
  const state = same ? { ...stored } : { problem, since: now, lastShownAt: null };
  const show = !same || hook === "start" || elapsed(now, state.lastShownAt, RENOTICE_MS);
  if (show) state.lastShownAt = now;
  return { show: show ? "problem" : null, state };
}

/**
 * notice.json { problem, since, lastShownAt }, or null when missing
 * or corrupt (then it is deleted). A time field that isn't a finite number reads as null.
 */
export function readNoticeState(path = noticePath) {
  let s;
  try {
    s = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if (e?.code !== "ENOENT") rmSync(path, { force: true });
    return null;
  }
  if (!s || typeof s !== "object" || !(s.problem === "down" || NOTICE_PROBLEMS.includes(s.problem))) {
    rmSync(path, { force: true });
    return null;
  }
  const time = (v) => (isTime(v) ? v : null);
  return { problem: s.problem, since: time(s.since), lastShownAt: time(s.lastShownAt) };
}

/** Writes notice.json atomically, or deletes it for null. Never throws. */
export function writeNoticeState(state, path = noticePath) {
  try {
    if (!state) return rmSync(path, { force: true });
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeJsonAtomic(path, state);
  } catch {}
}

/** The hook's JSON input on stdin, or null: no stdin, a closed or empty one, bad JSON, or nothing within `timeoutMs`. */
export function readHookInput(timeoutMs = 200) {
  return new Promise((resolve) => {
    let data = "";
    const finish = (v) => {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.destroy(); // a stdin left open must not keep the hook alive
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => { data += c; });
      process.stdin.on("error", () => finish(null));
      process.stdin.on("end", () => {
        try {
          const v = JSON.parse(data);
          finish(v && typeof v === "object" ? v : null);
        } catch {
          finish(null);
        }
      });
    } catch {
      finish(null);
    }
  });
}

/** Where git is started from: Windows looks for a bare "git" in the cwd before PATH, so never the user's folder. */
const hooksDir = dirname(fileURLToPath(import.meta.url));

/** One git command's trimmed output in `cwd`, or null on any failure. */
function git(cwd, args, timeoutMs) {
  return new Promise((done) => {
    // Our own timer too: a killed git's children can hold its pipes open past execFile's timeout.
    const timer = setTimeout(() => done(null), timeoutMs);
    try {
      execFile("git", ["-C", cwd, ...args], { cwd: hooksDir, timeout: timeoutMs, windowsHide: true }, (err, out) => {
        clearTimeout(timer);
        done(err ? null : String(out).trim() || null);
      });
    } catch {
      clearTimeout(timer);
      done(null);
    }
  });
}

/** True when `dir` is the home directory (git prints the real path, forward slashes on Windows). */
function isHomeDir(dir) {
  try {
    return resolve(realpathSync.native(dir)) === resolve(realpathSync.native(homedir()));
  } catch {
    return false;
  }
}

/**
 * The folder's branch (null when detached), short commit and raw origin URL; null when it isn't a repo with
 * commits, git is missing, or the repo is the home directory (a dotfiles repo would label every folder under it).
 */
export async function gitContext(cwd, timeoutMs = 500) {
  const [head, commit, remote, top] = await Promise.all([
    git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], timeoutMs),
    git(cwd, ["rev-parse", "--short", "HEAD"], timeoutMs),
    git(cwd, ["config", "--get", "remote.origin.url"], timeoutMs),
    git(cwd, ["rev-parse", "--show-toplevel"], timeoutMs),
  ]);
  if (top && isHomeDir(top)) return null;
  const branch = head === "HEAD" ? null : head;
  // Credentials never leave the hook, even to loopback: the agent normalises the rest.
  const clean = remote ? remote.replace(/\/\/[^@/]*@/, "//") : remote;
  return branch || commit ? { branch, commit, remote: clean } : null;
}

/** Sends a capture to the local agent (loopback only); every error is swallowed. */
export async function postGitContext(body, timeoutMs = 300) {
  try {
    await fetch(`${base}/local/git-context`, {
      method: "POST",
      headers: { "x-mem-sync": "1", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {}
}
