import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Monorepo: pin Turbopack's root to the repo root so it can resolve the
  // @curacel/shared workspace package at packages/shared/. Without this,
  // Next 16 picks the nearest lockfile and warns about ambiguous roots.
  turbopack: {
    root: path.resolve(dirname, ".."),
  },
};

export default nextConfig;
