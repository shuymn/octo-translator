// AUTH-1: the deployed entry point, as the runtime calls it: the Access settings bound by vitest.config.ts, and the
// team's keys fetched through the runtime's `fetch`, which the test answers with keys made locally. Runs in the Workers
// runtime.
import { exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ACCESS_JWT_HEADER } from "./auth.ts";
import worker from "./index.ts";
import { TEST_CERTS_URL } from "./test-env.ts";
import { makeTestKeys, type TestKeys } from "./test-keys.ts";

let keys: TestKeys;
const fetched: string[] = [];

beforeAll(async () => {
  keys = await makeTestKeys();
  // Only the team's certs URL is answered; any other request fails the test.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    fetched.push(url);
    if (url !== TEST_CERTS_URL) throw new Error(`unexpected request to ${url}`);
    return Response.json(keys.jwks);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

function request(path: string, token?: string): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set(ACCESS_JWT_HEADER, token);
  return new Request(`https://worker.example${path}`, { headers });
}

async function answer(response: Response): Promise<{ status: number; body: unknown }> {
  return { status: response.status, body: await response.json() };
}

describe("AUTH-1: the entry point", () => {
  test("answers a ping with a token the team signed", async () => {
    expect(await answer(await exports.default.fetch(request("/v1/ping", await keys.sign())))).toEqual({
      status: 200,
      body: { ok: true },
    });
  });

  test("refuses a request without a token", async () => {
    expect(await answer(await exports.default.fetch(request("/v1/ping")))).toEqual({
      status: 401,
      body: { ok: false, code: "unauthenticated" },
    });
  });

  test("refuses a token the team did not sign", async () => {
    const token = await keys.sign({}, keys.impostorKey);
    expect(await answer(await exports.default.fetch(request("/v1/ping", token)))).toEqual({
      status: 403,
      body: { ok: false, code: "forbidden" },
    });
  });

  test("answers an unknown route with a valid token with 404", async () => {
    expect(await answer(await exports.default.fetch(request("/v1/unknown", await keys.sign())))).toEqual({
      status: 404,
      body: { ok: false, code: "not-found" },
    });
  });

  // The test configuration binds every provider key empty, so the route reaches D1 and stops before any provider.
  test("routes a translation to D1 and the Worker's keys", async () => {
    const headers = new Headers({ [ACCESS_JWT_HEADER]: await keys.sign() });
    const body = JSON.stringify({ key: "owner/repo#1", segments: [{ kind: "title", text: "Add cache cleanup" }] });
    const response = await exports.default.fetch(
      new Request("https://worker.example/v1/translate", { method: "POST", headers, body }),
    );
    expect(await answer(response)).toEqual({ status: 200, body: { ok: false, code: "no-api-key" } });
  });

  test("fetched only the team's certs URL", () => {
    expect(fetched.length).toBeGreaterThan(0);
    expect(new Set(fetched)).toEqual(new Set([TEST_CERTS_URL]));
  });

  // The same module, given an environment without the settings: it refuses before reading the token.
  test("refuses every request when the Access settings are missing", async () => {
    const response = await worker.fetch(request("/v1/ping", await keys.sign()), {});
    expect(await answer(response)).toEqual({ status: 500, body: { ok: false, code: "misconfigured" } });
  });
});
