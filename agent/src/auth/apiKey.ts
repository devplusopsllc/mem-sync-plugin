import type { AuthAdapter } from "./adapter";

export function apiKeyAdapter(opts: { apiKey: string; cfClientId?: string; cfClientSecret?: string }): AuthAdapter {
  return {
    type: "api-key",
    async headers() {
      const h: Record<string, string> = { authorization: `Bearer ${opts.apiKey}` };
      if (opts.cfClientId) h["cf-access-client-id"] = opts.cfClientId;
      if (opts.cfClientSecret) h["cf-access-client-secret"] = opts.cfClientSecret;
      return h;
    },
    classify(res) {
      // A 401 is the hub saying the key was revoked: keep it a normal error.
      return res.status >= 300 && res.status < 400 ? "signin" : "ok-error";
    },
    invalidate() {},
    signInMessage: () => "hub redirected; Cloudflare Access probably rejected the service token",
    describe() {
      return {};
    },
  };
}
