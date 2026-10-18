// RES-1, RES-2, RES-3, AUTH-1, KEY-2: `POST /v1/translate` through the handler, with the local D1 database the
// migrations made and a fake translation. Runs in the Workers runtime.
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { translateWith } from "../../src/lib/clients.ts";
import { ENDPOINTS } from "../../src/lib/responses.ts";
import type { ModelChoice } from "../../src/lib/providers.ts";
import { MAX_SOURCE_CHARACTERS, type SourceSegment, type TranslationResult } from "../../src/lib/translation.ts";
import { ACCESS_JWT_HEADER } from "./auth.ts";
import { createHandler } from "./handler.ts";
import { MAX_BODY_BYTES } from "./translate.ts";
import { makeTestKeys, type TestKeys } from "./test-keys.ts";

const DEEPSEEK_KEY = "test-deepseek-key";
const OPENAI_KEY = "test-openai-key";
const NOW = 1_700_000_000_000;

let keys: TestKeys;
let token: string;
beforeAll(async () => {
  keys = await makeTestKeys();
  token = await keys.sign();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SEGMENTS: SourceSegment[] = [
  { kind: "title", text: "Add cache cleanup" },
  { kind: "paragraph", text: "Deletes old entries." },
];

type Call = { choice: ModelChoice; segments: SourceSegment[]; apiKey: string };

/** A translation that records its calls and answers `result`, or one translation per segment. */
function fakeTranslate(result?: TranslationResult) {
  const calls: Call[] = [];
  const translate = async (choice: ModelChoice, segments: SourceSegment[], apiKey: string) => {
    calls.push({ choice, segments, apiKey });
    return result ?? { ok: true as const, translations: segments.map((segment) => `訳: ${segment.text}`) };
  };
  return { calls, translate };
}

/** The local D1 database, recording every statement prepared and every batch run on it. */
function recordingDb(failBatch = false) {
  const used: string[] = [];
  const db = {
    prepare: (sql: string) => {
      used.push(sql);
      return env.DB.prepare(sql);
    },
    batch: (statements: D1PreparedStatement[]) => {
      used.push("batch");
      return failBatch ? Promise.reject(new Error("D1_ERROR")) : env.DB.batch(statements);
    },
  };
  return { used, db };
}

function workerEnv(db: unknown, apiKeys: Record<string, string> = { DEEPSEEK_API_KEY: DEEPSEEK_KEY }) {
  return {
    ACCESS_TEAM_DOMAIN: env.ACCESS_TEAM_DOMAIN,
    ACCESS_AUD: env.ACCESS_AUD,
    DB: db,
    ...apiKeys,
  };
}

function post(body: string | ReadableStream | null, init: { token?: string; headers?: Record<string, string> } = {}) {
  const headers = new Headers(init.headers);
  if (init.token !== undefined) headers.set(ACCESS_JWT_HEADER, init.token);
  return new Request("https://worker.example/v1/translate", { method: "POST", headers, body });
}

function translateBody(key: string, segments: unknown = SEGMENTS, choice?: unknown): string {
  return JSON.stringify(choice === undefined ? { key, segments } : { key, segments, choice });
}

async function answer(response: Response): Promise<{ status: number; body: unknown }> {
  return { status: response.status, body: await response.json() };
}

async function rows(prKey: string) {
  const { results } = await env.DB.prepare(
    "SELECT segments_hash, choice_key, translations, requested_at, created_at FROM translations WHERE pr_key = ? ORDER BY choice_key",
  )
    .bind(prKey)
    .all();
  return results;
}

/** A clock that starts at `NOW` and moves a second on each reading. */
function ticking(): () => number {
  let time = NOW - 1000;
  return () => (time += 1000);
}

function handlerWith(translate: Parameters<typeof createHandler>[0]["translate"]) {
  return createHandler({ keys: () => keys.local, translate, now: ticking() });
}

describe("RES-2: stored translations", () => {
  test("a miss translates once with the default choice and the Worker's key, and stores the result", async () => {
    const fake = fakeTranslate();
    const response = await handlerWith(fake.translate)(
      post(translateBody("owner/repo#1"), { token }),
      workerEnv(env.DB),
    );
    expect(await answer(response)).toEqual({
      status: 200,
      body: { ok: true, translations: ["訳: Add cache cleanup", "訳: Deletes old entries."] },
    });
    expect(fake.calls).toEqual([
      {
        choice: { provider: "deepseek", model: "deepseek-flash", thinking: "none" },
        segments: SEGMENTS,
        apiKey: DEEPSEEK_KEY,
      },
    ]);
    expect(await rows("owner/repo#1")).toEqual([
      {
        segments_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        choice_key: "deepseek/deepseek-flash/none",
        translations: JSON.stringify(["訳: Add cache cleanup", "訳: Deletes old entries."]),
        // Read before the lookup, and again when stored.
        requested_at: NOW,
        created_at: NOW + 1000,
      },
    ]);
  });

  test("a hit answers the stored translation without calling the provider", async () => {
    const fake = fakeTranslate();
    const handle = handlerWith(fake.translate);
    const first = await answer(await handle(post(translateBody("owner/repo#2"), { token }), workerEnv(env.DB)));
    const second = await answer(await handle(post(translateBody("owner/repo#2"), { token }), workerEnv(env.DB)));
    expect(second).toEqual(first);
    expect(fake.calls).toHaveLength(1);
    expect(await rows("owner/repo#2")).toHaveLength(1);
  });

  test("another choice translates again with that provider's key, and is stored beside the first", async () => {
    const fake = fakeTranslate();
    const handle = handlerWith(fake.translate);
    const apiKeys = { DEEPSEEK_API_KEY: DEEPSEEK_KEY, OPENAI_API_KEY: OPENAI_KEY };
    const choice = { provider: "openai", model: "gpt-6-luna", thinking: "none" };
    await handle(post(translateBody("owner/repo#3"), { token }), workerEnv(env.DB, apiKeys));
    await handle(post(translateBody("owner/repo#3", SEGMENTS, choice), { token }), workerEnv(env.DB, apiKeys));
    expect(fake.calls.map((call) => [call.choice, call.apiKey])).toEqual([
      [{ provider: "deepseek", model: "deepseek-flash", thinking: "none" }, DEEPSEEK_KEY],
      [choice, OPENAI_KEY],
    ]);
    expect((await rows("owner/repo#3")).map((row) => row["choice_key"])).toEqual([
      "deepseek/deepseek-flash/none",
      "openai/gpt-6-luna/none",
    ]);
  });

  test("edited segments translate again and replace the older version for the same choice", async () => {
    const fake = fakeTranslate();
    const handle = handlerWith(fake.translate);
    const edited = [...SEGMENTS, { kind: "item", text: "Also logs it." }];
    await handle(post(translateBody("owner/repo#4"), { token }), workerEnv(env.DB));
    const before = await rows("owner/repo#4");
    await handle(post(translateBody("owner/repo#4", edited), { token }), workerEnv(env.DB));
    expect(fake.calls.map(({ segments }) => segments)).toEqual([SEGMENTS, edited]);
    const after = await rows("owner/repo#4");
    expect(after).toHaveLength(1);
    expect(after[0]?.["segments_hash"]).not.toBe(before[0]?.["segments_hash"]);
    expect(after[0]?.["translations"]).toBe(JSON.stringify(edited.map((segment) => `訳: ${segment.text}`)));
  });

  test("an older version that finishes after a newer one does not replace it", async () => {
    // Each request's translation waits until the test releases it.
    const pending = new Map<string, (result: TranslationResult) => void>();
    const translate = (_: ModelChoice, segments: SourceSegment[]) =>
      new Promise<TranslationResult>((resolve) => pending.set(segments.at(-1)?.text ?? "", resolve));
    const handle = handlerWith(translate);
    const versionA = [{ kind: "title", text: "A" }];
    const versionB = [{ kind: "title", text: "B" }];
    const requestA = handle(post(translateBody("owner/repo#14", versionA), { token }), workerEnv(env.DB));
    await vi.waitFor(() => expect(pending.has("A")).toBe(true));
    const requestB = handle(post(translateBody("owner/repo#14", versionB), { token }), workerEnv(env.DB));
    await vi.waitFor(() => expect(pending.has("B")).toBe(true));

    pending.get("B")?.({ ok: true, translations: ["訳 B"] });
    expect(await answer(await requestB)).toEqual({ status: 200, body: { ok: true, translations: ["訳 B"] } });
    pending.get("A")?.({ ok: true, translations: ["訳 A"] });
    // A's own request is still answered; it is only not stored over B.
    expect(await answer(await requestA)).toEqual({ status: 200, body: { ok: true, translations: ["訳 A"] } });

    const stored = await rows("owner/repo#14");
    expect(stored.map((row) => row["translations"])).toEqual([JSON.stringify(["訳 B"])]);
  });

  test("RES-3: text that looks like SQL is stored and read back as data", async () => {
    const fake = fakeTranslate();
    const handle = handlerWith(fake.translate);
    const segments = [{ kind: "paragraph", text: "x'); DROP TABLE translations; --" }];
    const first = await answer(
      await handle(post(translateBody("owner/repo#9", segments), { token }), workerEnv(env.DB)),
    );
    const second = await answer(
      await handle(post(translateBody("owner/repo#9", segments), { token }), workerEnv(env.DB)),
    );
    expect(second).toEqual(first);
    expect(first.body).toEqual({ ok: true, translations: ["訳: x'); DROP TABLE translations; --"] });
    expect(fake.calls).toHaveLength(1);
    expect(await rows("owner/repo#9")).toHaveLength(1);
  });

  test("a stored row that does not fit the segments is a miss", async () => {
    const fake = fakeTranslate();
    const handle = handlerWith(fake.translate);
    await handle(post(translateBody("owner/repo#5"), { token }), workerEnv(env.DB));
    await env.DB.prepare("UPDATE translations SET translations = ? WHERE pr_key = ?")
      .bind('["only one"]', "owner/repo#5")
      .run();
    const response = await handle(post(translateBody("owner/repo#5"), { token }), workerEnv(env.DB));
    expect(await answer(response)).toEqual({
      status: 200,
      body: { ok: true, translations: ["訳: Add cache cleanup", "訳: Deletes old entries."] },
    });
    expect(fake.calls).toHaveLength(2);
  });

  test("a provider error is answered and not stored", async () => {
    const fake = fakeTranslate({ ok: false, code: "rate-limited" });
    const { used, db } = recordingDb();
    const response = await handlerWith(fake.translate)(post(translateBody("owner/repo#6"), { token }), workerEnv(db));
    expect(await answer(response)).toEqual({ status: 200, body: { ok: false, code: "rate-limited" } });
    // Looked up, never written.
    expect(used).toEqual([expect.stringMatching(/^SELECT /)]);
    expect(await rows("owner/repo#6")).toEqual([]);
  });

  test("a provider without a key answers no-api-key without calling it or storing", async () => {
    const fake = fakeTranslate();
    const response = await handlerWith(fake.translate)(
      post(translateBody("owner/repo#7"), { token }),
      workerEnv(env.DB, { DEEPSEEK_API_KEY: "" }),
    );
    expect(await answer(response)).toEqual({ status: 200, body: { ok: false, code: "no-api-key" } });
    expect(fake.calls).toEqual([]);
    expect(await rows("owner/repo#7")).toEqual([]);
  });

  test("a failed store still answers the translation, and logs no key or statement", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeTranslate();
    const { db } = recordingDb(true);
    const response = await handlerWith(fake.translate)(post(translateBody("owner/repo#8"), { token }), workerEnv(db));
    expect(await answer(response)).toEqual({
      status: 200,
      body: { ok: true, translations: ["訳: Add cache cleanup", "訳: Deletes old entries."] },
    });
    expect(errors.mock.calls).toEqual([["translations save failed: Error"]]);
  });
});

/** What a request was answered, which translations it asked for and which statements it used. */
async function outcome(request: Request) {
  const fake = fakeTranslate();
  const { used, db } = recordingDb();
  const response = await handlerWith(fake.translate)(request, workerEnv(db));
  return { answer: await answer(response), calls: fake.calls, used };
}

/** A refusal with `code`, before any translation or statement. */
function refused(status: number, code: string) {
  return { answer: { status, body: { ok: false, code } }, calls: [], used: [] };
}

describe("RES-1, RES-3: input is bounded and checked before any provider call or database use", () => {
  test("a declared length over the limit is refused before reading", async () => {
    expect(
      await outcome(
        post(translateBody("owner/repo#10"), { token, headers: { "Content-Length": String(MAX_BODY_BYTES + 1) } }),
      ),
    ).toEqual(refused(413, "too-large"));
  });

  test.each<[string, Record<string, string>]>([
    ["without a declared length", {}],
    ["with a declared length that is too small", { "Content-Length": "10" }],
  ])("a streamed body over the limit, %s, is cut off at the limit", async (_, headers) => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let sent = 0;
    // Four times the limit, then the end: without the limit it would be read whole, and fail fast as a bad request.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 4 * MAX_BODY_BYTES) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const request = post(stream, { token, headers });
    // The runtime keeps the declared length, so the reader, not the header, has to stop it.
    expect(request.headers.get("Content-Length")).toBe(headers["Content-Length"] ?? null);
    expect(await outcome(request)).toEqual(refused(413, "too-large"));
    expect(sent).toBeLessThanOrEqual(MAX_BODY_BYTES + 2 * chunk.byteLength);
  });

  test.each<[string, string]>([
    ["not JSON", "{"],
    ["no body at all", ""],
    ["a JSON value that is not an object", "[]"],
    ["no key", JSON.stringify({ segments: SEGMENTS })],
    ["a key that is not a pull request", translateBody("owner/repo")],
    ["a key in upper case", translateBody("Owner/Repo#1")],
    ["no segments", translateBody("owner/repo#11", [])],
    ["a segment of an unknown kind", translateBody("owner/repo#11", [{ kind: "comment", text: "x" }])],
    ["a segment without text", translateBody("owner/repo#11", [{ kind: "title" }])],
    ["an unknown field", JSON.stringify({ key: "owner/repo#11", segments: SEGMENTS, extra: 1 })],
  ])("%s is a bad request", async (_, body) => {
    expect(await outcome(post(body, { token }))).toEqual(refused(400, "bad-request"));
  });

  test("a body that is not UTF-8 is a bad request", async () => {
    const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    expect(await outcome(post(new Blob([bytes]).stream(), { token }))).toEqual(refused(400, "bad-request"));
  });

  test.each<[string, unknown]>([
    ["an unknown model", { provider: "deepseek", model: "deepseek-pro", thinking: "none" }],
    ["a level the model does not take", { provider: "openai", model: "gpt-6.1-sol", thinking: "none" }],
    ["an unknown provider", { provider: "anthropic", model: "x", thinking: "none" }],
    ["not a choice", "deepseek"],
  ])("%s is refused as an unsupported choice", async (_, choice) => {
    expect(await outcome(post(translateBody("owner/repo#12", SEGMENTS, choice), { token }))).toEqual(
      refused(400, "unsupported-choice"),
    );
  });

  test("too much source text answers too-long", async () => {
    const fake = fakeTranslate();
    const { used, db } = recordingDb();
    const segments = [{ kind: "paragraph", text: "a".repeat(MAX_SOURCE_CHARACTERS + 1) }];
    const response = await handlerWith(fake.translate)(
      post(translateBody("owner/repo#13", segments), { token }),
      workerEnv(db),
    );
    expect(await answer(response)).toEqual({ status: 200, body: { ok: false, code: "too-long" } });
    expect(fake.calls).toEqual([]);
    expect(used).toEqual([]);
  });

  test("the route takes only POST", async () => {
    const response = await handlerWith(fakeTranslate().translate)(
      new Request("https://worker.example/v1/translate", { headers: { [ACCESS_JWT_HEADER]: token } }),
      workerEnv(env.DB),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });
});

describe("AUTH-1, RES-3: an unauthenticated request never reaches the provider or the database", () => {
  test.each<[string, () => Promise<string | undefined>]>([
    ["no token", () => Promise.resolve(undefined)],
    ["another key's token", () => keys.sign({}, keys.impostorKey)],
    ["an expired token", () => keys.sign({ iat: keys.now - 600, exp: keys.now - 60 })],
  ])("%s", async (_, makeToken) => {
    const fake = fakeTranslate();
    const { used, db } = recordingDb();
    const signed = await makeToken();
    const request = post(translateBody("owner/repo#20"), signed === undefined ? {} : { token: signed });
    const response = await handlerWith(fake.translate)(request, workerEnv(db));
    expect(response.status).toBe(signed === undefined ? 401 : 403);
    expect(fake.calls).toEqual([]);
    expect(used).toEqual([]);
  });
});

describe("KEY-2: the Worker's key travels only in the header to its provider", () => {
  test("the request to DeepSeek carries the key in its header, and the answer does not", async () => {
    const requests: Request[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      const text = JSON.stringify({ translations: ["訳1", "訳2"] });
      return Response.json({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text }] }],
      });
    };
    const handle = createHandler({
      keys: () => keys.local,
      translate: (choice, segments, apiKey) => translateWith(choice, segments, apiKey, fakeFetch),
      now: () => NOW,
    });
    const response = await handle(post(translateBody("owner/repo#30"), { token }), workerEnv(env.DB));
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: true, translations: ["訳1", "訳2"] });
    expect(text).not.toContain(DEEPSEEK_KEY);
    expect(requests).toHaveLength(1);
    const [sent] = requests;
    expect(sent?.url).toBe(ENDPOINTS.deepseek);
    expect(sent?.url).not.toContain(DEEPSEEK_KEY);
    expect(sent?.headers.get("authorization")).toBe(`Bearer ${DEEPSEEK_KEY}`);
    expect(await sent?.text()).not.toContain(DEEPSEEK_KEY);
  });
});
