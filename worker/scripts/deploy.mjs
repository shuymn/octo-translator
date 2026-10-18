// Deploys the Worker with the deployment values that stay out of the repository.
//
// wrangler.jsonc holds the bindings, the cron, the migrations directory and the logging settings.
// wrangler.deploy.jsonc (gitignored; copy wrangler.deploy.example.jsonc) holds the route, the D1 database_id and the
// schedule's variables. This script checks the deployment file, merges it into wrangler.jsonc, writes the result under
// .wrangler/deploy-config/ (gitignored), applies the remote D1 migrations, checks that none is left pending (declining
// wrangler's confirmation leaves them pending and still exits 0), and runs `wrangler deploy --config` on it.
//
// Usage: pnpm --filter octo-translator-worker run deploy [--dry-run] [--profile <name>]. --dry-run writes the merged
// file, prints the wrangler commands and stops before any of them runs. See docs/operations.md.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDeploy } from "./run-deploy.mjs";

process.exit(runDeploy({ root: join(dirname(fileURLToPath(import.meta.url)), ".."), argv: process.argv.slice(2) }));
