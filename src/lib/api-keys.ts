import { storage } from "wxt/utils/storage";
import type { Provider } from "./providers.ts";

// The API keys, in storage.local (storage.sync would copy them to every signed-in browser). Apart from
// `settings.ts` on purpose: WXT reads an item's value as soon as it is defined, so a script that imports this module
// reads every key. Only the background and the options page import it (KEY-1).

function apiKey(key: `local:${string}`) {
  return storage.defineItem<string>(key, { fallback: "" });
}

// One key per provider, so switching providers keeps the others. Gemini's keeps the name it had when it was the only
// provider, so a saved key still works.
export const apiKeyItems = {
  deepseek: apiKey("local:deepseekApiKey"),
  openai: apiKey("local:openaiApiKey"),
  gemini: apiKey("local:apiKey"),
} satisfies Record<Provider, unknown>;
