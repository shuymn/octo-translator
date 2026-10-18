/**
 * The Worker's request handling: configuration, then authentication (AUTH-1), then routing over a closed set of routes.
 * Its dependencies are arguments, so tests drive it with their own keys and translation; `index.ts` only wires it to
 * the runtime.
 */
import { verifyAccess, type KeySource } from "./auth.ts";
import { parseConfig } from "./config.ts";
import { failure, json } from "./http.ts";
import { handleTranslate, type TranslateDependencies } from "./translate.ts";

export const ROUTES = ["/v1/ping", "/v1/translate"] as const;
export type Route = (typeof ROUTES)[number];

export type HandlerDependencies = TranslateDependencies & { readonly keys: KeySource };

export type Handler = (request: Request, env: unknown) => Promise<Response>;

export function createHandler(deps: HandlerDependencies): Handler {
  return async (request, env) => {
    const config = parseConfig(env);
    if (!config.ok) return failure("misconfigured");

    // Before routing, so an unauthenticated caller learns nothing about which routes exist.
    const auth = await verifyAccess(request, config.access, deps.keys(config.access.certsUrl));
    if (!auth.ok) return failure(auth.code);

    const route = findRoute(new URL(request.url).pathname);
    switch (route) {
      case "/v1/ping":
        return request.method === "GET" ? json(200, { ok: true }) : failure("method-not-allowed", { Allow: "GET" });
      case "/v1/translate":
        return request.method === "POST"
          ? handleTranslate(request, env, deps)
          : failure("method-not-allowed", { Allow: "POST" });
      case undefined:
        return failure("not-found");
      default:
        return route satisfies never;
    }
  };
}

function findRoute(pathname: string): Route | undefined {
  return ROUTES.find((route) => route === pathname);
}
