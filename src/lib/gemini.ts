import * as v from "valibot";
import type { ThinkingLevel } from "./providers.ts";
import {
  errorCodeOfStatus,
  parseTranslations,
  sourceTooLong,
  SYSTEM_INSTRUCTION,
  type SourceSegment,
  type TranslationError,
  type TranslationResult,
} from "./translation.ts";

// The Interactions API, which Google recommends over generateContent for new projects.
// https://ai.google.dev/gemini-api/docs/interactions
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
// High thinking takes longer than a plain completion on a long description.
const TIMEOUT_MS = 120_000;

export type GeminiOptions = { model: string; thinking: ThinkingLevel };

const InteractionSchema = v.object({
  status: v.string(),
  steps: v.array(
    v.object({
      type: v.string(),
      content: v.optional(v.array(v.object({ type: v.string(), text: v.optional(v.string()) }))),
    }),
  ),
});

export function buildRequestBody(segments: SourceSegment[], options: GeminiOptions): unknown {
  return {
    model: options.model,
    system_instruction: SYSTEM_INSTRUCTION,
    input: JSON.stringify({ segments }),
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema: {
        type: "object",
        properties: { translations: { type: "array", items: { type: "string" } } },
        required: ["translations"],
      },
    },
    // The levels each model takes are in `providers.ts`.
    generation_config: { thinking_level: options.thinking },
    // Not kept on Google's side: nothing refers back to an earlier interaction.
    store: false,
  };
}

export async function translateSegments(
  segments: SourceSegment[],
  apiKey: string,
  options: GeminiOptions,
  fetchFn: typeof fetch = fetch,
): Promise<TranslationResult> {
  if (apiKey === "") return { ok: false, code: "no-api-key" };
  if (sourceTooLong(segments)) return { ok: false, code: "too-long" };
  let response: Response;
  try {
    response = await fetchFn(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(buildRequestBody(segments, options)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: "network" };
  }
  if (!response.ok) return { ok: false, code: errorCodeOf(response.status, await response.text().catch(() => "")) };
  return parseInteraction(await response.json().catch(() => undefined), segments.length);
}

function errorCodeOf(status: number, body: string): TranslationError {
  // A 400 is an invalid key (API_KEY_INVALID) or a request the model refuses, such as an unsupported parameter.
  if (status === 400 && /api[ _]?key/i.test(body)) return "api-key-rejected";
  return errorCodeOfStatus(status);
}

export function parseInteraction(body: unknown, expected: number): TranslationResult {
  const interaction = v.safeParse(InteractionSchema, body);
  if (!interaction.success || interaction.output.status !== "completed") return { ok: false, code: "invalid-response" };
  const text = interaction.output.steps
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
  return parseTranslations(text, expected);
}
