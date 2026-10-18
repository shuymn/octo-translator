/**
 * The scheduled translation's settings, read from the Worker's environment at the start of each run. A missing or
 * malformed value stops the run before anything is searched or sent: the schedule fails closed.
 */
import * as v from "valibot";
import { DEFAULT_CHOICE, parseChoice, PROVIDERS, type ModelChoice } from "../../src/lib/providers.ts";
import { compileFilter, type Filter } from "./filter.ts";
import { API_KEY_SECRETS, apiKeyOf } from "./translate.ts";

export const SCHEDULED_CONFIG_ERRORS = [
  "malformed-setting",
  "missing-database",
  "missing-github-token",
  "invalid-filter",
  "invalid-allowlist",
  "unsupported-choice",
  "no-api-key",
] as const;
export type ScheduledConfigError = (typeof SCHEDULED_CONFIG_ERRORS)[number];

export type ScheduledConfig = {
  readonly db: D1Database;
  /** KEY-5: passed only to `createGitHubClient`. */
  readonly githubToken: string;
  readonly filter: Filter;
  /** PRIV-1: the private repositories that may be translated, `owner/repo` lowercased. */
  readonly allowlist: ReadonlySet<string>;
  /** The choice translations are made and stored with; the extension finds them when it asks with the same one. */
  readonly choice: ModelChoice;
  /** KEY-2: the key of the choice's provider, passed only to `translateWith`. */
  readonly apiKey: string;
};

export type ScheduledConfigResult =
  | { readonly ok: true; readonly config: ScheduledConfig }
  | { readonly ok: false; readonly code: ScheduledConfigError };

const D1Schema = v.custom<D1Database>(
  (input) => typeof input === "object" && input !== null && "prepare" in input && typeof input.prepare === "function",
);

/** `owner/repo` as GitHub allows the names. */
const REPOSITORY = /^[a-z0-9-]+\/[a-z0-9._-]+$/;

const EnvSchema = v.object({
  DB: v.optional(v.unknown()),
  ...Object.fromEntries(PROVIDERS.map((provider) => [API_KEY_SECRETS[provider], v.optional(v.string())])),
  GITHUB_TOKEN: v.optional(v.string(), ""),
  AHEAD_OF_TIME_FILTER: v.optional(v.string(), ""),
  PRIVATE_REPOSITORIES: v.optional(v.string(), ""),
  AHEAD_OF_TIME_CHOICE: v.optional(v.string(), ""),
});

export function parseScheduledConfig(env: unknown): ScheduledConfigResult {
  const parsed = v.safeParse(EnvSchema, env);
  // Every setting is a string when present.
  if (!parsed.success) return { ok: false, code: "malformed-setting" };
  const values = parsed.output;
  const db = v.safeParse(D1Schema, values.DB);
  if (!db.success) return { ok: false, code: "missing-database" };
  const githubToken = values.GITHUB_TOKEN.trim();
  if (githubToken === "" || /\s/.test(githubToken)) return { ok: false, code: "missing-github-token" };
  const compiled = compileFilter(values.AHEAD_OF_TIME_FILTER);
  if (!compiled.ok) return { ok: false, code: "invalid-filter" };
  const allowlist = parseAllowlist(values.PRIVATE_REPOSITORIES);
  if (allowlist === undefined) return { ok: false, code: "invalid-allowlist" };
  const choice = parseChoiceSetting(values.AHEAD_OF_TIME_CHOICE);
  if (choice === undefined) return { ok: false, code: "unsupported-choice" };
  const apiKey = apiKeyOf(values, choice.provider);
  if (apiKey === undefined) return { ok: false, code: "no-api-key" };
  return { ok: true, config: { db: db.output, githubToken, filter: compiled.filter, allowlist, choice, apiKey } };
}

/** `owner/repo` entries separated by commas or white space; one that is not a repository name refuses the whole list. */
function parseAllowlist(setting: string): ReadonlySet<string> | undefined {
  const entries = setting
    .split(/[\s,]+/)
    .filter((entry) => entry !== "")
    .map((entry) => entry.toLowerCase());
  return entries.every((entry) => REPOSITORY.test(entry)) ? new Set(entries) : undefined;
}

/**
 * `provider/model/thinking`, as `choiceKey` writes it; empty means the extension's default choice. Also run by the
 * deployment script (worker/scripts/deploy-config.ts), so a deployed choice is one the schedule accepts.
 */
export function parseChoiceSetting(setting: string): ModelChoice | undefined {
  if (setting.trim() === "") return DEFAULT_CHOICE;
  const [provider, model, thinking, ...rest] = setting.trim().split("/");
  if (rest.length > 0) return undefined;
  // `parseChoice` checks the provider, the model and the thinking level together.
  const parsed = parseChoice({ provider, model, thinking });
  return parsed.ok ? parsed.choice : undefined;
}
