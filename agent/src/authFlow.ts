import { adapterFromConfig, cloudflaredBin, signInProcessFor, tokenSourceFor, type AuthMethodType } from "./auth/adapter";
import { HubUnreachable, SignInNeeded, type AccessTokenSource, type SignInProcess, type SignInState } from "./cloudflared";
import { loadConfig as loadConfigDefault, upsertHub, usableHub, type HubConfig, type HubSave } from "./config";
import { discoverDetailed as discoverDetailedDefault, type AdvertisedMethod, type DiscoverySource } from "./discovery";
import { HubClient, HubError } from "./hubClient";
import type { HubLedger } from "./ledger";
import { runSyncCycle, type CycleResult, type SyncDeps } from "./sync";

export const SIGNIN_ERROR = "sign in to the hub again";
export const NEED_KEY_ERROR = "enter an API key";
/**
 * Ledger status key: the hub URL whose discovery document dropped the configured API-key method in
 * favour of Cloudflare. The saved key stays until a Cloudflare sign-in for that hub succeeds.
 */
export const PENDING_ACCESS_KEY = "pending_access_hub";

export type ConnectReply =
  | { method: "cloudflare-access"; methods: AdvertisedMethod[] }
  | { method: "api-key"; edge: "cloudflare-service-token" | "none"; methods: AdvertisedMethod[] };

export interface AuthStatus {
  auth: AuthMethodType | null;
  signed_in_as: string | null;
  /** JWT `exp` of the cached Access token, in seconds since the epoch. */
  session_expires_at: number | null;
}

/** The hub offers no sign-in method this agent supports. */
export class NoSupportedMethod extends Error {
  constructor() {
    super("the hub offers no sign-in method this agent supports");
  }
}

export interface AuthFlowDeps {
  /** The hub this flow signs in to; the default loadConfig and saveConfig act on this config entry. */
  hubId: string;
  ledger: HubLedger;
  /** Starts a sync cycle (after a sign-in completes). */
  triggerSync: () => Promise<unknown>;
  /** Resolves when no sync cycle is running; a cycle that began before a sign-in finished is waited out. */
  idle?: () => Promise<void>;
  loadConfig?: () => HubConfig | null;
  saveConfig?: (c: HubSave) => void;
  discoverDetailed?: (hubUrl: string) => Promise<{ methods: AdvertisedMethod[]; source: DiscoverySource }>;
  tokensFor?: (hubUrl: string) => Pick<AccessTokenSource, "claims" | "invalidate">;
  signInFor?: (hubUrl: string) => SignInProcess;
  makeHub?: (c: HubConfig) => Pick<HubClient, "me">;
  /** Finds or installs cloudflared. */
  ensureCloudflared?: () => Promise<string>;
  /** How often a running sign-in is checked for completion. */
  pollMs?: number;
}

/**
 * Hub sign-in for the agent: connecting to a hub by URL, the Cloudflare sign-in started from the local
 * UI, and switching method when the hub stops offering the one in use. A sign-in only ever starts from
 * startSignIn (POST /local/signin), never from a sync cycle. Since 0.3.1 (user-approved) the Claude Code
 * plugin hook may open the /signin page once per lapse; the server starts a login only when
 * signInNeeded() says one is wanted.
 */
export class AuthFlow {
  private readonly load: () => HubConfig | null;
  private readonly save: (c: HubSave) => void;
  private readonly disc: (hubUrl: string) => Promise<{ methods: AdvertisedMethod[]; source: DiscoverySource }>;
  private readonly tokensFor: (hubUrl: string) => Pick<AccessTokenSource, "claims" | "invalidate">;
  private readonly signInFor: (hubUrl: string) => SignInProcess;
  private readonly makeHub: (c: HubConfig) => Pick<HubClient, "me">;
  private readonly ensureBin: () => Promise<string>;
  private readonly signIns = new Map<string, SignInProcess>();
  private readonly watching = new Set<SignInProcess>();
  private rediscovering: Promise<void> | null = null;
  /** When the hub last accepted a sign-in (epoch ms), so a "signin" status from before it reads as stale. */
  private lastSignInAt = 0;

  constructor(private readonly d: AuthFlowDeps) {
    this.load = d.loadConfig ?? (() => {
      const h = loadConfigDefault().hubs.find((x) => x.id === d.hubId);
      return h && usableHub(h) ? h : null;
    });
    this.save = d.saveConfig ?? ((c) => void upsertHub(d.hubId, c));
    this.disc = d.discoverDetailed ?? ((u) => discoverDetailedDefault(u));
    this.tokensFor = d.tokensFor ?? tokenSourceFor;
    this.signInFor = d.signInFor ?? signInProcessFor;
    this.makeHub = d.makeHub ?? ((c) => new HubClient(c.hubUrl, adapterFromConfig(c)));
    this.ensureBin = d.ensureCloudflared ?? cloudflaredBin;
  }

