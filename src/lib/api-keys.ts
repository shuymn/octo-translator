import { storage } from "wxt/utils/storage";
import type { Provider } from "./providers.ts";

// The API keys and the Worker's service token, in storage.local (storage.sync would copy them to every signed-in
// browser). Apart from `settings.ts` on purpose: WXT reads an item's value as soon as it is defined, so a script that
// imports this module reads every secret. Only the background and the options page import it (KEY-1).

function secret(key: `local:${string}`) {
  return storage.defineItem<string>(key, { fallback: "" });
}

// One key per provider, so switching providers keeps the others. Gemini's keeps the name it had when it was the only
// provider, so a saved key still works.
export const apiKeyItems = {
  deepseek: secret("local:deepseekApiKey"),
  openai: secret("local:openaiApiKey"),
  gemini: secret("local:apiKey"),
} satisfies Record<Provider, unknown>;

// The owner's Worker (stage 2): its origin and the Cloudflare Access service token that opens it, `null` when there is
// none. One item, so the origin and its token are written and read together and a token is never paired with another
// origin. It holds a secret, so it shares the keys' module and confinement (KEY-1); the token is sent only to that
// origin (KEY-4). Read it through `resolveWorker`.
export const workerAccessItem = storage.defineItem<unknown>("local:workerAccess", { fallback: null });
