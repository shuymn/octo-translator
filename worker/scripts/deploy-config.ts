/**
 * The checks and the merge of scripts/deploy.mjs, without I/O, so that src/deploy-config.test.ts can test them.
 * wrangler.deploy.jsonc may set only the deployment values; the bindings, the cron, the compatibility settings and the
 * logging settings come from wrangler.jsonc. No secret is a deployment value: secrets are set with `wrangler secret put`.
 */
import { getNodeValue, parseTree, printParseErrorCode, type ParseError } from "jsonc-parser";
import { compileFilter } from "../src/filter.ts";
import { parseChoiceSetting } from "../src/scheduled-config.ts";

export class DeployConfigError extends Error {}

/** The keys wrangler.deploy.jsonc may set. */
const DEPLOY_KEYS: ReadonlySet<string> = new Set(["account_id", "routes", "d1_databases", "vars"]);
/** The Worker variables (Env in src/env.d.ts), each optional. Neither is a secret: the schedule's filter and choice. */
const VARS: ReadonlySet<string> = new Set(["AHEAD_OF_TIME_FILTER", "AHEAD_OF_TIME_CHOICE"]);
/** The keys of a route object, as wrangler takes them. */
const ROUTE_KEYS: ReadonlySet<string> = new Set(["pattern", "custom_domain", "zone_name", "zone_id"]);
/** A lowercase host name of two or more labels, with no wildcard and no port. */
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HEX_32 = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new DeployConfigError(message);
}

/**
 * Parses JSONC as wrangler reads it: JSON with comments and trailing commas. Throws {@link DeployConfigError} for
 * anything else, with the error's kind and offset only, never the text. Objects are built without a prototype
 * (`getNodeValue`), so a `__proto__` key is an ordinary key, as with JSON.parse, never a prototype to inherit from.
 */
export function parseJsonc(text: string): unknown {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  const [error] = errors;
  if (error !== undefined) fail(`invalid JSONC: ${printParseErrorCode(error.error)} at offset ${error.offset}`);
  if (root === undefined) fail("invalid JSONC: no value");
  const value: unknown = getNodeValue(root);
  return value;
}

/**
 * The host a route serves, or undefined when the route is malformed. A custom domain's pattern is a host name; a route
 * pattern is `<host>/<path>`. A wildcard host (`*.example.com`, `*example.com`) is refused: it can serve host names the
 * Access application does not cover (AUTH-1).
 */
function routeHost(route: unknown): string | undefined {
  if (typeof route === "string") return zoneRouteHost(route);
  if (!isRecord(route) || typeof route["pattern"] !== "string") return undefined;
  if (Object.keys(route).some((key) => !ROUTE_KEYS.has(key))) return undefined;
  const { pattern, custom_domain: customDomain, zone_name: zoneName, zone_id: zoneId } = route;
  if (customDomain !== undefined && typeof customDomain !== "boolean") return undefined;
  if (zoneName !== undefined && (typeof zoneName !== "string" || !HOST.test(zoneName))) return undefined;
  if (zoneId !== undefined && (typeof zoneId !== "string" || !HEX_32.test(zoneId))) return undefined;
  if (customDomain === true) return HOST.test(pattern) ? pattern : undefined;
  return zoneRouteHost(pattern);
}

function zoneRouteHost(pattern: string): string | undefined {
  const slash = pattern.indexOf("/");
  if (slash < 0) return undefined;
  const host = pattern.slice(0, slash);
  return HOST.test(host) ? host : undefined;
}

/** `routes`: at least one, every one on the same host, so one Access application covers them all (AUTH-1). */
function checkRoutes(routes: unknown): unknown[] {
  if (!Array.isArray(routes) || routes.length === 0) fail('"routes" must name the Worker\'s route or custom domain');
  const hosts = new Set<string>();
  for (const route of routes as unknown[]) {
    const host = routeHost(route);
    if (host === undefined) {
      fail(
        'each route is a custom domain { "pattern": "<host>", "custom_domain": true } or a route "<host>/<path>", ' +
          "with a lowercase host and no wildcard",
      );
    }
    hosts.add(host);
  }
  if (hosts.size !== 1) fail("every route must be on the same host, the one the Access application covers");
  return routes as unknown[];
}

/** `d1_databases`: the database_id of each D1 binding in wrangler.jsonc, created beforehand with `wrangler d1 create`. */
function checkDatabases(base: Json, databases: unknown): Json[] {
  const baseDatabases = Array.isArray(base["d1_databases"]) ? (base["d1_databases"] as unknown[]).filter(isRecord) : [];
  const bindings = baseDatabases.map((database) => database["binding"]);
  if (!Array.isArray(databases) || databases.length !== bindings.length) {
    fail(`"d1_databases" must give a database_id for each binding: ${bindings.join(", ")}`);
  }
  const ids = new Map<unknown, string>();
  for (const database of databases as unknown[]) {
    if (!isRecord(database) || Object.keys(database).toSorted().join() !== "binding,database_id") {
      fail('each of "d1_databases" has exactly "binding" and "database_id"');
    }
    const binding = database["binding"];
    const id = database["database_id"];
    if (!bindings.includes(binding) || ids.has(binding)) {
      fail(`wrangler.jsonc has no D1 binding ${String(binding)}, or it is given twice`);
    }
    if (typeof id !== "string" || !UUID.test(id)) {
      fail(`the database_id of ${String(binding)} must be the UUID \`wrangler d1 create\` printed`);
    }
    ids.set(binding, id);
  }
  return baseDatabases.map((database) => ({ ...database, database_id: ids.get(database["binding"]) }));
}

