import * as v from "valibot";
import type { ModelChoice } from "./providers.ts";
import {
  TranslationResultSchema,
  type SourceSegment,
  type TranslationError,
  type TranslationResult,
} from "./translation.ts";

// The client of the owner's Worker (stage 2), which translates with its own provider keys and answers the extension's
// `TranslationResult`. It depends on no extension API: the URL, the service token and `fetch` are arguments.

// Where and how to reach the Worker. The token is a Cloudflare Access service token, sent only to `origin` (KEY-4).
// Stored as one item, so the origin and its token are always written and read together.
export type WorkerAccess = { origin: string; clientId: string; clientSecret: string };

// The stored item as read back: storage holds whatever was written there, so it is checked again.
const StoredAccessSchema = v.object({ origin: v.string(), clientId: v.string(), clientSecret: v.string() });

// The Worker as the background finds it: not configured, configured but unusable (a stored value of another shape, a
// URL that no longer parses, a missing half of the token, or the origin's host permission revoked), or ready.
export type WorkerSetting = { state: "off" } | { state: "invalid" } | { state: "on"; access: WorkerAccess };

export const WORKER_FAILURES = ["unreachable", "server-error", "rejected", "invalid-response"] as const;
export type WorkerFailure = (typeof WORKER_FAILURES)[number];

export type WorkerResult = { ok: true; result: TranslationResult } | { ok: false; code: WorkerFailure };

// What each failure means for the request: whether the background translates locally instead, and the code it answers
// when it does not (or has no local key to do it with). Only a Worker that cannot be reached falls back; a refusal
// would otherwise hide a broken setup behind local translations.
export const WORKER_FAILURE_HANDLING: Record<WorkerFailure, { fallBack: boolean; code: TranslationError }> = {
  unreachable: { fallBack: true, code: "worker-unreachable" },
  "server-error": { fallBack: true, code: "worker-unreachable" },
  rejected: { fallBack: false, code: "worker-rejected" },
  "invalid-response": { fallBack: false, code: "invalid-response" },
};

// The route of `worker/src/handler.ts` that translates.
export const TRANSLATE_PATH = "/v1/translate";

// Longer than the provider clients' 120 seconds (RES-1), so the Worker's own provider call can finish first.
const TIMEOUT_MS = 130_000;

// The Worker URL the options accept: https, the default port, and nothing after the host but an optional `/`. Only the
// origin is kept, so the token can go to one origin only and the host permission asked for is exactly that origin.
export function parseWorkerUrl(input: string): { ok: true; origin: string } | { ok: false } {
  const text = input.trim();
  if (!URL.canParse(text)) return { ok: false };
  const url = new URL(text);
  const originOnly =
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    !text.endsWith("?") &&
    !text.endsWith("#");
  return originOnly ? { ok: true, origin: url.origin } : { ok: false };
}

// The match pattern of the optional host permission for a Worker origin.
export function originPattern(origin: string): string {
  return `${origin}/*`;
}

// The stored item when it has the configuration's shape; its values are checked by the caller.
export function storedAccess(stored: unknown): WorkerAccess | undefined {
  const parsed = v.safeParse(StoredAccessSchema, stored);
  return parsed.success ? parsed.output : undefined;
}

// The origin of a stored configuration, when it still parses.
export function storedOrigin(stored: unknown): string | undefined {
  const url = parseWorkerUrl(storedAccess(stored)?.origin ?? "");
  return url.ok ? url.origin : undefined;
}

export type WorkerSettingDeps = {
  // The stored Worker configuration: `null` when there is none, else `{ origin, clientId, clientSecret }`.
  getAccess: () => Promise<unknown>;
  hasPermission: (origins: string[]) => Promise<boolean>;
};

// Reads the Worker configuration once, so the origin and the token always come from the same write, and checks it
// again.
export async function resolveWorker(deps: WorkerSettingDeps): Promise<WorkerSetting> {
  const stored = await deps.getAccess();
  if (stored === null || stored === undefined) return { state: "off" };
  const access = storedAccess(stored);
  if (access === undefined) return { state: "invalid" };
  const { clientId, clientSecret } = access;
  const url = parseWorkerUrl(access.origin);
  if (!url.ok || clientId === "" || clientSecret === "") return { state: "invalid" };
  if (!(await deps.hasPermission([originPattern(url.origin)]))) return { state: "invalid" };
  return { state: "on", access: { origin: url.origin, clientId, clientSecret } };
}

export type WorkerRequest = { key: string; segments: SourceSegment[]; choice: ModelChoice };

// Asks the Worker to translate. The service token goes only in the Access headers to the configured origin; the body
// carries the pull request, its segments and the choice, and never a provider key (KEY-4).
export async function translateWithWorker(
  access: WorkerAccess,
  request: WorkerRequest,
  fetchFn: typeof fetch = fetch,
): Promise<WorkerResult> {
  let response: Response;
  try {
    response = await fetchFn(`${access.origin}${TRANSLATE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/
        "CF-Access-Client-Id": access.clientId,
        "CF-Access-Client-Secret": access.clientSecret,
      },
      body: JSON.stringify({ key: request.key, segments: request.segments, choice: request.choice }),
      // Access answers a request it does not admit with a redirect to its login page unless strict service token
      // authentication is on. Following it would carry the token's headers to another origin, so a redirect is a
      // refusal.
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: "unreachable" };
  }
  const failure = failureOfStatus(response);
  if (failure !== undefined) return { ok: false, code: failure };
  // The body arrives after the status: a connection lost or the timeout reached while reading it is still an outage.
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, code: "unreachable" };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, code: "invalid-response" };
  }
  const parsed = v.safeParse(TranslationResultSchema, json);
  if (!parsed.success) return { ok: false, code: "invalid-response" };
  const result = parsed.output;
  if (result.ok && result.translations.length !== request.segments.length) {
    return { ok: false, code: "invalid-response" };
  }
  return { ok: true, result };
}

// The Worker answers every translation outcome with 200 (`worker/src/http.ts`); anything else is its own refusal, an
// outage, or not the Worker at all. A 429 is Access's or Cloudflare's refusal, not a provider's limit: that one arrives
// inside a 200 as `rate-limited`.
function failureOfStatus(response: Response): WorkerFailure | undefined {
  if (response.type === "opaqueredirect") return "rejected";
  const { status } = response;
  if (status === 200) return undefined;
  if (status >= 500) return "server-error";
  if (status >= 200 && status < 300) return "invalid-response";
  return "rejected";
}
