import { describe, expect, test, vi } from "vitest";
import { MAX_CACHE_BYTES, store, type Cache } from "./cache.ts";
import { DEFAULT_CHOICE, type ModelChoice } from "./providers.ts";
import type { SourceSegment, TranslationResult } from "./translation.ts";
import { createTranslateService, type TranslateDeps } from "./translate-service.ts";
import { translateWithWorker as httpClient, type WorkerAccess, type WorkerResult } from "./worker-client.ts";

const TEXT: SourceSegment[] = [{ kind: "paragraph", text: "text" }];

function setup(result: TranslationResult, overrides: Partial<TranslateDeps> = {}) {
  let cache: Cache = {};
  const translate = vi.fn<TranslateDeps["translate"]>(async () => result);
  const service = createTranslateService({
    getChoice: async () => DEFAULT_CHOICE,
    getApiKey: async (provider) => `${provider}-key`,
    getCache: async () => cache,
    setCache: async (next) => {
      cache = next;
    },
    translate,
    now: () => 1,
    getWorker: async () => ({ state: "off" }),
    translateWithWorker: async () => {
      throw new Error("no Worker is configured");
    },
    ...overrides,
  });
  return { service, translate, cache: () => cache };
}

describe("RES-2: createTranslateService", () => {
  test("translates once per pull request until its text changes", async () => {
    const { service, translate } = setup({ ok: true, translations: ["訳"] });
    await service("o/r#1", TEXT);
    await expect(service("o/r#1", TEXT)).resolves.toEqual({ ok: true, translations: ["訳"] });
    expect(translate).toHaveBeenCalledTimes(1);

    await service("o/r#1", [{ kind: "paragraph", text: "edited" }]);
    expect(translate).toHaveBeenCalledTimes(2);
  });

  test("translates again with another provider, model or thinking level", async () => {
    let choice: ModelChoice = DEFAULT_CHOICE;
    const { service, translate } = setup({ ok: true, translations: ["訳"] }, { getChoice: async () => choice });
    await service("o/r#1", TEXT);
    choice = { provider: "gemini", model: "gemini-3.8-flash", thinking: "high" };
    await service("o/r#1", TEXT);
    choice = { provider: "gemini", model: "gemini-3.8-flash", thinking: "low" };
    await service("o/r#1", TEXT);
    await service("o/r#1", TEXT);
    expect(translate.mock.calls.map(([, used, apiKey]) => [used.thinking, apiKey])).toEqual([
      ["none", "deepseek-key"],
      ["high", "gemini-key"],
      ["low", "gemini-key"],
    ]);
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

test("RES-2: store keeps the newest entries that fit in the byte budget", () => {
  const translations = ["あ".repeat(100_000)];
  let cache: Cache = {};
  for (let index = 0; index < 20; index++) {
    cache = store(cache, `o/r#${index}`, { hash: "h", model: "m", translations, savedAt: index });
  }
  expect(new TextEncoder().encode(JSON.stringify(cache)).length).toBeLessThanOrEqual(MAX_CACHE_BYTES);
  expect(cache["o/r#0"]).toBeUndefined();
  expect(cache["o/r#19"]).toBeDefined();
});

const ACCESS: WorkerAccess = { origin: "https://translator.example.com", clientId: "id", clientSecret: "secret" };

function setupWorker(remote: WorkerResult | (() => Promise<WorkerResult>), localKey = "deepseek-key") {
  const getApiKey = vi.fn<TranslateDeps["getApiKey"]>(async () => localKey);
  const translateWithWorker = vi.fn<TranslateDeps["translateWithWorker"]>(
    typeof remote === "function" ? remote : async () => remote,
  );
  const local = setup(
    { ok: true, translations: ["ローカルの訳"] },
    { getWorker: async () => ({ state: "on", access: ACCESS }), getApiKey, translateWithWorker },
  );
  return { ...local, getApiKey, translateWithWorker };
}

describe("the Worker, with local fallback", () => {
  test("KEY-4: translates through the Worker without reading the provider key, and caches the answer", async () => {
    const { service, translate, translateWithWorker, getApiKey } = setupWorker({
      ok: true,
      result: { ok: true, translations: ["Worker の訳"] },
    });
    await expect(service("o/r#1", TEXT)).resolves.toEqual({ ok: true, translations: ["Worker の訳"] });
    expect(translateWithWorker).toHaveBeenCalledWith(ACCESS, { key: "o/r#1", segments: TEXT, choice: DEFAULT_CHOICE });
    expect(translate).not.toHaveBeenCalled();
    expect(getApiKey).not.toHaveBeenCalled();

    // RES-2: the local cache answers next time, before the Worker is asked.
    await expect(service("o/r#1", TEXT)).resolves.toEqual({ ok: true, translations: ["Worker の訳"] });
    expect(translateWithWorker).toHaveBeenCalledTimes(1);
  });

  test("answers the Worker's translation failure as it is, without falling back", async () => {
    const { service, translate } = setupWorker({ ok: true, result: { ok: false, code: "no-api-key" } });
    await expect(service("o/r#1", TEXT)).resolves.toEqual({ ok: false, code: "no-api-key" });
    expect(translate).not.toHaveBeenCalled();
  });

  test.each(["server-error", "unreachable"] as const)(
    "translates locally with the provider key when the Worker answers %s",
    async (code) => {
      const { service, translate, cache } = setupWorker({ ok: false, code });
      await expect(service("o/r#1", TEXT)).resolves.toEqual({ ok: true, translations: ["ローカルの訳"] });
      expect(translate).toHaveBeenCalledWith(TEXT, DEFAULT_CHOICE, "deepseek-key");
      expect(cache()["o/r#1"]?.translations).toEqual(["ローカルの訳"]);
    },
  );

  test.each([
    ["rejected", "worker-rejected"],
    ["invalid-response", "invalid-response"],
  ] as const)("does not fall back when the Worker answers %s, and answers %s", async (failure, code) => {
    const { service, translate, getApiKey, cache } = setupWorker({ ok: false, code: failure });
    await expect(service("o/r#1", TEXT)).resolves.toEqual({ ok: false, code });
    expect(translate).not.toHaveBeenCalled();
    expect(getApiKey).not.toHaveBeenCalled();
    expect(cache()).toEqual({});
  });

  test("answers the Worker's failure when it cannot be reached and there is no local key", async () => {
    const { service, translate } = setupWorker({ ok: false, code: "unreachable" }, "");
    await expect(service("o/r#1", TEXT)).resolves.toEqual({ ok: false, code: "worker-unreachable" });
    expect(translate).not.toHaveBeenCalled();
  });

  test("answers worker-rejected for an unusable Worker setting, without any request", async () => {
    const translateWithWorker = vi.fn<TranslateDeps["translateWithWorker"]>();
    const { service, translate } = setup(
      { ok: true, translations: ["訳"] },
      { getWorker: async () => ({ state: "invalid" }), translateWithWorker },
    );
    await expect(service("o/r#1", TEXT)).resolves.toEqual({ ok: false, code: "worker-rejected" });
    expect(translateWithWorker).not.toHaveBeenCalled();
    expect(translate).not.toHaveBeenCalled();
  });

  test("without a Worker, translates locally only", async () => {
    const translateWithWorker = vi.fn<TranslateDeps["translateWithWorker"]>();
    const { service, translate } = setup({ ok: true, translations: ["訳"] }, { translateWithWorker });
    await expect(service("o/r#1", TEXT)).resolves.toEqual({ ok: true, translations: ["訳"] });
    expect(translate).toHaveBeenCalledWith(TEXT, DEFAULT_CHOICE, "deepseek-key");
    expect(translateWithWorker).not.toHaveBeenCalled();
  });

  test("RES-2: two tabs asking while the Worker is slow share one Worker request", async () => {
    let answer: ((result: WorkerResult) => void) | undefined;
    const { service, translateWithWorker } = setupWorker(
      () =>
        new Promise<WorkerResult>((resolve) => {
          answer = resolve;
        }),
    );
    const first = service("o/r#1", TEXT);
    const second = service("o/r#1", TEXT);
    await vi.waitFor(() => expect(translateWithWorker).toHaveBeenCalledTimes(1));
    answer?.({ ok: true, result: { ok: true, translations: ["Worker の訳"] } });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, translations: ["Worker の訳"] },
      { ok: true, translations: ["Worker の訳"] },
    ]);
    expect(translateWithWorker).toHaveBeenCalledTimes(1);
  });
});

function setupHttp(response: () => Response) {
  const fetchFn = vi.fn<typeof fetch>(async () => response());
  return setup(
    { ok: true, translations: ["ローカルの訳"] },
    {
      getWorker: async () => ({ state: "on", access: ACCESS }),
      translateWithWorker: (access, request) => httpClient(access, request, fetchFn),
    },
  );
}

function failingBody(error: Error): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":true,'));
      controller.error(error);
    },
  });
}

