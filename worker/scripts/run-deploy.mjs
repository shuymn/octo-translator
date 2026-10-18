// The deployment, as a function of the Worker's directory, the arguments and the environment wrangler runs in, so
// scripts/deploy.test.mjs can run it with a fake wrangler on PATH. scripts/deploy.mjs calls it; see that file.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  DeployConfigError,
  deploySteps,
  mergeDeployConfig,
  noPendingMigrations,
  parseDeployArgs,
  parseJsonc,
} from "./deploy-config.ts";

class Stop extends Error {}

function fail(message) {
  throw new Stop(message);
}

/** Runs `step`, turning a DeployConfigError into a {@link Stop}. */
function checked(step) {
  try {
    return step();
  } catch (cause) {
    if (cause instanceof DeployConfigError) fail(cause.message);
    throw cause;
  }
}

/**
 * Checks and merges the configuration under `root`, writes it, and (without --dry-run) runs the wrangler steps in
 * order, stopping at the first that fails. Returns the exit status. `env` is the environment wrangler runs in.
 */
export function runDeploy({ root, argv, env = process.env, log = console.log, error = console.error }) {
  const read = (path) => {
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (cause) {
      if (cause?.code === "ENOENT") fail(`${relative(root, path)} is missing; copy wrangler.deploy.example.jsonc`);
      throw cause;
    }
    return checked(() => parseJsonc(text));
  };

  try {
    const outDir = join(root, ".wrangler", "deploy-config");
    const out = join(outDir, "wrangler.json");
    const args = checked(() => parseDeployArgs(argv));
    const base = read(join(root, "wrangler.jsonc"));
    const merged = checked(() =>
      mergeDeployConfig(base, read(join(root, "wrangler.deploy.jsonc")), relative(outDir, root)),
    );
    mkdirSync(outDir, { recursive: true });
    writeFileSync(out, `${JSON.stringify(merged, null, 2)}\n`);

    const steps = deploySteps(merged, relative(root, out), args.auth);
    if (args.dryRun) {
      log(`deploy: wrote ${relative(root, out)}; would run, in the Worker's directory:`);
      for (const step of steps) log(`  wrangler ${step.args.join(" ")}`);
      return 0;
    }
    for (const step of steps) {
      const name = `wrangler ${step.args.slice(0, 3).join(" ")}`;
      // A step whose output is read keeps stdout; the others inherit the terminal, so wrangler can ask the owner.
      const capture = step.expect !== undefined;
      const result = spawnSync("wrangler", step.args, {
        cwd: root,
        env,
        stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
        encoding: "utf8",
      });
      if (result.error !== undefined) fail(`could not run wrangler: ${result.error.message}`);
      if (capture) log(result.stdout);
      if (result.status !== 0) fail(`${name} failed; nothing after it ran`);
      if (step.expect === "no-pending" && !noPendingMigrations(result.stdout)) {
        fail(`${name} reports migrations still pending (was the confirmation declined?); not deploying`);
      }
    }
    return 0;
  } catch (cause) {
    if (!(cause instanceof Stop)) throw cause;
    error(`deploy: ${cause.message}`);
    return 1;
  }
}
