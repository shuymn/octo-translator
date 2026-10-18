import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "happy-dom",
    // The file module cache keeps an old `import.meta.glob` result, so the threat-model and source-analysis checks
    // would read a stale set of files after one is added, renamed or removed.
    fsModuleCache: false,
  },
});
