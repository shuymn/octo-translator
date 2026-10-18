import * as v from "valibot";
import { MessageSchema } from "./messages.ts";
import type { TranslateService } from "./translate-service.ts";
import type { TranslationResult } from "./translation.ts";

export type MessageHandlerDeps = {
  // This extension's id (`browser.runtime.id`).
  runtimeId: string;
  translate: TranslateService;
  openOptions: () => void;
};

export type MessageHandler = (
  raw: unknown,
  sender: { id?: string },
  sendResponse: (response: TranslationResult) => void,
) => boolean;

// The background's `runtime.onMessage` listener (MSG-1). It acts only on this extension's own messages of known shapes;
// anything else gets no answer. Answers true when the response is sent asynchronously.
export function createMessageHandler(deps: MessageHandlerDeps): MessageHandler {
  return (raw, sender, sendResponse) => {
    // Only this extension's own content scripts and pages.
    if (sender.id !== deps.runtimeId) return false;
    const parsed = v.safeParse(MessageSchema, raw);
    if (!parsed.success) return false;
    const message = parsed.output;
    if (message.type === "open-options") {
      deps.openOptions();
      return false;
    }
    // Storage failing must still answer, or the page would wait forever.
    const failed: TranslationResult = { ok: false, code: "api-error" };
    void deps.translate(message.key, message.segments).then(sendResponse, () => sendResponse(failed));
    return true;
  };
}
