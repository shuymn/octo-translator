// AUTH-1: every request is authenticated before routing, and a refused request gets a fixed answer. Runs in the
// Workers runtime.
import type { JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, test } from "vitest";
import { ACCESS_JWT_HEADER } from "./auth.ts";
import { createHandler } from "./handler.ts";
import { TEST_ENV } from "./test-env.ts";
import { makeTestKeys, type TestKeys } from "./test-keys.ts";

let keys: TestKeys;
beforeAll(async () => {
  keys = await makeTestKeys();
});

function request(path: string, init: { method?: string; token?: string } = {}): Request {
  const headers = new Headers();
  if (init.token !== undefined) headers.set(ACCESS_JWT_HEADER, init.token);
  return new Request(`https://worker.example${path}`, { method: init.method ?? "GET", headers });
}

async function answer(response: Response): Promise<{ status: number; body: unknown }> {
  return { status: response.status, body: await response.json() };
}

describe("AUTH-1: the handler", () => {
  test("answers an authenticated ping", async () => {
    const handle = createHandler({ keys: () => keys.local });
    const response = await handle(request("/v1/ping", { token: await keys.sign() }), TEST_ENV);
    expect(await answer(response)).toEqual({ status: 200, body: { ok: true } });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("refuses a request without a token before routing, with a fixed answer", async () => {
    const handle = createHandler({ keys: () => keys.local });
    for (const path of ["/v1/ping", "/unknown", "/"]) {
      expect(await answer(await handle(request(path), TEST_ENV))).toEqual({
        status: 401,
        body: { ok: false, code: "unauthenticated" },
      });
    }
    expect(await answer(await handle(request("/v1/ping", { method: "POST" }), TEST_ENV))).toEqual({
      status: 401,
      body: { ok: false, code: "unauthenticated" },
    });
  });

  test("refuses an invalid token with a fixed answer that does not say why", async () => {
    const handle = createHandler({ keys: () => keys.local });
    const tokens = [
      await keys.sign({ aud: "another-application" }),
      await keys.sign({ iss: "https://another-team.cloudflareaccess.com" }),
      await keys.sign({ iat: keys.now - 600, exp: keys.now - 60 }),
      await keys.sign({}, keys.impostorKey),
    ];
    for (const token of tokens) {
      for (const path of ["/v1/ping", "/unknown"]) {
        const response = await handle(request(path, { token }), TEST_ENV);
        expect(await answer(response)).toEqual({ status: 403, body: { ok: false, code: "forbidden" } });
      }
    }
  });

  test("verifies with the keys of the configured team", async () => {
    const asked: string[] = [];
    const handle = createHandler({
      keys: (certsUrl) => {
        asked.push(certsUrl.href);
        return keys.local;
      },
    });
    await handle(request("/v1/ping", { token: await keys.sign() }), TEST_ENV);
    expect(asked).toEqual(["https://example-team.cloudflareaccess.com/cdn-cgi/access/certs"]);
  });

  test.each<[string, Record<string, unknown>]>([
    ["no settings", {}],
    ["no audience", { ACCESS_TEAM_DOMAIN: TEST_ENV.ACCESS_TEAM_DOMAIN }],
    ["an empty audience", { ...TEST_ENV, ACCESS_AUD: "" }],
    ["a team domain over http", { ...TEST_ENV, ACCESS_TEAM_DOMAIN: "http://example-team.cloudflareaccess.com" }],
    ["a team domain on another host", { ...TEST_ENV, ACCESS_TEAM_DOMAIN: "https://example-team.example.com" }],
    ["a team domain with a path", { ...TEST_ENV, ACCESS_TEAM_DOMAIN: `${TEST_ENV.ACCESS_TEAM_DOMAIN}/x` }],
    ["the placeholder", { ...TEST_ENV, ACCESS_TEAM_DOMAIN: "https://<team>.cloudflareaccess.com" }],
  ])("refuses every request with %s, without looking at the token", async (_, env) => {
    let asked = false;
    const local: JWTVerifyGetKey = (header, token) => {
      asked = true;
      return keys.local(header, token);
    };
    const handle = createHandler({ keys: () => local });
    const response = await handle(request("/v1/ping", { token: await keys.sign() }), env);
    expect(await answer(response)).toEqual({ status: 500, body: { ok: false, code: "misconfigured" } });
    expect(asked).toBe(false);
  });
});

describe("routing", () => {
  test("answers an unknown route with 404 and another method with 405", async () => {
    const handle = createHandler({ keys: () => keys.local });
    const token = await keys.sign();
    expect(await answer(await handle(request("/v1/unknown", { token }), TEST_ENV))).toEqual({
      status: 404,
      body: { ok: false, code: "not-found" },
    });
    expect(await answer(await handle(request("/v1/ping/", { token }), TEST_ENV))).toEqual({
      status: 404,
      body: { ok: false, code: "not-found" },
    });
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      const response = await handle(request("/v1/ping", { method, token }), TEST_ENV);
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET");
    }
  });
});
