import { expect, test, vi } from "vitest";
import { translateWith } from "./clients.ts";
import { defaultChoice, PROVIDERS } from "./providers.ts";

const ENDPOINTS = {
  deepseek: "https://api.deepseek.com/responses",
  openai: "https://api.openai.com/v1/responses",
  gemini: "https://generativelanguage.googleapis.com/v1beta/interactions",
};

test.each(PROVIDERS)("KEY-2: sends a %s request to that provider's endpoint only", async (provider) => {
  const fetchFn = vi.fn<typeof fetch>(async () => Response.json({}, { status: 500 }));
  await translateWith(defaultChoice(provider), [{ kind: "paragraph", text: "a" }], "key", fetchFn);
  expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([ENDPOINTS[provider]]);
});
