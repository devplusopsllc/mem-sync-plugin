import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { memSyncHome } from "./config";
import { CLOUDFLARED_ASSETS, CLOUDFLARED_VERSION, type CloudflaredTarget } from "./cloudflaredPins";

export class SignInNeeded extends Error {
  constructor(message = "Cloudflare Access sign-in required") {
    super(message);
    this.name = "SignInNeeded";
  }
}

export class HubUnreachable extends Error {
  constructor(message = "Hub is unreachable") {
    super(message);
    this.name = "HubUnreachable";
  }
}

const binName = (platform: NodeJS.Platform = process.platform) => (platform === "win32" ? "cloudflared.exe" : "cloudflared");

export function findCloudflared(opts: { home?: string; pathLookup?: () => string | null } = {}): string | null {
  const fromPath = (opts.pathLookup ?? (() => Bun.which("cloudflared")))();
  if (fromPath) return fromPath;
  const local = join(opts.home ?? memSyncHome(), "bin", binName());
  return existsSync(local) ? local : null;
}

export async function installCloudflared(
  opts: { home?: string; fetchImpl?: typeof fetch; platform?: NodeJS.Platform; arch?: string; downloadTimeoutMs?: number } = {},
): Promise<string> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const asset = CLOUDFLARED_ASSETS[`${platform}-${arch}` as CloudflaredTarget];
  if (!asset) throw new Error(`No pinned cloudflared build for ${platform}-${arch}; install cloudflared manually`);

  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.file}`;
  // One deadline covers both the request and reading the body.
  const signal = AbortSignal.timeout(opts.downloadTimeoutMs ?? 120_000);
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("cloudflared download timed out")), { once: true });
  });
  aborted.catch(() => {});
  const download = async () => {
    const res = await (opts.fetchImpl ?? fetch)(url, { signal });
    if (!res.ok) throw new Error(`cloudflared download failed: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
  const bytes = await Promise.race([download(), aborted]);

  const actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (actual !== asset.sha256) {
    throw new Error(`cloudflared download failed verification: sha256 ${actual} != pinned ${asset.sha256}`);
  }

  const binDir = join(opts.home ?? memSyncHome(), "bin");
  mkdirSync(binDir, { recursive: true });
  const dest = join(binDir, binName(platform));
  const tmp = mkdtempSync(join(binDir, ".install-"));
  try {
    const staged = join(tmp, binName(platform));
    if (asset.file.endsWith(".tgz")) {
      const archive = join(tmp, asset.file);
      writeFileSync(archive, bytes);
      // Relative name + cwd: Git-for-Windows tar reads a `C:\...` argument as a remote host.
      const p = Bun.spawn(["tar", "-xzf", `./${asset.file}`], { cwd: tmp, stdout: "ignore", stderr: "pipe", windowsHide: true });
      const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
      if (code !== 0) throw new Error(`tar extraction failed: ${err.trim()}`);
      if (!existsSync(staged)) throw new Error("cloudflared binary missing from archive");
    } else {
      writeFileSync(staged, bytes);
    }
    chmodSync(staged, 0o755);
    renameSync(staged, dest);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return dest;
}

function decodeClaims(jwt: string): { email: string; exp: number } | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
    if (typeof payload?.exp !== "number") return null;
    return { email: typeof payload.email === "string" ? payload.email : "", exp: payload.exp };
  } catch {
    return null;
  }
}

async function defaultProbe(appUrl: string): Promise<boolean> {
  try {
    await fetch(`${appUrl.replace(/\/+$/, "")}/.well-known/mem-sync`, {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    return true;
  } catch {
    return false;
  }
}

const EXPIRY_SKEW_S = 60;
/** `cloudflared access token` only reads a cached token; a run this long is stuck (e.g. a dead network). */
const TOKEN_TIMEOUT_MS = 15_000;

export class AccessTokenSource {
  private cached: { token: string; exp: number } | null = null;
  private readonly now: () => number;
  private readonly probe: (appUrl: string) => Promise<boolean>;

  constructor(
    private opts: {
      appUrl: string;
      bin: () => Promise<string>;
      probe?: (appUrl: string) => Promise<boolean>;
      now?: () => number;
      /** Kills a `cloudflared access token` run that takes longer than this. */
      tokenTimeoutMs?: number;
    },
  ) {
    this.now = opts.now ?? Date.now;
    this.probe = opts.probe ?? defaultProbe;
  }

  async token(): Promise<string> {
    if (this.cached && this.now() < (this.cached.exp - EXPIRY_SKEW_S) * 1000) return this.cached.token;
    this.cached = null;
    const bin = await this.opts.bin();
    // windowsHide: the agent has no console, so without it Windows opens an empty console window for cloudflared.
    const proc = Bun.spawn([bin, "access", "token", `-app=${this.opts.appUrl}`], { stdout: "pipe", stderr: "ignore", stdin: "ignore", windowsHide: true });
    // A stalled run must not hang the sync cycle: kill it and treat it like a failed exit. Racing (not
    // just killing) matters because a child of cloudflared could keep stdout open after the kill.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        proc.kill();
        resolve(null);
      }, this.opts.tokenTimeoutMs ?? TOKEN_TIMEOUT_MS);
    });
    const result = await Promise.race([Promise.all([new Response(proc.stdout).text(), proc.exited]), timedOut]);
    clearTimeout(timer);
    const [out, code] = result ?? ["", -1];
    const token = out.trim();
    if (code !== 0 || !token) {
      if (!(await this.probe(this.opts.appUrl))) throw new HubUnreachable();
      throw new SignInNeeded();
    }
    const claims = decodeClaims(token);
    if (claims) this.cached = { token, exp: claims.exp };
    return token;
  }

  claims(): { email: string; exp: number } | null {
    return this.cached ? decodeClaims(this.cached.token) : null;
  }

  invalidate(): void {
    this.cached = null;
  }
}

