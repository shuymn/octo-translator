import { describe, expect, test, vi } from "vitest";
import { MAX_CACHE_BYTES, store, type Cache } from "./cache.ts";
import type { SourceSegment, TranslationResult } from "./gemini.ts";
import { createTranslateService, type TranslateDeps } from "./translate-service.ts";

const TEXT: SourceSegment[] = [{ kind: "paragraph", text: "text" }];

function setup(result: TranslationResult, overrides: Partial<TranslateDeps> = {}) {
  let cache: Cache = {};
  const translate = vi.fn<TranslateDeps["translate"]>(async () => result);
  const service = createTranslateService({
    getApiKey: async () => "key",
    getCache: async () => cache,
    setCache: async (next) => {
      cache = next;
    },
    translate,
    now: () => 1,
    ...overrides,
  });
  return { service, translate, cache: () => cache };
}

describe("createTranslateService", () => {
  test("translates once per pull request until its text changes", async () => {
    const { service, translate } = setup({ ok: true, translations: ["訳"] });
    await service("o/r#1", TEXT);
    await expect(service("o/r#1", TEXT)).resolves.toEqual({ ok: true, translations: ["訳"] });
    expect(translate).toHaveBeenCalledTimes(1);

    await service("o/r#1", [{ kind: "paragraph", text: "edited" }]);
    expect(translate).toHaveBeenCalledTimes(2);
  });

  test("shares one request between callers asking for the same text at once", async () => {
    const { service, translate } = setup({ ok: true, translations: ["訳"] });
    const results = await Promise.all([service("o/r#1", TEXT), service("o/r#1", TEXT)]);
    expect(results).toEqual([
      { ok: true, translations: ["訳"] },
      { ok: true, translations: ["訳"] },
    ]);
    expect(translate).toHaveBeenCalledTimes(1);
  });

  test("does not cache a failure", async () => {
    const { service, translate, cache } = setup({ ok: false, code: "rate-limited" });
    await service("o/r#1", TEXT);
    await service("o/r#1", TEXT);
    expect(translate).toHaveBeenCalledTimes(2);
    expect(cache()).toEqual({});
  });

  test("answers the translation when the cache cannot be written", async () => {
    const { service } = setup(
      { ok: true, translations: ["訳"] },
      {
        setCache: async () => {
          throw new Error("QUOTA_BYTES quota exceeded");
        },
      },
    );
    await expect(service("o/r#1", TEXT)).resolves.toEqual({ ok: true, translations: ["訳"] });
  });
});

test("store keeps the newest entries that fit in the byte budget", () => {
  const translations = ["あ".repeat(100_000)];
  let cache: Cache = {};
  for (let index = 0; index < 20; index++) {
    cache = store(cache, `o/r#${index}`, { hash: "h", translations, savedAt: index });
  }
  expect(new TextEncoder().encode(JSON.stringify(cache)).length).toBeLessThanOrEqual(MAX_CACHE_BYTES);
  expect(cache["o/r#0"]).toBeUndefined();
  expect(cache["o/r#19"]).toBeDefined();
});