// The real client on a fake `fetch`, so the whole path from an HTTP answer to the fallback runs.
describe("the Worker's HTTP answers, through the client", () => {
  test.each([
    ["the connection is lost", new TypeError("network error")],
    ["the timeout is reached", new DOMException("The operation timed out.", "TimeoutError")],
  ])("falls back locally when %s while the 200 body is read", async (_, error) => {
    const { service, translate } = setupHttp(() => new Response(failingBody(error), { status: 200 }));
    await expect(service("o/r#1", TEXT)).resolves.toEqual({ ok: true, translations: ["ローカルの訳"] });
    expect(translate).toHaveBeenCalledTimes(1);
  });

  test("does not fall back for a complete 200 body that is not JSON", async () => {
    const { service, translate } = setupHttp(() => new Response('{"ok":true,', { status: 200 }));
    await expect(service("o/r#1", TEXT)).resolves.toEqual({ ok: false, code: "invalid-response" });
    expect(translate).not.toHaveBeenCalled();
  });

  test.each([401, 403, 429])("KEY-4: answers worker-rejected for HTTP %i without a local call", async (status) => {
    const { service, translate } = setupHttp(() => Response.json({ ok: false, code: "forbidden" }, { status }));
    await expect(service("o/r#1", TEXT)).resolves.toEqual({ ok: false, code: "worker-rejected" });
    expect(translate).not.toHaveBeenCalled();
  });
});
