import { findCloudflared, installCloudflared, AccessTokenSource, SignInProcess } from "../cloudflared";
import type { HubConfig } from "../config";
import { apiKeyAdapter } from "./apiKey";
import { cloudflareAccessAdapter } from "./cloudflareAccess";

export type AuthMethodType = "cloudflare-access" | "api-key";

export interface AuthAdapter {
  type: AuthMethodType;
  headers(): Promise<Record<string, string>>;
  classify(res: Response, bodyIsJson: boolean): "signin" | "ok-error";
  invalidate(): void;
  /** Message for SignInNeeded when this adapter classifies a response as "signin". */
  signInMessage(): string;
  describe(): { signed_in_as?: string; session_expires_at?: number };
}

let installing: Promise<string> | null = null;

/**
 * The cloudflared binary: on PATH or in ~/.mem-sync/bin, else downloaded. Concurrent callers (the
 * background install at start, a token fetch, a sign-in) share one download; a failed one is retried
 * by the next caller.
 */
export function cloudflaredBin(): Promise<string> {
  const found = findCloudflared();
  if (found) return Promise.resolve(found);
  if (!installing) {
    installing = installCloudflared().finally(() => {
      installing = null;
    });
  }
  return installing;
}

// One token source per hub URL, so its cache survives across calls.
const tokenSources = new Map<string, AccessTokenSource>();

export function tokenSourceFor(hubUrl: string): AccessTokenSource {
  let t = tokenSources.get(hubUrl);
  if (!t) {
    t = new AccessTokenSource({ appUrl: hubUrl, bin: cloudflaredBin });
    tokenSources.set(hubUrl, t);
  }
  return t;
}

/** Drops a removed hub's token source; cloudflared's own token cache on disk is left alone. */
export const forgetTokenSource = (hubUrl: string): boolean => tokenSources.delete(hubUrl);

// One sign-in process per hub URL, so a second click joins the running login instead of starting another.
const signIns = new Map<string, SignInProcess>();

export function signInProcessFor(hubUrl: string): SignInProcess {
  let p = signIns.get(hubUrl);
  if (!p) {
    p = new SignInProcess({ appUrl: hubUrl, bin: cloudflaredBin });
    signIns.set(hubUrl, p);
  }
  return p;
}

export function adapterFromConfig(c: Pick<HubConfig, "hubUrl" | "auth" | "apiKey" | "cfClientId" | "cfClientSecret">): AuthAdapter {
  if (c.auth === "cloudflare-access") return cloudflareAccessAdapter({ appUrl: c.hubUrl, tokens: tokenSourceFor(c.hubUrl) });
  return apiKeyAdapter({ apiKey: c.apiKey ?? "", cfClientId: c.cfClientId, cfClientSecret: c.cfClientSecret });
}
