import { defineConfig } from "vitest/config";

// Pure-function unit tests only — no React, no JSX, no DOM. Tests live
// co-located as lib/**/*.test.ts. Run with `npm test`.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
    environment: "node",
  },
});
