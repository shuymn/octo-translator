/**
 * The Access settings the tests run with. `vitest.config.ts` binds them for the Worker, over anything in `.dev.vars`,
 * so the tests never use the owner's real team. Imported by tests and the test configuration only.
 */
export const TEST_ENV = {
  ACCESS_TEAM_DOMAIN: "https://example-team.cloudflareaccess.com",
  ACCESS_AUD: "example-audience-tag",
};

export const TEST_CERTS_URL = "https://example-team.cloudflareaccess.com/cdn-cgi/access/certs";
