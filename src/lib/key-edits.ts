import { PROVIDERS, type Provider } from "./providers.ts";

export type Keys = Record<Provider, string>;

// The keys the owner changed on this page since it loaded or last saved, trimmed. Only these are written, so saving in
// an options page opened before another one saved a key does not put the old value back.
export function editedKeys(loaded: Keys, current: Keys): Partial<Keys> {
  const edited: Partial<Keys> = {};
  for (const provider of PROVIDERS) {
    if (current[provider] !== loaded[provider]) edited[provider] = current[provider].trim();
  }
  return edited;
}
