/**
 * The Worker's log lines: one JSON object per line, an event from a closed set and fields from closed sets or counts.
 * No message, key, token, statement, pull request key or text is ever a field (KEY-2, KEY-5, PRIV-1): an error is
 * logged by its name only.
 */

export const LOG_EVENTS = [
  "octo.translations.lookup.failed",
  "octo.translations.save.failed",
  "octo.scheduled.config.invalid",
  "octo.scheduled.github.failed",
  "octo.scheduled.pull.failed",
  "octo.scheduled.filter.failed",
  "octo.scheduled.translate.failed",
  "octo.scheduled.gave-up",
  "octo.scheduled.state.failed",
  "octo.scheduled.run",
] as const;
export type LogEvent = (typeof LOG_EVENTS)[number];

/** Failures go to `console.error`, the run's summary to `console.log`. */
const LEVEL: Record<LogEvent, "error" | "info"> = {
  "octo.translations.lookup.failed": "error",
  "octo.translations.save.failed": "error",
  "octo.scheduled.config.invalid": "error",
  "octo.scheduled.github.failed": "error",
  "octo.scheduled.pull.failed": "error",
  "octo.scheduled.filter.failed": "error",
  "octo.scheduled.translate.failed": "error",
  "octo.scheduled.gave-up": "error",
  "octo.scheduled.state.failed": "error",
  "octo.scheduled.run": "info",
};

export type LogFields = {
  /** A code from one of the Worker's closed sets. */
  readonly reason?: string;
  /** The name of a thrown error (`errorName`). */
  readonly error?: string;
  /** A run's pull requests by outcome (`OUTCOMES` in scheduled.ts). */
  readonly counts?: Readonly<Record<string, number>>;
  readonly complete?: boolean;
};

export function logEvent(event: LogEvent, fields: LogFields = {}): void {
  const line = JSON.stringify({ event, ...fields });
  if (LEVEL[event] === "error") console.error(line);
  else console.log(line);
}

const ERROR_NAMES = ["Error", "TypeError", "RangeError", "SyntaxError"] as const;

/** A thrown value's name, from a closed set, so a custom error's name cannot carry text into a log line. */
export function errorName(error: unknown): string {
  if (!(error instanceof Error)) return "other";
  return ERROR_NAMES.find((name) => name === error.name) ?? "other";
}