  /**
   * The hub a Cloudflare sign-in targets: the configured hub when it uses Cloudflare sign-in, else the
   * hub of a pending switch (rediscover found the hub moved to Cloudflare, or the user chose Cloudflare
   * in connect while a key was saved). A pending switch's config carries no credentials: the saved key
   * and service token stay with the saved hub and are never sent to the hub being signed in to.
   */
  private accessHub(): HubConfig | null {
    const c = this.load();
    if (!c) return null;
    if (c.auth === "cloudflare-access") return c;
    const pending = this.d.ledger.status()[PENDING_ACCESS_KEY];
    if (!pending) return null;
    const { apiKey: _k, cfClientId: _i, cfClientSecret: _s, ...rest } = c;
    return { ...rest, hubUrl: pending, auth: "cloudflare-access" };
  }

  /** Clears the pending switch; with `hubUrl`, only a switch to that hub. */
  private clearPending(hubUrl?: string): void {
    const pending = this.d.ledger.status()[PENDING_ACCESS_KEY];
    if (pending && (hubUrl === undefined || pending === hubUrl)) this.d.ledger.setStatus(PENDING_ACCESS_KEY, "");
  }

  private processFor(hubUrl: string): SignInProcess {
    let p = this.signIns.get(hubUrl);
    if (!p) {
      p = this.signInFor(hubUrl);
      this.signIns.set(hubUrl, p);
    }
    return p;
  }

  /**
   * Reads the hub's methods and picks `method` when advertised, else the first. An API-key choice saves
   * nothing (the key arrives through /local/config). A Cloudflare choice is saved at once only when no
   * key or service token is saved; otherwise it becomes a pending switch and the credentials are dropped
   * only when the sign-in succeeds (signedIn). `hubUrl` must be normalised. Throws HubUnreachable or
   * NoSupportedMethod.
   */
  async connect(hubUrl: string, method?: AuthMethodType): Promise<ConnectReply> {
    const { methods } = await this.disc(hubUrl);
    const chosen = methods.find((m) => m.type === method) ?? methods[0];
    if (!chosen) throw new NoSupportedMethod();
    if (chosen.type === "api-key") {
      // The user picked a key: an earlier Cloudflare choice no longer waits for a sign-in.
      this.clearPending();
      return { method: "api-key", edge: chosen.edge, methods };
    }
    const prev = this.load();
    if (prev?.hubUrl !== hubUrl || prev.auth !== "cloudflare-access") this.d.ledger.setStatus("signed_in_as", "");
    if (prev && prev.auth !== "cloudflare-access" && (prev.apiKey || prev.cfClientId || prev.cfClientSecret)) {
      this.d.ledger.setStatus(PENDING_ACCESS_KEY, hubUrl);
    } else {
      this.save({ hubUrl, auth: "cloudflare-access" });
      this.clearPending();
    }
    this.prepareCloudflared();
    return { method: "cloudflare-access", methods };
  }

  /** Starts (or joins) the Cloudflare sign-in for the configured hub; null when it doesn't use Cloudflare. */
  startSignIn(): SignInState | null {
    const c = this.accessHub();
    if (!c) return null;
    const p = this.processFor(c.hubUrl);
    p.start();
    this.watch(c.hubUrl, p);
    return p.state();
  }

  /**
   * True when a Cloudflare sign-in is wanted: a pending switch, a cycle that ended "signin" or
   * "not_allowed" after the last successful sign-in, or a Cloudflare hub nobody has signed in to yet.
   */
  signInNeeded(): boolean {
    if (!this.accessHub()) return false;
    const st = this.d.ledger.status();
    if (st[PENDING_ACCESS_KEY]) return true;
    const stale = this.lastSignInAt > 0 && Number(st.last_cycle_at || 0) <= this.lastSignInAt;
    if ((st.last_status === "signin" || st.last_status === "not_allowed") && !stale) return true;
    return !this.status().signed_in_as;
  }

  signInState(): SignInState | null {
    const c = this.accessHub();
    return c ? this.processFor(c.hubUrl).state() : null;
  }

  status(): AuthStatus {
    const c = this.load();
    if (!c) return { auth: null, signed_in_as: null, session_expires_at: null };
    if (c.auth !== "cloudflare-access") return { auth: "api-key", signed_in_as: null, session_expires_at: null };
    const claims = this.tokensFor(c.hubUrl).claims();
    return {
      auth: "cloudflare-access",
      signed_in_as: claims?.email || this.d.ledger.status().signed_in_as || null,
      session_expires_at: claims?.exp ?? null,
    };
  }

  /** Waits for a running sign-in to end; on success, checks who signed in and starts a sync. */
  private watch(hubUrl: string, p: SignInProcess): void {
    if (this.watching.has(p)) return;
    this.watching.add(p);
    const tick = () => {
      const s = p.state();
      if (s.state === "running") {
        setTimeout(tick, this.d.pollMs ?? 500);
        return;
      }
      this.watching.delete(p);
      if (s.state === "done") void this.signedIn(hubUrl).catch((e) => console.error("after sign-in:", e));
    };
    tick();
  }