/** `vars`: only the schedule's filter and choice, each a value the Worker accepts (`parseScheduledConfig`). */
function checkVars(vars: unknown): Json {
  if (vars === undefined) return {};
  if (!isRecord(vars)) fail('"vars" must be an object');
  for (const [name, value] of Object.entries(vars)) {
    if (!VARS.has(name)) {
      fail(`"vars" may set only ${[...VARS].join(" and ")}; secrets are set with \`wrangler secret put\``);
    }
    if (typeof value !== "string") fail(`${name} must be a string`);
  }
  const filter = vars["AHEAD_OF_TIME_FILTER"];
  if (typeof filter === "string" && !compileFilter(filter).ok) {
    fail("AHEAD_OF_TIME_FILTER is not a CEL expression the schedule accepts");
  }
  const choice = vars["AHEAD_OF_TIME_CHOICE"];
  if (typeof choice === "string" && parseChoiceSetting(choice) === undefined) {
    fail("AHEAD_OF_TIME_CHOICE must be provider/model/thinking as the extension offers it, or empty");
  }
  return vars;
}

/**
 * Checks the deployment values and returns `base` with them merged in. `fromOut` is the directory of wrangler.jsonc as
 * seen from where the merged file is written (for example `../..`); `main` and `migrations_dir`, which wrangler reads
 * relative to the configuration file, are rebased onto it. Throws {@link DeployConfigError} for anything else.
 */
export function mergeDeployConfig(base: Json, deploy: unknown, fromOut: string): Json {
  if (!isRecord(deploy)) fail("wrangler.deploy.jsonc must be an object");
  for (const key of Object.keys(deploy)) {
    if (!DEPLOY_KEYS.has(key)) fail(`wrangler.deploy.jsonc may not set "${key}"; it belongs in wrangler.jsonc`);
  }
  const accountId = deploy["account_id"];
  if (accountId !== undefined && (typeof accountId !== "string" || !HEX_32.test(accountId))) {
    fail("account_id must be a Cloudflare account id (32 hex characters), or left out");
  }
  const routes = checkRoutes(deploy["routes"]);
  const databases = checkDatabases(base, deploy["d1_databases"]).map((database) =>
    typeof database["migrations_dir"] === "string"
      ? { ...database, migrations_dir: `${fromOut}/${database["migrations_dir"]}` }
      : database,
  );
  const vars = checkVars(deploy["vars"]);
  if (typeof base["main"] !== "string") fail('wrangler.jsonc has no "main"');
  const { $schema: _schema, ...rest } = base;
  return {
    ...rest,
    ...(accountId === undefined ? {} : { account_id: accountId }),
    main: `${fromOut}/${base["main"]}`,
    routes,
    d1_databases: databases,
    vars,
  };
}

export type DeployArgs = {
  /** Stop before any wrangler command, after printing them. */
  readonly dryRun: boolean;
  /** `--profile <name>` or `--profile=<name>`: whom wrangler authenticates as, given to every command. */
  readonly auth: readonly string[];
};

/**
 * Reads the script's own options: `--dry-run` and wrangler's `--profile`. Anything else is refused, because wrangler's
 * options can replace what the files hold (`--var`, `--route`, `--triggers`, `--compatibility-date`, `--config`,
 * `--env`, `--secrets-file`, ...). A leading `--`, which `pnpm run deploy -- --dry-run` passes on, is dropped.
 */
export function parseDeployArgs(argv: readonly string[]): DeployArgs {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let dryRun = false;
  const auth: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--dry-run") dryRun = true;
    else if (/^--profile=[\w.-]+$/.test(arg)) auth.push(arg);
    else if (arg === "--profile" && /^[\w.-]+$/.test(args[i + 1] ?? "")) auth.push(arg, args[++i] ?? "");
    else fail(`unknown option ${JSON.stringify(arg)}; only --dry-run and --profile <name> are accepted`);
  }
  return { dryRun, auth };
}

/** A wrangler command, its arguments after `wrangler`, and what the script requires of it besides exit status 0. */
export type DeployStep = {
  readonly args: readonly string[];
  /** `no-pending`: its output says no migration is left to apply ({@link noPendingMigrations}). */
  readonly expect?: "no-pending";
};

/**
 * The wrangler commands a deployment runs, in order: for each D1 binding, the remote migrations, then a check that none
 * is left; then the deployment. `d1 migrations apply` exits 0 when the owner answers no to its confirmation, so its exit
 * status does not say the database is migrated; `d1 migrations list` reads the database's state, after whatever the
 * owner answered, and the deployment runs only when it reports nothing pending.
 */
export function deploySteps(merged: Json, config: string, auth: readonly string[]): DeployStep[] {
  const common = ["--config", config, ...auth];
  const databases = Array.isArray(merged["d1_databases"]) ? (merged["d1_databases"] as unknown[]).filter(isRecord) : [];
  return [
    ...databases.flatMap((database): DeployStep[] => {
      const binding = String(database["binding"]);
      return [
        { args: ["d1", "migrations", "apply", binding, "--remote", ...common] },
        { args: ["d1", "migrations", "list", binding, "--remote", ...common], expect: "no-pending" },
      ];
    }),
    { args: ["deploy", ...common] },
  ];
}

/**
 * Whether `wrangler d1 migrations list` reported no pending migration. wrangler 4 prints "No migrations to apply!" in
 * that case and a "Migrations to be applied:" table otherwise, exiting 0 either way; it has no machine-readable output
 * for this command. Anything else, a changed wording included, counts as pending, so the deployment stops.
 */
export function noPendingMigrations(output: string): boolean {
  return output.includes("No migrations to apply!") && !output.includes("Migrations to be applied");
}
