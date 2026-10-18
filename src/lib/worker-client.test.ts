import { describe, expect, test, vi } from "vitest";
import { DEFAULT_CHOICE } from "./providers.ts";
import type { SourceSegment } from "./translation.ts";
import {
  originPattern,
  parseWorkerUrl,
  resolveWorker,
  translateWithWorker,
  type WorkerAccess,
  type WorkerRequest,
  type WorkerSettingDeps,
} from "./worker-client.ts";

const ACCESS: WorkerAccess = {
  origin: "https://translator.example.com",
  clientId: "client-id.access",
  clientSecret: "client-secret-value",
};
const SEGMENTS: SourceSegment[] = [
  { kind: "title", text: "Add cache cleanup" },
  { kind: "paragraph", text: "Body" },
];
const REQUEST: WorkerRequest = { key: "o/r#1", segments: SEGMENTS, choice: DEFAULT_CHOICE };

function fetchAnswering(response: () => Response | Promise<Response>) {
  return vi.fn<typeof fetch>(async () => response());
}

function failingBody(error: Error): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":true,'));
      controller.error(error);
    },
  });
}

function requestOf(fetchFn: ReturnType<typeof fetchAnswering>) {
  const [url, init] = fetchFn.mock.calls[0] ?? [];
  return {
    url: typeof url === "string" ? url : "",
    init: init ?? {},
    body: typeof init?.body === "string" ? init.body : "",
    headers: new Headers(init?.headers),
  };
}

describe("KEY-4: translateWithWorker", () => {
  test("sends the token in the Access headers to the configured origin only, and no secret in the body", async () => {
    const fetchFn = fetchAnswering(() =>
      Response.json({ ok: true, translations: ["キャッシュの削除処理を追加", "本文"] }),
    );
    const result = await translateWithWorker(ACCESS, REQUEST, fetchFn);
    expect(result).toEqual({ ok: true, result: { ok: true, translations: ["キャッシュの削除処理を追加", "本文"] } });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const { url, init, body, headers } = requestOf(fetchFn);
    expect(url).toBe("https://translator.example.com/v1/translate");
    expect(init.method).toBe("POST");
    expect(headers.get("CF-Access-Client-Id")).toBe(ACCESS.clientId);
    expect(headers.get("CF-Access-Client-Secret")).toBe(ACCESS.clientSecret);
    expect(headers.get("authorization")).toBeNull();
    // A redirect is not followed, so the headers never reach another origin.
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(body)).toEqual({ key: "o/r#1", segments: SEGMENTS, choice: DEFAULT_CHOICE });
    expect(body).not.toContain(ACCESS.clientId);
    expect(body).not.toContain(ACCESS.clientSecret);
    expect(url).not.toContain(ACCESS.clientSecret);
  });

  test("answers a translation's failure as the Worker sent it", async () => {
    const fetchFn = fetchAnswering(() => Response.json({ ok: false, code: "rate-limited" }));
    await expect(translateWithWorker(ACCESS, REQUEST, fetchFn)).resolves.toEqual({
      ok: true,
      result: { ok: false, code: "rate-limited" },
    });
  });

  test.each([
    [401, "rejected"],
    [403, "rejected"],
    [400, "rejected"],
    [404, "rejected"],
    [413, "rejected"],
    [302, "rejected"],
    [429, "rejected"],
    [500, "server-error"],
    [502, "server-error"],
    [503, "server-error"],
    [204, "invalid-response"],
  ] as const)("maps status %i to %s", async (status, code) => {
    const fetchFn = fetchAnswering(() =>
      status === 204 || status === 302
        ? new Response(null, { status, headers: status === 302 ? { location: "https://elsewhere.example/" } : {} })
        : Response.json({ ok: false, code: "forbidden" }, { status }),
    );
    await expect(translateWithWorker(ACCESS, REQUEST, fetchFn)).resolves.toEqual({ ok: false, code });
  });

  test("treats a redirect the runtime did not follow (opaqueredirect) as a refusal", async () => {
    const opaque = new Response(null, { status: 200 });
    Object.defineProperty(opaque, "type", { value: "opaqueredirect" });
    Object.defineProperty(opaque, "status", { value: 0 });
    await expect(
      translateWithWorker(
        ACCESS,
        REQUEST,
        fetchAnswering(() => opaque),
      ),
    ).resolves.toEqual({
      ok: false,
      code: "rejected",
    });
  });

  test("answers unreachable when the body is cut off or times out after the status", async () => {
    for (const error of [new TypeError("network error"), new DOMException("timed out", "TimeoutError")]) {
      const fetchFn = fetchAnswering(() => new Response(failingBody(error), { status: 200 }));
      await expect(translateWithWorker(ACCESS, REQUEST, fetchFn)).resolves.toEqual({ ok: false, code: "unreachable" });
    }
  });

  test("answers unreachable when the request fails or times out", async () => {
    const network = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(translateWithWorker(ACCESS, REQUEST, network)).resolves.toEqual({ ok: false, code: "unreachable" });
    const timeout = vi.fn<typeof fetch>(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    await expect(translateWithWorker(ACCESS, REQUEST, timeout)).resolves.toEqual({ ok: false, code: "unreachable" });
    expect(requestOf(timeout).init.signal).toBeInstanceOf(AbortSignal);
  });

  test.each([
    ["not JSON", () => new Response("<html>login</html>", { status: 200 })],
    ["another shape", () => Response.json({ translations: ["a", "b"] })],
    ["an unknown code", () => Response.json({ ok: false, code: "unauthenticated" })],
    ["too few translations", () => Response.json({ ok: true, translations: ["a"] })],
  ])("refuses a 200 body that is %s", async (_, response) => {
    await expect(translateWithWorker(ACCESS, REQUEST, fetchAnswering(response))).resolves.toEqual({
      ok: false,
      code: "invalid-response",
    });
  });
});

