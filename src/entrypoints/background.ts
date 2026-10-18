import * as v from "valibot";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { translateWith } from "../lib/clients.ts";
import { MessageSchema } from "../lib/messages.ts";
import { resolveChoice } from "../lib/providers.ts";
import { apiKeyItems } from "../lib/api-keys.ts";
import { cacheItem, modelChoiceItem } from "../lib/settings.ts";
import { createTranslateService } from "../lib/translate-service.ts";
import type { TranslationResult } from "../lib/translation.ts";

export default defineBackground(() => {
  const translate = createTranslateService({
    getChoice: async () => resolveChoice(await modelChoiceItem.getValue()),
    getApiKey: (provider) => apiKeyItems[provider].getValue(),
    getCache: () => cacheItem.getValue(),
    setCache: (cache) => cacheItem.setValue(cache),
    translate: (segments, choice, apiKey) => translateWith(choice, segments, apiKey),
    now: () => Date.now(),
  });

  // Answers true when the response is sent asynchronously.
  browser.runtime.onMessage.addListener((raw, sender, sendResponse): boolean => {
    // Only this extension's own content scripts and pages.
    if (sender.id !== browser.runtime.id) return false;
    const parsed = v.safeParse(MessageSchema, raw);
    if (!parsed.success) return false;
    const message = parsed.output;
    if (message.type === "open-options") {
      void browser.runtime.openOptionsPage();
      return false;
    }
    // Storage failing must still answer, or the page would wait forever.
    const failed: TranslationResult = { ok: false, code: "api-error" };
    void translate(message.key, message.segments).then(sendResponse, () => sendResponse(failed));
    return true;
  });
});
