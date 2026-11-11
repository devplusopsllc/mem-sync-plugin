import { cleanGit, webRemote, type GitContext } from "../../shared/src/git";
import type { Ledger } from "./ledger";

export const GH_TIMEOUT_MS = 5000;
export const PR_TTL_MS = 10 * 60_000;
export const GH_RETRY_MS = 3600_000;

/** Runs `gh` with these args; "missing" when the binary isn't found. */
export type GhRunner = (args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string } | "missing">;

const runGh: GhRunner = async (args, timeoutMs) => {
  if (!Bun.which("gh")) return "missing";
  // windowsHide: the agent has no console, so without it Windows flashes a console window for every gh call.
  const p = Bun.spawn(["gh", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Race the reads, not just the exit: a child of gh can hold the pipes open after gh is killed.
  const r = await Promise.race([
    Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]).catch(() => null),
    new Promise<null>((res) => (timer = setTimeout(res, timeoutMs, null))),
  ]);
  clearTimeout(timer);
  if (!r) {
    p.kill();
    return { code: -1, stdout: "", stderr: "timed out" };
  }
  return { code: r[2], stdout: r[0], stderr: r[1] };
};

/** The folder name for a cwd, as the plugin names projects: its last non-empty path segment. */
export function projectOfCwd(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

/** What the prompt hook posts to /local/git-context; `remote` is raw and never stored as such. */
export interface CaptureBody { cwd: string; session_id?: string | null; branch?: string | null; commit?: string | null; remote?: string | null }

/** The laptop's git timeline per folder, fed by the prompt hook. */
export class GitContextStore {
  private readonly now: () => number;
  private readonly gh: GhRunner;
  private readonly owned: (project: string) => boolean;
  private readonly inFlight = new Set<string>();
  private readonly running = new Set<Promise<void>>();
  /** When each (remote, branch) was last looked up by this process, including lookups that stored nothing. */
  private readonly tried = new Map<string, number>();
  private ghMissingUntil = 0;

  constructor(private readonly d: { ledger: Ledger; now?: () => number; gh?: GhRunner; owned?: (project: string) => boolean }) {
    this.now = d.now ?? Date.now;
    this.gh = d.gh ?? runGh;
    this.owned = d.owned ?? ((p) => d.ledger.folderHub(p) !== null);
  }

  capture(b: CaptureBody): void {
    const remote = typeof b.remote === "string" ? webRemote(b.remote) : null;
    // The shared bounds, one field at a time: an out-of-bounds value becomes null on its own.
    const branch = cleanGit({ branch: b.branch ?? null })?.branch ?? null;
    const commit = cleanGit({ commit: b.commit ?? null })?.commit ?? null;
    const project = projectOfCwd(b.cwd);
    // Nothing a note could carry, or a root folder ("/", "C:\\") that names no project.
    if ((branch === null && commit === null) || project === "" || /^[A-Za-z]:$/.test(project)) return;
    // Off means not even recorded, so turning it back on can't attach what was captured while off.
    if (this.d.ledger.gitOff(project)) return;
    this.d.ledger.recordGit(project, b.session_id ?? null, { remote, branch, commit }, this.now());
    void this.lookupPr(project, remote, branch);
  }

  /** Looks up the branch's PR with gh, in the background, at most once per branch per 10 minutes. Never throws. */
  lookupPr(project: string, remote: string | null, branch: string | null): Promise<void> {
    // Exactly owner/repo: gh reads a three-part --repo as HOST/OWNER/REPO and would call that host.
    const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(remote ?? "")?.[1] ?? null;
    // A branch starting with "-" (git refuses those) would read as a gh flag; an all-digit one as a PR number.
    if (!repo || !remote || !branch || branch.startsWith("-") || /^#?\d+$/.test(branch) || !this.owned(project) || this.d.ledger.gitOff(project)) return Promise.resolve();
    const now = this.now();
    const key = `${remote}\n${branch}`;
    const last = Math.max(this.tried.get(key) ?? 0, this.d.ledger.prFor(remote, branch)?.checked_at ?? 0);
    if (now < this.ghMissingUntil || this.inFlight.has(key) || (last > 0 && now - last < PR_TTL_MS)) return Promise.resolve();
    this.inFlight.add(key);
    this.tried.set(key, now);
    const run = (async () => {
      try {
        const r = await this.gh(["pr", "view", branch, "--repo", repo, "--json", "number,state,url,isDraft"], GH_TIMEOUT_MS);
        if (r === "missing" || (r.code !== 0 && /gh auth login|not logged in/i.test(r.stderr))) {
          this.ghMissingUntil = this.now() + GH_RETRY_MS;
        } else if (r.code !== 0) {
          if (/no pull requests found/i.test(r.stderr)) this.d.ledger.setPr(remote, branch, null, this.now());
        } else {
          const j = JSON.parse(r.stdout) as { number?: unknown; state?: unknown; url?: unknown; isDraft?: unknown };
          const state = j.isDraft === true && j.state === "OPEN" ? "DRAFT" : j.state;
          const checked = this.now();
          const pr = cleanGit({ branch, pr: { number: j.number, state, url: j.url, checked_at: checked } })?.pr;
          if (pr) this.d.ledger.setPr(remote, branch, pr, checked);
        }
      } catch {
        // A timeout, bad output or a closed ledger stores nothing.
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.running.add(run);
    void run.finally(() => this.running.delete(run));
    return run;
  }

  /** The git context in effect when the note was written, with its branch's PR as of the last check. */
  forNote(project: string, payload: { created_at_epoch: number }, sessionId: string | null): GitContext | null {
    if (this.d.ledger.gitOff(project)) return null;
    const e = this.d.ledger.gitAt(project, payload.created_at_epoch, sessionId);
    if (!e) return null;
    const pr = e.remote && e.branch ? this.d.ledger.prFor(e.remote, e.branch) : null;
    return cleanGit({ remote: e.remote, branch: e.branch, commit: e.commit, pr: pr?.number == null ? undefined : pr });
  }

  /** Resolves when no lookup is in flight (tests). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all(this.running);
  }
}
