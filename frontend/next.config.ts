import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";
import { loadEnvConfig } from "@next/env";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "..");

// Single .env file for the whole monorepo. The bot loads /<root>/.env via
// `dotenv` at boot; we want the frontend to read the same file so the user
// doesn't manage two places.
//
// @next/env's loadEnvConfig caches after its first call (which Next makes
// internally with cwd=frontend/, finding no .env files there). The fourth
// arg `forceReload=true` is required to make this second call actually
// re-read from the new directory.
//
// dev=true loads .env.development files too. Vercel deploys don't have a
// .env file at all (vars come from the dashboard) so this is a no-op there.
const isDev = process.env.NODE_ENV !== "production";
loadEnvConfig(repoRoot, isDev, undefined, true);

// Baseline security headers applied to every route. Intentionally
// conservative — a full CSP (script-src/style-src/etc.) needs careful
// tuning for Next's runtime + Tailwind inline styles + Recharts SVGs;
// only the safe headers that don't risk breaking renders go here.
// Vercel adds Strict-Transport-Security on deploy so it isn't set here.
//
// frame-ancestors 'none' (via CSP) is the modern equivalent of
// X-Frame-Options: DENY; we set both for older clients that only honor
// X-Frame-Options.
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // Monorepo: pin Turbopack's root to the repo root so it can resolve the
  // @curacel/shared workspace package at packages/shared/. Without this,
  // Next 16 picks the nearest lockfile and warns about ambiguous roots.
  turbopack: {
    root: repoRoot,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
