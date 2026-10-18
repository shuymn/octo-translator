import { describe, expect, test, vi } from "vitest";
import { createMessageHandler } from "./message-handler.ts";
import type { TranslateService } from "./translate-service.ts";
import type { TranslationResult } from "./translation.ts";

const OWN = { id: "own-extension" };
const TRANSLATE = { type: "translate", key: "o/r#1", segments: [{ kind: "paragraph", text: "Text" }] };

function setup(translate: TranslateService = async () => ({ ok: true, translations: ["訳"] })) {
  const deps = {
    runtimeId: OWN.id,
    translate: vi.fn<TranslateService>(translate),
    openOptions: vi.fn<() => void>(),
  };
  const sendResponse = vi.fn<(response: TranslationResult) => void>();
  return { handle: createMessageHandler(deps), deps, sendResponse };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MSG-1: the background's message handler", () => {
  test.each([
    ["from another extension", TRANSLATE, { id: "other-extension" }],
    ["from a sender without an id", TRANSLATE, {}],
    ["of an unknown type", { type: "read-api-key" }, OWN],
    [
      "of a malformed translate shape",
      { type: "translate", key: "o/r#1", segments: [{ kind: "script", text: 1 }] },
      OWN,
    ],
    ["that is not an object", "translate", OWN],
  ])("ignores a message %s", async (_, message, sender) => {
    const { handle, deps, sendResponse } = setup();
    expect(handle(message, sender, sendResponse)).toBe(false);
    await settle();
    expect(deps.translate).not.toHaveBeenCalled();
    expect(deps.openOptions).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  test("translates this extension's translate message and answers asynchronously", async () => {
    const { handle, deps, sendResponse } = setup();
    expect(handle(TRANSLATE, OWN, sendResponse)).toBe(true);
    await settle();
    expect(deps.translate).toHaveBeenCalledWith("o/r#1", [{ kind: "paragraph", text: "Text" }]);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, translations: ["訳"] });
    expect(deps.openOptions).not.toHaveBeenCalled();
  });

  test("opens the options for this extension's open-options message, without an answer", async () => {
    const { handle, deps, sendResponse } = setup();
    expect(handle({ type: "open-options" }, OWN, sendResponse)).toBe(false);
    await settle();
    expect(deps.openOptions).toHaveBeenCalledTimes(1);
    expect(deps.translate).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  test("answers api-error when the translation throws", async () => {
    const { handle, sendResponse } = setup(async () => {
      throw new Error("storage failed");
    });
    expect(handle(TRANSLATE, OWN, sendResponse)).toBe(true);
    await settle();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, code: "api-error" });
  });
});
