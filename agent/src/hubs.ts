import { adapterFromConfig, forgetTokenSource, type AuthMethodType } from "./auth/adapter";
import { AuthFlow, PENDING_ACCESS_KEY, type AuthFlowDeps, type ConnectReply } from "./authFlow";
import { defaultLabel, findHubByUrl, hubsSaved, loadConfig, newHubId, removeHub, renameHub, upsertHub, type AgentConfig, type HubConfig } from "./config";
import { HubClient, type HubConnection } from "./hubClient";
import type { HubLedger, Ledger } from "./ledger";

export interface HubHandle {
  config: HubConfig;
  label: string;
  ledger: HubLedger;
  auth: AuthFlow;
  client(): HubClient;
}

export interface HubSetDeps {
  ledger: Ledger;
  /** Starts a sync cycle over every hub. */
  triggerSync: () => Promise<unknown>;
  /** Resolves when no sync cycle is running. */
  idle: () => Promise<void>;
  /** Overrides for every hub's AuthFlow (tests); the hub id, ledger and config binding are always the hub's own. */
  authDeps?: Partial<AuthFlowDeps>;
  makeClient?: (h: HubConfig) => HubClient;
  /** The config the ledger was opened with (main.ts); the startup cleanup keeps exactly its hub ids. */
  config?: AgentConfig;
}

/** The hubs in config.json, each with its own ledger view and AuthFlow. The config file is the source of truth. */
export class HubSet {
  private readonly flows = new Map<string, AuthFlow>();
  private readonly makeClient: (h: HubConfig) => HubClient;

  constructor(private readonly d: HubSetDeps) {
    this.makeClient = d.makeClient ?? ((h) => new HubClient(h.hubUrl, adapterFromConfig(h)));
    // A hub id the config doesn't know (lost to a migration race, or removed while stopped) loses its rows;
    // its folder ownership stays so the next hub to link a folder takes over its history (dropHub), which
    // also makes re-running this on every start a no-op. With no hub configured, a migrated ledger waits
    // for its config; with hubs only in memory (config.json can't be written), nothing is dropped.
    const known = new Set((d.config ?? loadConfig()).hubs.map((h) => h.id));
    if (known.size > 0 && hubsSaved()) for (const id of d.ledger.hubIds()) if (!known.has(id)) d.ledger.dropHub(id);
  }

  private flow(id: string): AuthFlow {
    let f = this.flows.get(id);
    if (!f) {
      f = new AuthFlow({ triggerSync: this.d.triggerSync, idle: this.d.idle, ...this.d.authDeps, hubId: id, ledger: this.d.ledger.forHub(id) });
      this.flows.set(id, f);
    }
    return f;
  }

  private handle(config: HubConfig): HubHandle {
    return {
      config,
      label: config.label ?? defaultLabel(config.hubUrl),
      ledger: this.d.ledger.forHub(config.id),
      auth: this.flow(config.id),
      client: () => this.makeClient(config),
    };
  }

  list(): HubHandle[] {
    return loadConfig().hubs.map((h) => this.handle(h));
  }

  get(id: string): HubHandle | undefined {
    const h = loadConfig().hubs.find((x) => x.id === id);
    return h && this.handle(h);
  }

  first(): HubHandle | undefined {
    const h = loadConfig().hubs[0];
    return h && this.handle(h);
  }

  byUrl(hubUrl: string): HubHandle | undefined {
    const h = findHubByUrl(loadConfig(), hubUrl);
    return h && this.handle(h);
  }

  /**
   * A known URL re-runs that hub's connect. A new URL gets an AuthFlow bound to a fresh id: a Cloudflare
   * choice saves it as a new hub; an API-key choice saves nothing (the key arrives through addKeyHub).
   */
  async connect(hubUrl: string, method?: AuthMethodType): Promise<ConnectReply & { hub_id?: string }> {
    const known = this.byUrl(hubUrl);
    if (known) return { ...(await known.auth.connect(hubUrl, method)), hub_id: known.config.id };
    const id = newHubId();
    try {
      const r = await this.flow(id).connect(hubUrl, method);
      return this.get(id) ? { ...r, hub_id: id } : r;
    } finally {
      if (!this.get(id)) this.flows.delete(id);
    }
  }

  /** Checks the key with the hub, then adds the hub (or updates the key of the hub at that URL). */
  async addKeyHub(c: HubConnection & { label?: string }): Promise<HubConfig> {
    const cfg = { ...c, auth: "api-key" as const };
    await this.makeClient({ ...cfg, id: "" }).me();
    const id = this.byUrl(c.hubUrl)?.config.id ?? newHubId();
    const hub = upsertHub(id, cfg);
    // A working key ends any wait for a Cloudflare switch.
    this.d.ledger.forHub(id).setStatus(PENDING_ACCESS_KEY, "");
    return hub;
  }

  rename(id: string, label: string): HubConfig {
    return renameHub(id, label);
  }

  /** Waits out a running cycle, then forgets the hub: config entry, ledger rows, AuthFlow and token source. */
  async remove(id: string): Promise<void> {
    await this.d.idle();
    const h = loadConfig().hubs.find((x) => x.id === id);
    removeHub(id);
    // A cycle that started just after the first wait may still run this hub's job; its rows are dropped after it.
    await this.d.idle();
    this.d.ledger.dropHub(id);
    this.flows.delete(id);
    if (h) forgetTokenSource(h.hubUrl);
  }

  /**
   * True while the hub that owns the folder's push state still links it or keeps it never shared. A sync
   * cycle moves a folder only when this is false. Throws when the owner can't be read.
   */
  async ownerKeeps(project: string): Promise<boolean> {
    const owner = this.get(this.d.ledger.folderHub(project) ?? "");
    if (!owner) return false;
    const mine = await owner.client().myMappings();
    return mine.mappings.some((m) => m.local_project === project) || mine.never_sync.includes(project);
  }

  /** The hub a bare sign-in request is for: the first that needs one, else the first hub. */
  signInTarget(): HubHandle | undefined {
    const all = this.list();
    return all.find((h) => h.auth.signInNeeded()) ?? all[0];
  }
}
