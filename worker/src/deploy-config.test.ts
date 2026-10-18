import { describe, expect, it } from "vitest";
import {
  DeployConfigError,
  deploySteps,
  mergeDeployConfig,
  noPendingMigrations,
  parseDeployArgs,
  parseJsonc,
} from "../scripts/deploy-config.ts";
import example from "../wrangler.deploy.example.jsonc?raw";
import publicConfig from "../wrangler.jsonc?raw";

// AUTH-1, KEY-4, KEY-5: the deployment file sets only the deployment values, none of them secret; it cannot turn the
// workers.dev URL, preview URLs or invocation logs back on, nor change a binding, the cron or the compatibility date.
const BASE = readBase();
const DATABASE_ID = "01234567-89ab-cdef-0123-456789abcdef";

function readBase(): Record<string, unknown> {
  const value = parseJsonc(publicConfig);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("wrangler.jsonc is no object");
  return Object.fromEntries(Object.entries(value));
}

function deployFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    routes: [{ pattern: "translate.example.com", custom_domain: true }],
    d1_databases: [{ binding: "DB", database_id: DATABASE_ID }],
    ...overrides,
  };
}

function refusal(deploy: unknown): string {
  try {
    mergeDeployConfig(BASE, deploy, "../..");
  } catch (error) {
    if (error instanceof DeployConfigError) return error.message;
    throw error;
  }
  return "accepted";
}

describe("wrangler.jsonc", () => {
  it("AUTH-1: has no workers.dev URL or preview URLs, and KEY-4, KEY-5: no invocation logs", () => {
    expect(BASE["workers_dev"]).toBe(false);
    expect(BASE["preview_urls"]).toBe(false);
    expect(BASE["observability"]).toMatchObject({ enabled: true, logs: { invocation_logs: false } });
    // No deployment value is committed: the database is named but has no id, and there is no route or account.
    expect(JSON.stringify(BASE)).not.toMatch(/database_id|account_id|"routes"|"vars"/);
  });
});

describe("mergeDeployConfig", () => {
  it("merges the deployment values and rebases the paths onto the merged file's directory", () => {
    const merged = mergeDeployConfig(
      BASE,
      deployFile({
        account_id: "a".repeat(32),
        vars: { AHEAD_OF_TIME_FILTER: 'repo.owner == "octo"', AHEAD_OF_TIME_CHOICE: "" },
      }),
      "../..",
    );
    expect(merged).toMatchObject({
      name: "octo-translator",
      main: "../../src/index.ts",
      account_id: "a".repeat(32),
      workers_dev: false,
      preview_urls: false,
      triggers: BASE["triggers"],
      compatibility_date: BASE["compatibility_date"],
      observability: BASE["observability"],
      routes: [{ pattern: "translate.example.com", custom_domain: true }],
      d1_databases: [
        {
          binding: "DB",
          database_name: "octo-translator",
          migrations_dir: "../../migrations",
          database_id: DATABASE_ID,
        },
      ],
      vars: { AHEAD_OF_TIME_FILTER: 'repo.owner == "octo"', AHEAD_OF_TIME_CHOICE: "" },
    });
    expect(merged).not.toHaveProperty("$schema");
  });

  it("deploys no variable when the file sets none, so wrangler removes any left from before", () => {
    expect(mergeDeployConfig(BASE, deployFile(), "../..")["vars"]).toEqual({});
  });

  it.each([
    ["a route pattern", [{ pattern: "translate.example.com/*", zone_name: "example.com" }]],
    ["a string route", ["translate.example.com/*"]],
    ["a route with a zone id", [{ pattern: "translate.example.com/*", zone_id: "b".repeat(32) }]],
    [
      "a custom domain and a route on the same host",
      [{ pattern: "translate.example.com", custom_domain: true }, "translate.example.com/v1/*"],
    ],
  ])("accepts %s", (_name, routes) => {
    expect(refusal(deployFile({ routes }))).toBe("accepted");
  });

  it.each([
    ["no route", []],
    ["routes that are not a list", "translate.example.com/*"],
    ["a wildcard subdomain", ["*.example.com/*"]],
    ["a wildcard host prefix", [{ pattern: "*translate.example.com/*", zone_name: "example.com" }]],
    ["a custom domain with a path", [{ pattern: "translate.example.com/x", custom_domain: true }]],
    ["a route without a path", ["translate.example.com"]],
    ["an uppercase host", ["Translate.example.com/*"]],
    ["a host with a port", ["translate.example.com:8443/*"]],
    ["a workers.dev host on another host", ["translate.example.com/*", "octo-translator.example.workers.dev/*"]],
    ["another key on a route", [{ pattern: "translate.example.com", custom_domain: true, script: "x" }]],
    ["a malformed zone id", [{ pattern: "translate.example.com/*", zone_id: "<ZONE_ID>" }]],
  ])("refuses %s", (_name, routes) => {
    expect(refusal(deployFile({ routes }))).toContain("route");
  });

  it.each([
    ["the workers.dev URL", { workers_dev: true }, 'may not set "workers_dev"'],
    ["preview URLs", { preview_urls: true }, 'may not set "preview_urls"'],
    ["the cron", { triggers: { crons: [] } }, 'may not set "triggers"'],
    ["the logging", { observability: { logs: { invocation_logs: true } } }, 'may not set "observability"'],
    ["the compatibility date", { compatibility_date: "2020-01-01" }, 'may not set "compatibility_date"'],
    ["the entry point", { main: "other.ts" }, 'may not set "main"'],
    ["a secret", { secrets: { required: [] } }, 'may not set "secrets"'],
    ["a placeholder account id", { account_id: "<ACCOUNT_ID>" }, "account_id"],
    ["no database", { d1_databases: [] }, "database_id for each binding"],
    ["a placeholder database id", { d1_databases: [{ binding: "DB", database_id: "<DATABASE_ID>" }] }, "UUID"],
    ["another binding", { d1_databases: [{ binding: "OTHER", database_id: DATABASE_ID }] }, "no D1 binding"],
    [
      "another database setting",
      { d1_databases: [{ binding: "DB", database_id: DATABASE_ID, database_name: "other" }] },
      'exactly "binding" and "database_id"',
    ],
    ["a secret as a variable", { vars: { GITHUB_TOKEN: "x" } }, "wrangler secret put"],
    ["the private repositories as a variable", { vars: { PRIVATE_REPOSITORIES: "o/r" } }, "wrangler secret put"],
    ["the Access settings as a variable", { vars: { ACCESS_AUD: "x" } }, "wrangler secret put"],
    ["a filter that does not compile", { vars: { AHEAD_OF_TIME_FILTER: "repo.owner ==" } }, "AHEAD_OF_TIME_FILTER"],
    ["a filter that is not a bool", { vars: { AHEAD_OF_TIME_FILTER: "pr.number" } }, "AHEAD_OF_TIME_FILTER"],
    ["an unknown choice", { vars: { AHEAD_OF_TIME_CHOICE: "other/model/off" } }, "AHEAD_OF_TIME_CHOICE"],
    ["a variable that is not a string", { vars: { AHEAD_OF_TIME_CHOICE: 1 } }, "must be a string"],
  ])("refuses %s", (_name, overrides, message) => {
    expect(refusal(deployFile(overrides))).toContain(message);
  });

  it("refuses the example as it is, with its placeholders, and accepts its shape once they are replaced", () => {
    expect(refusal(parseJsonc(example))).not.toBe("accepted");
    const filled = example
      .replace("<ACCOUNT_ID>", "c".repeat(32))
      .replace("<DATABASE_ID>", DATABASE_ID)
      .replaceAll("<", "")
      .replaceAll(">", "");
    expect(refusal(parseJsonc(filled))).toBe("accepted");
  });
});

