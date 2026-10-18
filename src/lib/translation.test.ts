import { describe, expect, test } from "vitest";
import { errorCodeOfStatus, MAX_SOURCE_CHARACTERS, parseTranslations, sourceTooLong } from "./translation.ts";

describe("sourceTooLong", () => {
  test("RES-1: counts the text of every segment against the limit", () => {
    const half = "a".repeat(MAX_SOURCE_CHARACTERS / 2);
    expect(
      sourceTooLong([
        { kind: "title", text: half },
        { kind: "paragraph", text: half },
      ]),
    ).toBe(false);
    expect(
      sourceTooLong([
        { kind: "title", text: half },
        { kind: "paragraph", text: `${half}a` },
      ]),
    ).toBe(true);
  });
});

describe("errorCodeOfStatus", () => {
  test.each([
    [401, "api-key-rejected"],
    [403, "api-key-rejected"],
    [429, "rate-limited"],
    [400, "api-error"],
    [500, "api-error"],
  ])("maps HTTP %i to %s", (status, code) => {
    expect(errorCodeOfStatus(status)).toBe(code);
  });
});

describe("parseTranslations", () => {
  test("answers one translation per segment", () => {
    expect(parseTranslations('{"translations":["修正","本文"]}', 2)).toEqual({
      ok: true,
      translations: ["修正", "本文"],
    });
  });

  test.each([
    ["a count that does not match", '{"translations":["a","b"]}'],
    ["text that is not JSON", "translations: a"],
    ["JSON of another shape", '{"text":"a"}'],
  ])("rejects %s", (_, text) => {
    expect(parseTranslations(text, 1)).toEqual({ ok: false, code: "invalid-response" });
  });
});
