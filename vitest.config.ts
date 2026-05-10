import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Mirror tsconfig.json's `paths` so vitest resolves the workspace
      // package directly to TS source — no need to pre-build packages/shared.
      "@curacel/shared": path.resolve(__dirname, "./packages/shared/src/index.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
    reporters: ["default"],
    coverage: {
      reporter: ["text", "html"],
      include: ["src/**/*.ts", "packages/shared/src/**/*.ts"],
      exclude: ["src/index.ts", "src/**/*.d.ts", "packages/shared/src/**/*.d.ts"],
    },
  },
});