describe("parseJsonc", () => {
  it("reads comments and trailing commas, and keeps them inside strings", () => {
    expect(parseJsonc('// head\n{ "a": [1, /* x */ 2,], "b": "x // y", }')).toEqual({ a: [1, 2], b: "x // y" });
  });

  it.each([
    ["an unterminated string", '{ "a": "x }'],
    ["two values", "{} {}"],
    ["nothing", ""],
  ])("refuses %s with DeployConfigError", (_name, text) => {
    expect(() => parseJsonc(text)).toThrow(DeployConfigError);
  });

  it("does not quote the text in its error", () => {
    expect(() => parseJsonc('{ "database_id": "secret-looking" ')).toThrow(/^invalid JSONC: \w+ at offset \d+$/);
  });
});

describe("parseDeployArgs", () => {
  it("reads --dry-run and --profile, and drops a leading --", () => {
    expect(parseDeployArgs(["--", "--dry-run", "--profile", "work"])).toEqual({
      dryRun: true,
      auth: ["--profile", "work"],
    });
    expect(parseDeployArgs(["--profile=other"])).toEqual({ dryRun: false, auth: ["--profile=other"] });
  });

  // wrangler's own options could replace what the checked files hold.
  it.each([
    [["--config", "x"]],
    [["-c", "x"]],
    [["--env", "x"]],
    [["--var", "GITHUB_TOKEN:x"]],
    [["--route", "other.example/*"]],
    [["--triggers", "* * * * *"]],
    [["--compatibility-date", "2020-01-01"]],
    [["--secrets-file", "x"]],
    [["--keep-vars"]],
    [["--dry-run", "--", "x"]],
    [["--profile"]],
  ])("refuses %j", (args) => {
    expect(() => parseDeployArgs(args)).toThrow(DeployConfigError);
  });
});

describe("deploySteps", () => {
  it("applies the remote migrations, checks none is pending, then deploys, each with the merged file and the profile", () => {
    const merged = mergeDeployConfig(BASE, deployFile(), "../..");
    const common = ["--config", ".wrangler/deploy-config/wrangler.json", "--profile", "work"];
    expect(deploySteps(merged, ".wrangler/deploy-config/wrangler.json", ["--profile", "work"])).toEqual([
      { args: ["d1", "migrations", "apply", "DB", "--remote", ...common] },
      { args: ["d1", "migrations", "list", "DB", "--remote", ...common], expect: "no-pending" },
      { args: ["deploy", ...common] },
    ]);
  });
});

describe("noPendingMigrations", () => {
  it.each([
    ["wrangler's answer with nothing pending", "Resource location: remote\n\u2705 No migrations to apply!\n", true],
    ["a pending table", "Migrations to be applied:\n\u2502 0002_ahead_of_time.sql \u2502\n", false],
    ["changed wording", "Nothing to apply\n", false],
    ["no output", "", false],
  ])("reads %s", (_name, output, expected) => {
    expect(noPendingMigrations(output)).toBe(expected);
  });
});
