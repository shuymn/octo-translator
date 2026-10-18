// AUTH-1: the Access token is verified (signature, issuer, audience, expiry) with the team's keys, and anything else is
// refused. Runs in the Workers runtime.
import { UnsecuredJWT } from "jose";
import { beforeAll, describe, expect, test } from "vitest";
import { ACCESS_JWT_HEADER, remoteKeys, verifyAccess } from "./auth.ts";
import { makeTestKeys, testAccess, type TestKeys } from "./test-keys.ts";

let keys: TestKeys;
beforeAll(async () => {
  keys = await makeTestKeys();
});

function request(token?: string): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set(ACCESS_JWT_HEADER, token);
  return new Request("https://worker.example/v1/ping", { headers });
}

describe("AUTH-1: verifyAccess", () => {
  test("accepts a token signed by the team for this application", async () => {
    expect(await verifyAccess(request(await keys.sign()), testAccess(), keys.local)).toEqual({ ok: true });
  });

  test("refuses a request without the header, or with an empty one, as unauthenticated", async () => {
    expect(await verifyAccess(request(), testAccess(), keys.local)).toEqual({ ok: false, code: "unauthenticated" });
    expect(await verifyAccess(request(""), testAccess(), keys.local)).toEqual({ ok: false, code: "unauthenticated" });
  });

  test.each<[string, () => Promise<string>]>([
    ["another application's audience", () => keys.sign({ aud: "another-application" })],
    ["another team's issuer", () => keys.sign({ iss: "https://another-team.cloudflareaccess.com" })],
    ["an expired token", () => keys.sign({ iat: keys.now - 600, exp: keys.now - 60 })],
    ["a token without an expiry", () => keys.sign({ exp: undefined })],
    ["a signature by another key under the team's key ID", () => keys.sign({}, keys.impostorKey)],
    [
      "an unsigned token",
      () =>
        Promise.resolve(
          new UnsecuredJWT({ exp: keys.now + 300 })
            .setIssuer(testAccess().issuer)
            .setAudience(testAccess().audience)
            .encode(),
        ),
    ],
    ["a value that is not a JWT", () => Promise.resolve("not-a-jwt")],
  ])("refuses %s as forbidden", async (_, token) => {
    expect(await verifyAccess(request(await token()), testAccess(), keys.local)).toEqual({
      ok: false,
      code: "forbidden",
    });
  });
});

/** A fetch that answers every request with `respond`, and the URLs it was asked for. */
function fakeFetch(respond: () => Response) {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(input instanceof Request ? input.url : String(input));
    return respond();
  };
  return { urls, fetchImpl };
}

describe("AUTH-1: remoteKeys", () => {
  test("fetches the team's keys from its certs URL once, and verifies with them", async () => {
    const { urls, fetchImpl } = fakeFetch(() => Response.json(keys.jwks));
    const source = remoteKeys(fetchImpl);
    const access = testAccess();
    expect(await verifyAccess(request(await keys.sign()), access, source(access.certsUrl))).toEqual({ ok: true });
    expect(await verifyAccess(request(await keys.sign()), access, source(access.certsUrl))).toEqual({ ok: true });
    expect(urls).toEqual(["https://example-team.cloudflareaccess.com/cdn-cgi/access/certs"]);
  });

  test("refuses every token when the keys cannot be fetched", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("unavailable", { status: 503 }));
    const access = testAccess();
    expect(await verifyAccess(request(await keys.sign()), access, remoteKeys(fetchImpl)(access.certsUrl))).toEqual({
      ok: false,
      code: "forbidden",
    });
  });

  test("refuses a token the fetched keys did not sign", async () => {
    const { fetchImpl } = fakeFetch(() => Response.json(keys.jwks));
    const access = testAccess();
    const token = await keys.sign({}, keys.impostorKey);
    expect(await verifyAccess(request(token), access, remoteKeys(fetchImpl)(access.certsUrl))).toEqual({
      ok: false,
      code: "forbidden",
    });
  });
});
