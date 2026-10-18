import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { translateWith } from "../lib/clients.ts";
import { createMessageHandler } from "../lib/message-handler.ts";
import { resolveChoice } from "../lib/providers.ts";
import { apiKeyItems } from "../lib/api-keys.ts";
import { cacheItem, modelChoiceItem } from "../lib/settings.ts";
import { createTranslateService } from "../lib/translate-service.ts";

export default defineBackground(() => {
  const translate = createTranslateService({
    getChoice: async () => resolveChoice(await modelChoiceItem.getValue()),
    getApiKey: (provider) => apiKeyItems[provider].getValue(),
    getCache: () => cacheItem.getValue(),
    setCache: (cache) => cacheItem.setValue(cache),
    translate: (segments, choice, apiKey) => translateWith(choice, segments, apiKey),
    now: () => Date.now(),
  });

  browser.runtime.onMessage.addListener(
    createMessageHandler({
      runtimeId: browser.runtime.id,
      translate,
      openOptions: () => void browser.runtime.openOptionsPage(),
    }),
  );
});
