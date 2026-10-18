/**
 * The Worker's request handling: configuration, then authentication (AUTH-1), then routing over a closed set of routes.
 * Its dependencies are arguments, so tests drive it with their own keys; `index.ts` only wires it to the runtime.
 */
import { verifyAccess, type KeySource } from "./auth.ts";
import { parseConfig } from "./config.ts";

export const WORKER_ERRORS = [
  "misconfigured",
  "unauthenticated",
  "forbidden",
  "not-found",
  "method-not-allowed",
] as const;
export type WorkerError = (typeof WORKER_ERRORS)[number];

const STATUS: Record<WorkerError, number> = {
  misconfigured: 500,
  unauthenticated: 401,
  forbidden: 403,
  "not-found": 404,
  "method-not-allowed": 405,
};

export const ROUTES = ["/v1/ping"] as const;
export type Route = (typeof ROUTES)[number];

export type HandlerDependencies = { readonly keys: KeySource };

export type Handler = (request: Request, env: unknown) => Promise<Response>;

export function createHandler({ keys }: HandlerDependencies): Handler {
  return async (request, env) => {
    const config = parseConfig(env);
    if (!config.ok) return failure("misconfigured");

    // Before routing, so an unauthenticated caller learns nothing about which routes exist.
    const auth = await verifyAccess(request, config.access, keys(config.access.certsUrl));
    if (!auth.ok) return failure(auth.code);

    const route = findRoute(new URL(request.url).pathname);
    switch (route) {
      case "/v1/ping":
        return request.method === "GET" ? json(200, { ok: true }) : failure("method-not-allowed", { Allow: "GET" });
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

function failure(code: WorkerError, headers: Record<string, string> = {}): Response {
  return json(STATUS[code], { ok: false, code }, headers);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}
