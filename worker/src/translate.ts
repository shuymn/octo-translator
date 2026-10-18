/**
 * `POST /v1/translate`: the extension's translation, made by the Worker with the Worker's provider keys and stored in D1.
 * The handler routes here only after AUTH-1. The body is bounded and parsed before anything is looked up or sent
 * (RES-1, RES-3); a stored translation answers without a provider call (RES-2).
 */
import * as v from "valibot";
import { DEFAULT_CHOICE, parseChoice, PROVIDERS, type ModelChoice, type Provider } from "../../src/lib/providers.ts";
import {
  sourceTooLong,
  SourceSegmentSchema,
  type SourceSegment,
  type TranslationResult,
} from "../../src/lib/translation.ts";
import { readJsonBody } from "./body.ts";
import { failure, translation } from "./http.ts";
import { errorName, logEvent } from "./log.ts";
import { createTranslationStore, storedKey } from "./translations-db.ts";

/**
 * Bytes of request body. The source text is at most `MAX_SOURCE_CHARACTERS` (40,000) characters; at three UTF-8 bytes
 * each, with JSON's escapes and the segments' own fields, a legitimate request stays well under this.
 */
export const MAX_BODY_BYTES = 256 * 1024;

/** The Worker secret that holds each provider's key. None is required: a provider without one answers `no-api-key`. */
export const API_KEY_SECRETS: Record<Provider, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

/** `owner/repo#number`, as the extension's `pullRequestKey` makes it (lowercased). */
const PullRequestKeySchema = v.pipe(v.string(), v.maxLength(256), v.regex(/^[a-z0-9-]+\/[a-z0-9._-]+#[1-9]\d{0,9}$/));

const TranslateRequestSchema = v.strictObject({
  key: PullRequestKeySchema,
  segments: v.pipe(v.array(SourceSegmentSchema), v.minLength(1)),
  choice: v.optional(v.unknown()),
});

const D1Schema = v.custom<D1Database>(
  (input) => typeof input === "object" && input !== null && "prepare" in input && typeof input.prepare === "function",
);

const TranslateEnvSchema = v.object({
  DB: D1Schema,
  ...Object.fromEntries(PROVIDERS.map((provider) => [API_KEY_SECRETS[provider], v.optional(v.string())])),
});

export type TranslateDependencies = {
  /** `translateWith` from `src/lib/clients.ts` in the Worker; a fake in tests. */
  readonly translate: (choice: ModelChoice, segments: SourceSegment[], apiKey: string) => Promise<TranslationResult>;
  readonly now: () => number;
};

export async function handleTranslate(request: Request, env: unknown, deps: TranslateDependencies): Promise<Response> {
  const parsedEnv = v.safeParse(TranslateEnvSchema, env);
  if (!parsedEnv.success) return failure("misconfigured");

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return failure(body.code);
  const input = v.safeParse(TranslateRequestSchema, body.value);
  if (!input.success) return failure("bad-request");
  const { key, segments } = input.output;
  let choice = DEFAULT_CHOICE;
  if (input.output.choice !== undefined) {
    const parsed = parseChoice(input.output.choice);
    if (!parsed.ok) return failure("unsupported-choice");
    choice = parsed.choice;
  }
  if (sourceTooLong(segments)) return translation({ ok: false, code: "too-long" });

  // Taken before the lookup and the translation: the store orders text versions by when their request started (RES-2).
  const requestedAt = deps.now();
  const store = createTranslationStore(parsedEnv.output.DB, deps.now);
  const stored = await storedKey(key, segments, choice);
  const cached = await store.lookup(stored, segments.length).catch((error: unknown) => {
    logEvent("octo.translations.lookup.failed", { error: errorName(error) });
    return undefined;
  });
  if (cached !== undefined) return translation({ ok: true, translations: cached });

  const apiKey = apiKeyOf(parsedEnv.output, choice.provider);
  if (apiKey === undefined) return translation({ ok: false, code: "no-api-key" });
  const result = await deps.translate(choice, segments, apiKey);
  if (!result.ok) return translation(result);
  await store.save(stored, result.translations, requestedAt).catch((error: unknown) => {
    // The store only saves requests; the translation is still good.
    logEvent("octo.translations.save.failed", { error: errorName(error) });
  });
  return translation(result);
}

export function apiKeyOf(env: Readonly<Record<string, unknown>>, provider: Provider): string | undefined {
  const key = env[API_KEY_SECRETS[provider]];
  return typeof key === "string" && key !== "" ? key : undefined;
}