/**
 * The first sign-in link in a line of cloudflared output, or null. Only https links to Cloudflare Access
 * (*.cloudflareaccess.com) or to the hub's own host count; trailing punctuation is dropped. The link is
 * shown to the user, so anything else cloudflared (or something on PATH posing as it) prints is ignored.
 */
export function loginUrlIn(line: string, hubUrl: string): string | null {
  let hubHost = "";
  try {
    hubHost = new URL(hubUrl).hostname.toLowerCase();
  } catch {}
  for (const m of line.matchAll(/https?:\/\/\S+/gi)) {
    const raw = m[0].replace(/[.,)"']+$/, "");
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    const host = u.hostname.toLowerCase();
    if (u.protocol === "https:" && (host.endsWith(".cloudflareaccess.com") || (hubHost !== "" && host === hubHost))) return raw;
  }
  return null;
}

export interface SignInState {
  state: "idle" | "running" | "done" | "failed";
  url?: string;
  error?: string;
}

export class SignInProcess {
  private current: SignInState = { state: "idle" };
  private gen = 0;

  constructor(private opts: { appUrl: string; bin: () => Promise<string>; timeoutMs?: number }) {}

  state(): SignInState {
    return { ...this.current };
  }

  start(): void {
    if (this.current.state === "running") return;
    const gen = ++this.gen;
    this.current = { state: "running" };
    void this.run(gen).catch((e) => {
      if (gen === this.gen) this.current = { state: "failed", error: e instanceof Error ? e.message : String(e) };
    });
  }

  private async run(gen: number): Promise<void> {
    let timedOut = false;
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    let onTimeout: () => void = () => {};
    const timeout = new Promise<never>((_, reject) => {
      onTimeout = () => reject(new Error("Sign-in timed out"));
    });
    timeout.catch(() => {});
    // The timer covers bin() too (it may download cloudflared), not just the login process.
    const timer = setTimeout(() => {
      timedOut = true;
      if (gen === this.gen) this.current = { state: "failed", error: "Sign-in timed out" };
      proc?.kill();
      onTimeout();
    }, this.opts.timeoutMs ?? 300_000);

    let bin: string;
    try {
      bin = await Promise.race([this.opts.bin(), timeout]);
    } catch (e) {
      clearTimeout(timer);
      if (timedOut || gen !== this.gen) return;
      throw e;
    }
    if (timedOut) return;
    let p: ReturnType<typeof Bun.spawn>;
    try {
      // windowsHide hides only the console; cloudflared still opens the sign-in in the browser.
      p = Bun.spawn([bin, "access", "login", this.opts.appUrl], { stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true });
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
    proc = p;
    const scan = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      let buf = "";
      const take = (line: string) => {
        if (gen !== this.gen || this.current.state !== "running" || this.current.url) return;
        const url = loginUrlIn(line, this.opts.appUrl);
        if (url) this.current = { ...this.current, url };
      };
      for await (const chunk of stream) {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        lines.forEach(take);
      }
      take(buf);
    };
    const [code] = await Promise.all([p.exited, scan(p.stdout as ReadableStream<Uint8Array>), scan(p.stderr as ReadableStream<Uint8Array>)]);
    clearTimeout(timer);
    if (timedOut || gen !== this.gen) return;
    this.current =
      code === 0
        ? { ...this.current, state: "done" }
        : { ...this.current, state: "failed", error: `cloudflared access login exited with code ${code}` };
  }
}
