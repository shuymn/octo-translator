/**
 * Test helpers: an Access team's signing keys made locally, and tokens signed with them, so AUTH-1 is checked without
 * the real team. Imported by tests only.
 */
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { parseConfig, type AccessConfig } from "./config.ts";
import { TEST_ENV } from "./test-env.ts";

export function testAccess(): AccessConfig {
  const config = parseConfig(TEST_ENV);
  if (!config.ok) throw new Error("the test environment does not parse");
  return config.access;
}

export type TestKeys = Awaited<ReturnType<typeof makeTestKeys>>;

export async function makeTestKeys() {
  const team = await generateKeyPair("RS256", { extractable: true });
  // Another key under the same key ID: a token it signs names a key the team has, with a signature that does not match.
  const impostor = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(team.publicKey)), kid: "team-key", alg: "RS256", use: "sig" };
  const jwks = { keys: [jwk] };
  const now = Math.floor(Date.now() / 1000);
  const access = testAccess();

  /** A token as Access issues it, with `claims` changed. */
  async function sign(
    claims: Readonly<Record<string, unknown>> = {},
    key: CryptoKey = team.privateKey,
  ): Promise<string> {
    return new SignJWT({ iss: access.issuer, aud: access.audience, iat: now, exp: now + 300, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "team-key" })
      .sign(key);
  }

  return { jwks, local: createLocalJWKSet(jwks), sign, impostorKey: impostor.privateKey, now };
}
