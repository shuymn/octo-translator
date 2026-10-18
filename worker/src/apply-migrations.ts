/** Test setup: applies `worker/migrations/` to the local D1 database before the tests run. */
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";

const testEnv: Env & { TEST_MIGRATIONS?: D1Migration[] } = env;
await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS ?? []);
