import { translateSegments } from "./gemini.ts";
import type { ModelChoice, Provider } from "./providers.ts";
import { translateResponses } from "./responses.ts";
import type { SourceSegment, TranslationResult } from "./translation.ts";

type Client = (
  segments: SourceSegment[],
  apiKey: string,
  choice: ModelChoice,
  fetchFn?: typeof fetch,
) => Promise<TranslationResult>;

// The client of each provider.
const CLIENTS: Record<Provider, Client> = {
  deepseek: (segments, apiKey, choice, fetchFn) => translateResponses("deepseek", segments, apiKey, choice, fetchFn),
  openai: (segments, apiKey, choice, fetchFn) => translateResponses("openai", segments, apiKey, choice, fetchFn),
  gemini: (segments, apiKey, choice, fetchFn) => translateSegments(segments, apiKey, choice, fetchFn),
};

// Translates with the chosen provider, model and thinking level.
export function translateWith(
  choice: ModelChoice,
  segments: SourceSegment[],
  apiKey: string,
  fetchFn?: typeof fetch,
): Promise<TranslationResult> {
  return CLIENTS[choice.provider](segments, apiKey, choice, fetchFn);
}
