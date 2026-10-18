import { describe, expect, test, vi } from "vitest";
import { buildRequestBody, parseInteraction, translateSegments, type GeminiOptions } from "./gemini.ts";
import { MAX_SOURCE_CHARACTERS } from "./translation.ts";

function interaction(text: string, status = "completed"): unknown {
  return {
    object: "interaction",
    status,
    steps: [
      { type: "user_input", content: [{ type: "text", text: "ignored" }] },
      { type: "model_output", content: [{ type: "text", text }] },
    ],
  };
}

const OPTIONS: GeminiOptions = { model: "gemini-3.8-flash", thinking: "high" };

function respond(status: number, body: unknown): typeof fetch {
  return vi.fn<typeof fetch>(async () => Response.json(body, { status }));
}

describe("buildRequestBody", () => {
  test("PRIV-3: asks for JSON translations and no stored interaction", () => {
    expect(buildRequestBody([{ kind: "paragraph", text: "a" }], OPTIONS)).toMatchObject({
      model: "gemini-3.8-flash",
      input: JSON.stringify({ segments: [{ kind: "paragraph", text: "a" }] }),
      response_format: { mime_type: "application/json" },
      generation_config: { thinking_level: "high" },
      store: false,
    });
  });
});

describe("translateSegments", () => {
  test("KEY-2: sends the key in a header and answers the translations", async () => {
    const fetchFn = respond(200, interaction('{"translations":["修正","本文"]}'));
    await expect(
      translateSegments(
        [
          { kind: "title", text: "Fix" },
          { kind: "paragraph", text: "Body" },
        ],
        "key",
        OPTIONS,
        fetchFn,
      ),
    ).resolves.toEqual({
      ok: true,
      translations: ["修正", "本文"],
    });
    const [url, init] = vi.mocked(fetchFn).mock.calls[0] ?? [];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("key");
  });

  test("RES-1: does not call the API without a key or with too much text", async () => {
    const fetchFn = respond(200, {});
    await expect(translateSegments([{ kind: "paragraph", text: "a" }], "", OPTIONS, fetchFn)).resolves.toEqual({
      ok: false,
      code: "no-api-key",
    });
    await expect(
      translateSegments([{ kind: "paragraph", text: "a".repeat(MAX_SOURCE_CHARACTERS + 1) }], "key", OPTIONS, fetchFn),
    ).resolves.toEqual({
      ok: false,
      code: "too-long",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  // Statuses every provider shares are in translation.test.ts; a 400 is read from Gemini's body.
  test.each([
    [400, "api-key-rejected", { error: { message: "API key not valid. Please pass a valid API key." } }],
    [
      400,
      "api-error",
      { error: { message: "Thinking level THINKING_LEVEL_MINIMAL is not supported for this model." } },
    ],
    [429, "rate-limited", { error: {} }],
  ])("maps HTTP %i to %s", async (status, code, body) => {
    await expect(
      translateSegments([{ kind: "paragraph", text: "a" }], "key", OPTIONS, respond(status, body)),
    ).resolves.toEqual({
      ok: false,
      code,
    });
  });

  test("maps a failed request to network", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(translateSegments([{ kind: "paragraph", text: "a" }], "key", OPTIONS, fetchFn)).resolves.toEqual({
      ok: false,
      code: "network",
    });
  });
});

describe("parseInteraction", () => {
  test("reads the text of the model's output steps", () => {
    expect(parseInteraction(interaction('{"translations":["a"]}'), 1)).toEqual({ ok: true, translations: ["a"] });
  });

  // The checks on the text itself are in translation.test.ts; these two show the text goes through them.
  test.each([
    ["text that is not JSON", interaction("not json")],
    ["a different number of translations", interaction('{"translations":["a","b"]}')],
    ["an interaction that did not complete", interaction('{"translations":["a"]}', "failed")],
    ["a body that is not an interaction", { error: { code: 500 } }],
  ])("rejects %s", (_, body) => {
    expect(parseInteraction(body, 1)).toEqual({ ok: false, code: "invalid-response" });
  });
});
