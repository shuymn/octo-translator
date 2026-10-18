import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { TEST_ENV } from "./src/test-env.ts";

// The tests run in the Workers runtime (workerd), with the Worker's own wrangler.jsonc and a local D1 database.
// https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/
// https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/ (`readD1Migrations`)
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // The Access settings are bound here, over any `.dev.vars` the owner filled in for `wrangler dev`, so the
          // tests never verify against, or fetch the keys of, the real team. No provider key is bound: the tests that
          // need one bind their own, and a real key in `.dev.vars` is replaced by an empty one.
          ...TEST_ENV,
          DEEPSEEK_API_KEY: "",
          OPENAI_API_KEY: "",
          GEMINI_API_KEY: "",
          // Nor is a GitHub token or a setting of the schedule: its tests pass their own, and the owner's never reach them.
          GITHUB_TOKEN: "",
          PRIVATE_REPOSITORIES: "",
          AHEAD_OF_TIME_FILTER: "",
          AHEAD_OF_TIME_CHOICE: "",
          // The migrations, read here in Node and applied in the runtime by `src/apply-migrations.ts`.
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    })),
  ],
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/apply-migrations.ts"],
    // With Vitest 5's file module cache, the plugin's runner fails to read the cached modules.
    fsModuleCache: false,
  },
});
