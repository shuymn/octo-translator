import { describe, expect, test, vi } from "vitest";
import { buildResponsesBody, parseResponse, translateResponses, type ResponsesOptions } from "./responses.ts";
import { MAX_SOURCE_CHARACTERS, SYSTEM_INSTRUCTION } from "./translation.ts";

const OPTIONS: ResponsesOptions = { model: "deepseek-flash", thinking: "none" };

function response(text: string, status = "completed"): unknown {
  return {
    object: "response",
    status,
    output: [
      { type: "reasoning", content: [{ type: "reasoning_text", text: "ignored" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] },
    ],
  };
}

function respond(status: number, body: unknown): typeof fetch {
  return vi.fn<typeof fetch>(async () => Response.json(body, { status }));
}

describe("buildResponsesBody", () => {
  test("PRIV-3: sends the prompt, the model and level chosen, a JSON schema, and asks not to store", () => {
    expect(buildResponsesBody([{ kind: "paragraph", text: "a" }], OPTIONS)).toMatchObject({
      model: "deepseek-flash",
      instructions: SYSTEM_INSTRUCTION,
      input: JSON.stringify({ segments: [{ kind: "paragraph", text: "a" }] }),
      reasoning: { effort: "none" },
      text: { format: { type: "json_schema", strict: true } },
      store: false,
    });
  });
});

describe("translateResponses", () => {
  test.each([
    ["deepseek", "https://api.deepseek.com/responses"],
    ["openai", "https://api.openai.com/v1/responses"],
  ] as const)("KEY-2: sends the key only in the header to %s's endpoint", async (provider, endpoint) => {
    const fetchFn = respond(200, response('{"translations":["修正","本文"]}'));
    await expect(
      translateResponses(
        provider,
        [
          { kind: "title", text: "Fix" },
          { kind: "paragraph", text: "Body" },
        ],
        "secret",
        OPTIONS,
        fetchFn,
      ),
    ).resolves.toEqual({ ok: true, translations: ["修正", "本文"] });
    const [url, init] = vi.mocked(fetchFn).mock.calls[0] ?? [];
    // The URL is the fixed endpoint, so it carries no key.
    expect(url).toBe(endpoint);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
    expect(typeof init?.body === "string" && init.body.includes("secret")).toBe(false);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("RES-1: does not call the API without a key or with too much text", async () => {
    const fetchFn = respond(200, {});
    await expect(
      translateResponses("deepseek", [{ kind: "paragraph", text: "a" }], "", OPTIONS, fetchFn),
    ).resolves.toEqual({ ok: false, code: "no-api-key" });
    await expect(
      translateResponses(
        "openai",
        [{ kind: "paragraph", text: "a".repeat(MAX_SOURCE_CHARACTERS + 1) }],
        "key",
        OPTIONS,
        fetchFn,
      ),
    ).resolves.toEqual({ ok: false, code: "too-long" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test.each([
    [401, "api-key-rejected"],
    [429, "rate-limited"],
    [400, "api-error"],
  ])("maps HTTP %i to %s", async (status, code) => {
    const fetchFn = respond(status, { error: { message: "error" } });
    await expect(
      translateResponses("deepseek", [{ kind: "paragraph", text: "a" }], "key", OPTIONS, fetchFn),
    ).resolves.toEqual({ ok: false, code });
  });

  test("maps a failed request to network", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      translateResponses("openai", [{ kind: "paragraph", text: "a" }], "key", OPTIONS, fetchFn),
    ).resolves.toEqual({ ok: false, code: "network" });
  });
});

describe("parseResponse", () => {
  test("reads the output text of the message items", () => {
    expect(parseResponse(response('{"translations":["a"]}'), 1)).toEqual({ ok: true, translations: ["a"] });
  });

  test.each([
    ["a response cut short", response('{"translations":["a"]}', "incomplete")],
    ["a failed response", response('{"translations":["a"]}', "failed")],
    [
      "a refusal",
      { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] },
    ],
    ["a body that is not a response", { error: { message: "error" } }],
    ["text that is not the translations", response("not json")],
  ])("rejects %s", (_, body) => {
    expect(parseResponse(body, 1)).toEqual({ ok: false, code: "invalid-response" });
  });
});
