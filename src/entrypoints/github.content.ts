import * as v from "valibot";
import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { PageController, type Settings } from "../lib/controller.ts";
import { PROVIDER_LABEL } from "../lib/gemini.ts";
import { TranslationResultSchema, type SourceSegment, type TranslationResult } from "../lib/translation.ts";
import type { Message } from "../lib/messages.ts";
import { autoTranslateItem, privateRepositoriesItem } from "../lib/settings.ts";

async function requestTranslation(key: string, segments: SourceSegment[]): Promise<TranslationResult> {
  const message: Message = { type: "translate", key, segments };
  try {
    const parsed = v.safeParse(TranslationResultSchema, await browser.runtime.sendMessage(message));
    return parsed.success ? parsed.output : { ok: false, code: "invalid-response" };
  } catch {
    // The extension was reloaded or updated under the page.
    return { ok: false, code: "network" };
  }
}

function openOptions(): void {
  const message: Message = { type: "open-options" };
  void browser.runtime.sendMessage(message);
}

async function readSettings(): Promise<Settings> {
  return {
    autoTranslate: await autoTranslateItem.getValue(),
    privateRepositories: await privateRepositoriesItem.getValue(),
  };
}

export default defineContentScript({
  // Every GitHub page: GitHub moves between pages without loading them, so a script limited to pull requests would
  // miss one opened from a list.
  matches: ["https://github.com/*"],
  runAt: "document_idle",
  async main(ctx) {
    const controller = new PageController(
      {
        doc: document,
        pathname: () => location.pathname,
        providerLabel: PROVIDER_LABEL,
        translate: requestTranslation,
        openOptions,
      },
      await readSettings(),
    );

    const refresh = () => void readSettings().then((settings) => controller.updateSettings(settings));
    const unwatch = [autoTranslateItem.watch(refresh), privateRepositoriesItem.watch(refresh)];

    // One sync per frame, however many mutations GitHub makes in it.
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        controller.sync();
      });
    });
    // characterData: React writes an edited title into the existing text node.
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    controller.sync();

    ctx.onInvalidated(() => {
      observer.disconnect();
      for (const stop of unwatch) stop();
    });
  },
});
