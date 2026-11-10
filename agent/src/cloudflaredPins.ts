// Pinned cloudflared release (2026.10.0, published 2026-10-05; newest release at least two weeks old on 2026-10-21).
// sha256 is of the downloaded asset itself. Note the release notes list the *extracted* binary hash for the two
// darwin .tgz files; the values here for those are the hashes of the .tgz files (GitHub asset digest, confirmed by download).
export const CLOUDFLARED_VERSION = "2026.10.0";

export type CloudflaredTarget = "win32-x64" | "darwin-arm64" | "darwin-x64" | "linux-x64";

export const CLOUDFLARED_ASSETS: Record<CloudflaredTarget, { file: string; sha256: string }> = {
  "win32-x64": {
    file: "cloudflared-windows-amd64.exe",
    sha256: "86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c",
  },
  "darwin-arm64": {
    file: "cloudflared-darwin-arm64.tgz",
    sha256: "a2f79ff7b9420aa537d74af239f376da170bbabeb529aec416002adac6a72e70",
  },
  "darwin-x64": {
    file: "cloudflared-darwin-amd64.tgz",
    sha256: "903845b81828c8cb3c5d13d816a2de71c06a3da5785469df8eb0e1b736d92f9f",
  },
  "linux-x64": {
    file: "cloudflared-linux-amd64",
    sha256: "d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db",
  },
};
