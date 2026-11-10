import type { AccessTokenSource } from "../cloudflared";
import type { AuthAdapter } from "./adapter";

export function cloudflareAccessAdapter(opts: { appUrl: string; tokens: AccessTokenSource }): AuthAdapter {
  return {
    type: "cloudflare-access",
    async headers() {
      return { "cf-access-token": await opts.tokens.token() };
    },
    classify(res, bodyIsJson) {
      if (res.status >= 300 && res.status < 400) return "signin";
      if (res.status === 401) return "signin";
      if (res.status === 403 && !bodyIsJson) return "signin";
      return "ok-error";
    },
    invalidate() {
      opts.tokens.invalidate();
    },
    signInMessage: () => "Cloudflare Access sign-in required",
    describe() {
      const c = opts.tokens.claims();
      return c ? { signed_in_as: c.email, session_expires_at: c.exp } : {};
    },
  };
}
