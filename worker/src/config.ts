/**
 * The Worker's settings, read from its environment and checked before any request is handled. A missing or malformed
 * value refuses every request (AUTH-1 fails closed), rather than verifying against a wrong issuer or audience.
 */
import * as v from "valibot";

/**
 * The Access team domain as Cloudflare documents it, `https://<team>.cloudflareaccess.com`: the token's issuer, and the
 * origin of the team's signing keys.
 * https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
 */
const TEAM_DOMAIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/;

const EnvSchema = v.object({
  ACCESS_TEAM_DOMAIN: v.pipe(v.string(), v.regex(TEAM_DOMAIN)),
  // The Access application's audience (AUD) tag.
  ACCESS_AUD: v.pipe(v.string(), v.regex(/^\S+$/)),
});

export type AccessConfig = {
  /** The expected `iss` claim. */
  readonly issuer: string;
  /** The expected `aud` claim. */
  readonly audience: string;
  /** Where the team publishes its signing keys. */
  readonly certsUrl: URL;
};

export type ConfigResult = { readonly ok: true; readonly access: AccessConfig } | { readonly ok: false };

export function parseConfig(env: unknown): ConfigResult {
  const parsed = v.safeParse(EnvSchema, env);
  if (!parsed.success) return { ok: false };
  const { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: audience } = parsed.output;
  return {
    ok: true,
    access: { issuer: teamDomain, audience, certsUrl: new URL("/cdn-cgi/access/certs", teamDomain) },
  };
}
