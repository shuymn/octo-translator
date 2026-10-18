/**
 * The Worker's own answers. A refusal by the Worker is `{ ok: false, code }` with a code from `WORKER_ERRORS` and its
 * HTTP status; a translation's outcome is the extension's `TranslationResult` with status 200, so the extension handles
 * a remote translation as it does a local one.
 */
import type { TranslationResult } from "../../src/lib/translation.ts";

export const WORKER_ERRORS = [
  "misconfigured",
  "unauthenticated",
  "forbidden",
  "not-found",
  "method-not-allowed",
  "bad-request",
  "unsupported-choice",
  "too-large",
] as const;
export type WorkerError = (typeof WORKER_ERRORS)[number];

const STATUS: Record<WorkerError, number> = {
  misconfigured: 500,
  unauthenticated: 401,
  forbidden: 403,
  "not-found": 404,
  "method-not-allowed": 405,
  "bad-request": 400,
  "unsupported-choice": 400,
  "too-large": 413,
};

export function failure(code: WorkerError, headers: Record<string, string> = {}): Response {
  return json(STATUS[code], { ok: false, code }, headers);
}

export function translation(result: TranslationResult): Response {
  return json(200, result);
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}