  private async signedIn(hubUrl: string): Promise<void> {
    const c = this.accessHub();
    if (!c || c.hubUrl !== hubUrl) return;
    const L = this.d.ledger;
    // Drop any cached token so the next request reads the one this sign-in produced.
    this.tokensFor(hubUrl).invalidate();
    try {
      const me = (await this.makeHub(c).me()) as { user?: { email?: unknown } };
      // The hub accepted the Cloudflare sign-in: only now is a pending switch saved (dropping the old key).
      const saved = this.load();
      if (saved?.auth !== "cloudflare-access" || saved.hubUrl !== hubUrl) this.save({ hubUrl, auth: "cloudflare-access" });
      this.clearPending();
      L.setStatus("signed_in_as", typeof me?.user?.email === "string" ? me.user.email : "");
      this.lastSignInAt = Date.now();
    } catch (e) {
      if (e instanceof HubError && e.status === 403) {
        L.recordStatus("not_allowed", e.message);
        return;
      }
      if (e instanceof SignInNeeded) {
        L.recordStatus("signin", SIGNIN_ERROR);
        return;
      }
      // Anything else (hub down, 5xx): the sync below reports it.
    }
    // A cycle that started before the login finished would end "signin"; let it end, then sync afresh.
    await this.d.idle?.();
    await this.d.triggerSync();
  }

  /** Finds or downloads cloudflared in the background; a failure is shown in status, never thrown. */
  prepareCloudflared(): void {
    this.ensureBin().then(
      () => this.d.ledger.setStatus("cloudflared_error", ""),
      (e) => {
        const msg = `couldn't get cloudflared: ${e instanceof Error ? e.message : String(e)}`;
        console.error(msg);
        const L = this.d.ledger;
        L.setStatus("cloudflared_error", msg);
        // A pending "signin" stays: its Sign in button reports the same failure when clicked.
        if (L.status().last_status !== "signin") {
          L.recordStatus("error", msg);
        }
      },
    );
  }

  /**
   * Re-reads the hub's methods. If the configured one is no longer offered, switches to the first
   * offered: Cloudflare is saved and status becomes "signin"; an API key sets status "need_key". An
   * unreachable hub changes nothing. Concurrent calls share one discovery.
   */
  rediscover(): Promise<void> {
    if (!this.rediscovering) {
      this.rediscovering = this.doRediscover().finally(() => {
        this.rediscovering = null;
      });
    }
    return this.rediscovering;
  }

  private async doRediscover(): Promise<void> {
    const c = this.load();
    if (!c) return;
    let found: { methods: AdvertisedMethod[]; source: DiscoverySource };
    try {
      found = await this.disc(c.hubUrl);
    } catch (e) {
      if (!(e instanceof HubUnreachable)) console.error("discovery failed:", e);
      return;
    }
    // Only the hub's own discovery document can say a method was turned off. An Access redirect in front
    // of discovery (today's hubs, reached with a key and service token) or an old hub's 404 never counts.
    if (found.source !== "document") return;
    const { methods } = found;
    const current: AuthMethodType = c.auth ?? "api-key";
    const L = this.d.ledger;
    if (methods.some((m) => m.type === current)) {
      // Only this hub's own pending switch ends here; one to another hub (chosen in connect) stays.
      this.clearPending(c.hubUrl);
      // The method came back: a need_key wait ends and the next cycle syncs.
      if (L.status().last_status === "need_key") {
        L.recordStatus("", "");
      }
      return;
    }
    const next = methods[0];
    if (!next) return;
    if (next.type === "cloudflare-access") {
      // Credentials are never deleted here: the config switches when a sign-in succeeds (signedIn).
      L.setStatus(PENDING_ACCESS_KEY, c.hubUrl);
      L.setStatus("signed_in_as", "");
      L.recordStatus("signin", SIGNIN_ERROR);
      this.prepareCloudflared();
    } else {
      L.recordStatus("need_key", NEED_KEY_ERROR);
    }
  }

  /** Called once at the end of every cycle: a "revoked" or "signin" ending re-reads discovery once. */
  async afterCycle(r: CycleResult): Promise<void> {
    if (r.status === "revoked" || r.status === "signin") await this.rediscover();
  }

  /** Wraps a cycle runner (for SyncRunner) so each cycle ends with afterCycle, inside the same busy period. */
  runCycle(run: (d: SyncDeps) => Promise<CycleResult> = runSyncCycle): (d: SyncDeps) => Promise<CycleResult> {
    return async (deps) => {
      // Waiting for a key on a key-only hub: a sync would only fail as "signin" (and fetch Access tokens
      // for nothing). Skip it, touch no status, and just re-check whether the hub offers Cloudflare again.
      if (this.d.ledger.status().last_status === "need_key" && this.load()?.auth === "cloudflare-access") {
        try {
          await this.rediscover();
        } catch (e) {
          console.error("re-discovery failed:", e);
        }
        return { status: "need_key", pushed: 0, pulled: 0, error: NEED_KEY_ERROR };
      }
      const r = await run(deps);
      try {
        await this.afterCycle(r);
      } catch (e) {
        console.error("re-discovery failed:", e);
      }
      return r;
    };
  }
}
