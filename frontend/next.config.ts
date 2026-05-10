import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";
import { loadEnvConfig } from "@next/env";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "..");

// Single .env file for the whole monorepo. The bot loads /<root>/.env via
// `dotenv` at boot; we want the frontend to read the same file so the user
// doesn't manage two places. By default @next/env only loads .env files
// from the Next.js project's own directory (frontend/) — calling
// loadEnvConfig with the repo root pulls in the root .env too.
//
// Vercel deploys don't have a .env file at all (vars come from the Vercel
// dashboard) so this is a no-op there.
loadEnvConfig(repoRoot);

const nextConfig: NextConfig = {
  // Monorepo: pin Turbopack's root to the repo root so it can resolve the
  // @curacel/shared workspace package at packages/shared/. Without this,
  // Next 16 picks the nearest lockfile and warns about ambiguous roots.
  turbopack: {
    root: repoRoot,
  },
};

export default nextConfig;