describe("parseWorkerUrl", () => {
  test.each([
    ["https://translator.example.com", "https://translator.example.com"],
    ["https://translator.example.com/", "https://translator.example.com"],
    ["  https://Translator.Example.com  ", "https://translator.example.com"],
    ["https://translator.example.com:443/", "https://translator.example.com"],
  ])("accepts %s as %s", (input, origin) => {
    expect(parseWorkerUrl(input)).toEqual({ ok: true, origin });
  });

  test.each([
    "",
    "translator.example.com",
    "http://translator.example.com",
    "https://translator.example.com/v1",
    "https://translator.example.com/v1/translate",
    "https://translator.example.com/?a=1",
    "https://translator.example.com/?",
    "https://translator.example.com/#x",
    "https://translator.example.com#",
    "https://user:pass@translator.example.com",
    "https://translator.example.com:8443",
    "javascript:alert(1)",
  ])("refuses %s", (input) => {
    expect(parseWorkerUrl(input)).toEqual({ ok: false });
  });

  test("the permission pattern covers that origin only", () => {
    expect(originPattern("https://translator.example.com")).toBe("https://translator.example.com/*");
  });
});

const STORED = { origin: ACCESS.origin, clientId: ACCESS.clientId, clientSecret: ACCESS.clientSecret };

describe("resolveWorker", () => {
  test("is on with a valid origin, both halves of the token and the origin's permission", async () => {
    const hasPermission = vi.fn<WorkerSettingDeps["hasPermission"]>(async () => true);
    await expect(resolveWorker({ getAccess: async () => STORED, hasPermission })).resolves.toEqual({
      state: "on",
      access: ACCESS,
    });
    expect(hasPermission).toHaveBeenCalledWith(["https://translator.example.com/*"]);
  });

  test("KEY-4: pairs an origin with its own token while the configuration changes between reads", async () => {
    // The owner moves from Worker A to Worker B while the background reads: each read sees one whole write.
    const writes = [
      { origin: "https://a.example.com", clientId: "a-id", clientSecret: "a-secret" },
      { origin: "https://b.example.com", clientId: "b-id", clientSecret: "b-secret" },
    ];
    const getAccess = vi.fn<WorkerSettingDeps["getAccess"]>(async () => writes.shift());
    const hasPermission = vi.fn<WorkerSettingDeps["hasPermission"]>(async () => true);
    const first = await resolveWorker({ getAccess, hasPermission });
    const second = await resolveWorker({ getAccess, hasPermission });
    expect(first).toEqual({
      state: "on",
      access: { origin: "https://a.example.com", clientId: "a-id", clientSecret: "a-secret" },
    });
    expect(second).toEqual({
      state: "on",
      access: { origin: "https://b.example.com", clientId: "b-id", clientSecret: "b-secret" },
    });
    // One read per resolution: the origin and the token never come from different writes.
    expect(getAccess).toHaveBeenCalledTimes(2);
  });

  test.each([null, undefined])("is off with %s stored, and asks for no permission", async (stored) => {
    const hasPermission = vi.fn<WorkerSettingDeps["hasPermission"]>(async () => true);
    await expect(resolveWorker({ getAccess: async () => stored, hasPermission })).resolves.toEqual({ state: "off" });
    expect(hasPermission).not.toHaveBeenCalled();
  });

  test.each([
    ["a value of another shape", "https://translator.example.com", true],
    ["an origin that does not parse", { ...STORED, origin: "http://translator.example.com" }, true],
    ["no client id", { ...STORED, clientId: "" }, true],
    ["no client secret", { ...STORED, clientSecret: "" }, true],
    ["the permission revoked", STORED, false],
  ] as const)("is invalid with %s", async (_, stored, permitted) => {
    await expect(
      resolveWorker({ getAccess: async () => stored, hasPermission: async () => permitted }),
    ).resolves.toEqual({ state: "invalid" });
  });
});
