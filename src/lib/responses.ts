import * as v from "valibot";
import type { Provider, ThinkingLevel } from "./providers.ts";
import {
  errorCodeOfStatus,
  parseTranslations,
  sourceTooLong,
  SYSTEM_INSTRUCTION,
  type SourceSegment,
  type TranslationResult,
} from "./translation.ts";

// A client of the Responses API, which DeepSeek and OpenAI both serve. It depends on no extension or DOM API, so the
// Worker can run it too.

export type ResponsesProvider = Extract<Provider, "deepseek" | "openai">;

// Fixed per provider and never configurable, so the key cannot be sent anywhere else (KEY-2).
export const ENDPOINTS: Record<ResponsesProvider, string> = {
  // The base URL `https://api.deepseek.com` with the OpenAI SDK's `/responses` path.
  // https://api-docs.deepseek.com/guides/responses_api/
  deepseek: "https://api.deepseek.com/responses",
  // https://developers.openai.com/api/docs/guides/structured-outputs
  openai: "https://api.openai.com/v1/responses",
};

// The same bound as Gemini's: a thinking model takes long on a long description (RES-1).
const TIMEOUT_MS = 120_000;

export type ResponsesOptions = { model: string; thinking: ThinkingLevel };

const ResponseSchema = v.object({
  status: v.string(),
  output: v.array(
    v.object({
      type: v.string(),
      content: v.optional(v.array(v.object({ type: v.string(), text: v.optional(v.string()) }))),
    }),
  ),
});

export function buildResponsesBody(segments: SourceSegment[], options: ResponsesOptions): unknown {
  return {
    model: options.model,
    instructions: SYSTEM_INSTRUCTION,
    input: JSON.stringify({ segments }),
    // DeepSeek thinks by default; `none` turns it off (https://api-docs.deepseek.com/guides/thinking_mode).
    reasoning: { effort: options.thinking },
    // DeepSeek states `text.format` as fully supported; OpenAI's strict mode needs every property required and no
    // others allowed (https://developers.openai.com/api/docs/guides/structured-outputs).
    text: {
      format: {
        type: "json_schema",
        name: "translations",
        strict: true,
        schema: {
          type: "object",
          properties: { translations: { type: "array", items: { type: "string" } } },
          required: ["translations"],
          additionalProperties: false,
        },
      },
    },
    // Not kept on the provider's side. DeepSeek ignores it and never stores a response.
    store: false,
  };
}

export async function translateResponses(
  provider: ResponsesProvider,
  segments: SourceSegment[],
  apiKey: string,
  options: ResponsesOptions,
  fetchFn: typeof fetch = fetch,
): Promise<TranslationResult> {
  if (apiKey === "") return { ok: false, code: "no-api-key" };
  if (sourceTooLong(segments)) return { ok: false, code: "too-long" };
  let response: Response;
  try {
    response = await fetchFn(ENDPOINTS[provider], {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildResponsesBody(segments, options)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: "network" };
  }
  if (!response.ok) return { ok: false, code: errorCodeOfStatus(response.status) };
  return parseResponse(await response.json().catch(() => undefined), segments.length);
}

// The text of the message items. A response cut short (`incomplete`) or failed is not read.
export function parseResponse(body: unknown, expected: number): TranslationResult {
  const response = v.safeParse(ResponseSchema, body);
  if (!response.success || response.output.status !== "completed") return { ok: false, code: "invalid-response" };
  const text = response.output.output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
  return parseTranslations(text, expected);
}
