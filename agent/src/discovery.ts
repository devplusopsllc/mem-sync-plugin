import { HubUnreachable } from "./cloudflared";

export type AdvertisedMethod =
  | { type: "cloudflare-access"; team_domain?: string; app_url: string }
  | { type: "api-key"; edge: "cloudflare-service-token" | "none" };

export function normalizeHubUrl(input: string): string {
  const u = new URL(input.trim());
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("hub URL must be http(s)");
  return u.origin;
}

/**
 * Where the methods came from: "document" is the hub's own discovery JSON; "redirect" (Access in front
 * of discovery) and "legacy" (404, non-JSON, no auth_methods) are guesses. Only a document can say a
 * method was turned off.
 */
export type DiscoverySource = "document" | "redirect" | "legacy";

function sameOrigin(appUrl: unknown, hubOrigin: string): boolean {
  if (typeof appUrl !== "string") return false;
  try {
    return new URL(appUrl).origin === hubOrigin;
  } catch {
    return false;
  }
}

export async function discover(hubUrl: string, fetchImpl: typeof fetch = fetch): Promise<AdvertisedMethod[]> {
  return (await discoverDetailed(hubUrl, fetchImpl)).methods;
}

export async function discoverDetailed(
  hubUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ methods: AdvertisedMethod[]; source: DiscoverySource }> {
  let res: Response;
  try {
    res = await fetchImpl(new URL("/.well-known/mem-sync", hubUrl), { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new HubUnreachable();
  }
  if (res.status >= 300 && res.status < 400) {
    let host = "";
    try {
      host = new URL(res.headers.get("location") ?? "", hubUrl).hostname;
    } catch {
      host = "";
    }
    if (host.endsWith(".cloudflareaccess.com")) return { methods: [{ type: "cloudflare-access", app_url: hubUrl }], source: "redirect" };
    return { methods: [{ type: "api-key", edge: "none" }], source: "redirect" };
  }
  let body: { auth_methods?: unknown } | null = null;
  try {
    body = res.ok ? ((await res.json()) as { auth_methods?: unknown }) : null;
  } catch {
    body = null;
  }
  const hubOrigin = normalizeHubUrl(hubUrl);
  if (!body || !Array.isArray(body.auth_methods)) return { methods: [{ type: "api-key", edge: "none" }], source: "legacy" };
  const out: AdvertisedMethod[] = [];
  for (const m of body.auth_methods as Record<string, unknown>[]) {
    if (m?.type === "cloudflare-access") {
      // Sign-in only ever targets the hub itself. A document naming another origin (or a malformed one)
      // drops the method: never mint a token for, or send a user to log in at, a host the agent didn't pick.
      if (m.app_url !== undefined && !sameOrigin(m.app_url, hubOrigin)) continue;
      const app = hubOrigin;
      out.push({ type: "cloudflare-access", app_url: app, ...(typeof m.team_domain === "string" ? { team_domain: m.team_domain } : {}) });
    } else if (m?.type === "api-key") {
      out.push({ type: "api-key", edge: m.edge === "cloudflare-service-token" ? "cloudflare-service-token" : "none" });
    }
  }
  return { methods: out, source: "document" };
}
