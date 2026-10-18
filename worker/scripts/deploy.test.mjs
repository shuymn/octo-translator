// The process-spawning part of scripts/deploy.mjs, run in Node with a fake wrangler on PATH that records its arguments
// and answers as the test tells it. No real wrangler runs. The checks and the merge are tested in
// src/deploy-config.test.ts.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDeploy } from "./run-deploy.mjs";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEPLOY_FILE = JSON.stringify({
  routes: [{ pattern: "translate.example.com", custom_domain: true }],
  d1_databases: [{ binding: "DB", database_id: "01234567-89ab-cdef-0123-456789abcdef" }],
});
// Records `<args>` per call; FAKE_<STEP>_STATUS and FAKE_LIST_OUTPUT choose the answer.
const FAKE_WRANGLER = `#!/bin/sh
echo "$*" >> "$FAKE_LOG"
case "$1 $2 $3" in
  "d1 migrations apply") exit "\${FAKE_APPLY_STATUS:-0}" ;;
  "d1 migrations list")
    if [ "$FAKE_LIST_OUTPUT" = pending ]; then printf 'Migrations to be applied:\\n| 0002_ahead_of_time.sql |\\n';
    else printf 'Resource location: remote\\n\\342\\234\\205 No migrations to apply!\\n'; fi
    exit "\${FAKE_LIST_STATUS:-0}" ;;
  deploy*) exit "\${FAKE_DEPLOY_STATUS:-0}" ;;
esac
exit 99
`;

let dir;
let root;
let bin;
let fakeLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "octo-deploy-"));
  root = join(dir, "worker");
  bin = join(dir, "bin");
  fakeLog = join(dir, "calls.log");
  mkdirSync(root);
  mkdirSync(bin);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setUp({ wrangler = true } = {}) {
  copyFileSync(join(WORKER, "wrangler.jsonc"), join(root, "wrangler.jsonc"));
  writeFileSync(join(root, "wrangler.deploy.jsonc"), DEPLOY_FILE);
  if (wrangler) {
    writeFileSync(join(bin, "wrangler"), FAKE_WRANGLER);
    chmodSync(join(bin, "wrangler"), 0o755);
  }
}

function deploy(argv, fake = {}) {
  const output = [];
  const status = runDeploy({
    root,
    argv,
    env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_LOG: fakeLog, ...fake },
    log: (line) => output.push(line),
    error: (line) => output.push(line),
  });
  const calls = existsSync(fakeLog) ? readFileSync(fakeLog, "utf8").trim().split("\n") : [];
  return { status, calls, output: output.join("\n") };
}

const CONFIG = "--config .wrangler/deploy-config/wrangler.json";

describe("deploy.mjs with a fake wrangler", () => {
  it("applies the migrations, checks none is pending, then deploys", () => {
    setUp();
    expect(deploy(["--profile", "work"])).toMatchObject({
      status: 0,
      calls: [
        `d1 migrations apply DB --remote ${CONFIG} --profile work`,
        `d1 migrations list DB --remote ${CONFIG} --profile work`,
        `deploy ${CONFIG} --profile work`,
      ],
    });
  });

  it("does not deploy when the migrations confirmation was declined: apply exits 0, list still reports them", () => {
    setUp();
    const result = deploy([], { FAKE_LIST_OUTPUT: "pending" });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([
      `d1 migrations apply DB --remote ${CONFIG}`,
      `d1 migrations list DB --remote ${CONFIG}`,
    ]);
    expect(result.output).toContain("migrations still pending");
  });

  it.each([
    ["the migrations fail", { FAKE_APPLY_STATUS: "3" }, 1],
    ["the check fails", { FAKE_LIST_STATUS: "2" }, 2],
    ["the deployment fails", { FAKE_DEPLOY_STATUS: "1" }, 3],
  ])("stops with status 1 when %s, running nothing after it", (_name, fake, calls) => {
    setUp();
    const result = deploy([], fake);
    expect(result.status).toBe(1);
    expect(result.calls).toHaveLength(calls);
    expect(result.output).toContain("failed; nothing after it ran");
  });

  it("stops when wrangler cannot be started", () => {
    setUp({ wrangler: false });
    const result = deploy([]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("could not run wrangler");
  });

  it("runs nothing with --dry-run, and prints the commands", () => {
    setUp();
    const result = deploy(["--", "--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.output).toContain(`wrangler d1 migrations apply DB --remote ${CONFIG}`);
    expect(result.output).toContain(`wrangler deploy ${CONFIG}`);
    expect(existsSync(join(root, ".wrangler", "deploy-config", "wrangler.json"))).toBe(true);
  });

  it("runs nothing when the deployment file is refused or missing", () => {
    setUp();
    writeFileSync(join(root, "wrangler.deploy.jsonc"), JSON.stringify({ workers_dev: true }));
    expect(deploy([])).toMatchObject({ status: 1, calls: [] });
    rmSync(join(root, "wrangler.deploy.jsonc"));
    expect(deploy([])).toMatchObject({ status: 1, calls: [] });
  });
});
