/**
 * AUTH-1: every request carries the JWT that Cloudflare Access adds after its own check, and the Worker verifies it
 * again, so a request that reaches the Worker without passing Access is refused.
 *
 * - Header, issuer, audience and keys: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
 * - jose's verification and remote key set: https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md
 *   and https://github.com/panva/jose/blob/main/docs/jwks/remote/functions/createRemoteJWKSet.md
 */
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey, type RemoteJWKSet } from "jose";
import type { AccessConfig } from "./config.ts";

/** The header Access sets on every request it lets through. */
export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

/** Access signs its tokens with RS256; any other algorithm, `none` included, is refused. */
const ALGORITHMS = ["RS256"];

export type AuthResult = { readonly ok: true } | { readonly ok: false; readonly code: "unauthenticated" | "forbidden" };

/** The keys to verify a token with, for the team whose keys are published at `certsUrl`. */
export type KeySource = (certsUrl: URL) => JWTVerifyGetKey;

/**
 * The team's published keys, fetched by jose and kept for the life of the isolate. jose refetches when the cache is
 * older than its maximum age, or when a token names a key it does not have (Access rotates its keys), at most once per
 * cooldown.
 */
export function remoteKeys(fetchImpl?: typeof fetch): KeySource {
  let cached: { readonly href: string; readonly keys: RemoteJWKSet } | undefined;
  return (certsUrl) => {
    if (cached?.href !== certsUrl.href) {
      const keys = createRemoteJWKSet(
        certsUrl,
        fetchImpl === undefined ? {} : { [customFetch]: (url, options) => fetchImpl(url, options) },
      );
      cached = { href: certsUrl.href, keys };
    }
    return cached.keys;
  };
}

/**
 * Checks the request's Access token: its signature against the team's keys, its issuer, its audience and its expiry.
 * The result says only whether a token was there; why a token was refused is not told to the caller.
 */
export async function verifyAccess(request: Request, access: AccessConfig, keys: JWTVerifyGetKey): Promise<AuthResult> {
  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (token === null || token === "") return { ok: false, code: "unauthenticated" };
  try {
    await jwtVerify(token, keys, {
      issuer: access.issuer,
      audience: access.audience,
      algorithms: ALGORITHMS,
      // jose checks `exp` only when it is present; a token without one would never expire.
      requiredClaims: ["exp"],
    });
    return { ok: true };
  } catch {
    // A bad token and keys that could not be fetched alike: fail closed.
    return { ok: false, code: "forbidden" };
  }
}
