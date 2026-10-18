import * as v from "valibot";

// The model providers, their models and the thinking levels each model accepts. The options page offers only these
// combinations, and a stored choice is checked against them when it is read. Data only: the clients that call each
// provider are in `clients.ts`, so the content script can show a provider's name without bundling them.

export const PROVIDERS = ["deepseek", "openai", "gemini"] as const;
export type Provider = (typeof PROVIDERS)[number];

// How long the model thinks before it answers, by the names the Responses API uses for `reasoning.effort`. Gemini's
// `thinking_level` uses the same names for the levels it has.
export const THINKING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  none: "なし",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "より高",
  max: "最大",
};

export type ModelSpec = {
  id: string;
  label: string;
  thinking: readonly [ThinkingLevel, ...ThinkingLevel[]];
  defaultThinking: ThinkingLevel;
};

export type ProviderSpec = {
  // The provider's name as the page and the options show it.
  label: string;
  // The first model is the provider's default.
  models: readonly [ModelSpec, ...ModelSpec[]];
  // Where the owner creates a key, named as the site names itself.
  keySite: { name: string; url: string };
};

export const PROVIDER_SPECS: Record<Provider, ProviderSpec> = {
  deepseek: {
    label: "DeepSeek",
    models: [
      {
        // `deepseek-flash` is served by DeepSeek-V4.1-Flash; it thinks unless `reasoning.effort` is `none`, and the
        // Responses API takes none, low, high and max.
        // https://api-docs.deepseek.com/quick_start/pricing
        // https://api-docs.deepseek.com/guides/thinking_mode
        id: "deepseek-flash",
        label: "DeepSeek V4.1 Flash",
        thinking: ["none", "low", "high", "max"],
        defaultThinking: "none",
      },
    ],
    keySite: { name: "DeepSeek Platform", url: "https://platform.deepseek.com/api_keys" },
  },
  openai: {
    label: "OpenAI",
    models: [
      // https://developers.openai.com/api/docs/models/gpt-6-luna
      {
        id: "gpt-6-luna",
        label: "GPT-6 Luna",
        thinking: ["none", "low", "medium", "high", "xhigh", "max"],
        defaultThinking: "none",
      },
      // Does not take none (https://developers.openai.com/api/docs/guides/reasoning).
      {
        id: "gpt-6.1-sol",
        label: "GPT-6.1 Sol",
        thinking: ["low", "medium", "high", "xhigh", "max"],
        defaultThinking: "low",
      },
    ],
    keySite: { name: "OpenAI Platform", url: "https://platform.openai.com/api-keys" },
  },
  gemini: {
    label: "Gemini",
    models: [
      // 3.8 Flash supports low, medium and high; high gives the most natural Japanese.
      {
        id: "gemini-3.8-flash",
        label: "Gemini 3.8 Flash",
        thinking: ["low", "medium", "high"],
        defaultThinking: "high",
      },
    ],
    keySite: { name: "Google AI Studio", url: "https://aistudio.google.com/apikey" },
  },
};

export type ModelChoice = { provider: Provider; model: string; thinking: ThinkingLevel };

export function findModel(provider: Provider, model: string): ModelSpec | undefined {
  return PROVIDER_SPECS[provider].models.find((spec) => spec.id === model);
}

export function isSupported(choice: ModelChoice): boolean {
  return findModel(choice.provider, choice.model)?.thinking.includes(choice.thinking) ?? false;
}

// The provider's first model at its default level.
export function defaultChoice(provider: Provider): ModelChoice {
  const [model] = PROVIDER_SPECS[provider].models;
  return { provider, model: model.id, thinking: model.defaultThinking };
}

// What the extension uses when nothing is saved: DeepSeek V4.1 Flash without thinking.
export const DEFAULT_CHOICE: ModelChoice = defaultChoice("deepseek");

const StoredChoiceSchema = v.object({
  provider: v.picklist(PROVIDERS),
  model: v.string(),
  thinking: v.picklist(THINKING_LEVELS),
});

const StoredProviderSchema = v.object({ provider: v.picklist(PROVIDERS) });

// A stored choice, checked against the table: an unknown provider falls back to the default choice, and a model or
// level the provider does not offer (one removed from the table, say) falls back to that provider's default.
export function resolveChoice(stored: unknown): ModelChoice {
  const provider = v.safeParse(StoredProviderSchema, stored);
  if (!provider.success) return DEFAULT_CHOICE;
  const parsed = v.safeParse(StoredChoiceSchema, stored);
  return parsed.success && isSupported(parsed.output) ? parsed.output : defaultChoice(provider.output.provider);
}

// A choice to save, refused unless the table offers it, rather than replaced like a stored one.
export function parseChoice(input: unknown): { ok: true; choice: ModelChoice } | { ok: false; code: "unsupported" } {
  const parsed = v.safeParse(StoredChoiceSchema, input);
  return parsed.success && isSupported(parsed.output)
    ? { ok: true, choice: parsed.output }
    : { ok: false, code: "unsupported" };
}

// The choice after the model changes: the level stays when the new model has it.
export function withModel(choice: ModelChoice, model: string): ModelChoice {
  const spec = findModel(choice.provider, model);
  if (!spec) return defaultChoice(choice.provider);
  return {
    ...choice,
    model,
    thinking: spec.thinking.includes(choice.thinking) ? choice.thinking : spec.defaultThinking,
  };
}

// Identifies the model that made a translation, so the cache does not answer one made with another choice.
export function choiceKey(choice: ModelChoice): string {
  return `${choice.provider}/${choice.model}/${choice.thinking}`;
}
