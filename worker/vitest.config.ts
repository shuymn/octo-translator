import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { TEST_ENV } from "./src/test-env.ts";

// The tests run in the Workers runtime (workerd), with the Worker's own wrangler.jsonc.
// https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // The Access settings are bound here, over any `.dev.vars` the owner filled in for `wrangler dev`, so the tests
      // never verify against, or fetch the keys of, the real team.
      miniflare: { bindings: TEST_ENV },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts"],
    // With Vitest 5's file module cache, the plugin's runner fails to read the cached modules.
    fsModuleCache: false,
  },
});
