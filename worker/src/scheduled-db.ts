/**
 * The scheduled translation's state in D1 (`worker/migrations/0002_ahead_of_time.sql`): the versions it worked on, its
 * daily provider calls and its search cursor. Every statement is a constant with `?` placeholders and every value is
 * bound (RES-3). Each statement is atomic on its own, and D1 runs one at a time, so two runs that overlap claim a
 * version, count a call or move the cursor without losing either's update.
 * https://developers.cloudflare.com/d1/worker-api/prepared-statements/
 */
import * as v from "valibot";
import type { StoredKey } from "./translations-db.ts";

/** Provider calls one version may cost before the schedule stops retrying it. */
export const MAX_ATTEMPTS = 3;

/**
 * How long a claim holds: longer than a scheduled invocation may run (15 minutes of wall time,
 * https://developers.cloudflare.com/workers/platform/limits/), so a live run's claim never expires under it.
 */
export const CLAIM_MS = 20 * 60 * 1000;

/** How long rows nobody asked for again are kept: translations, the versions worked on, and daily counts. */
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Claims a version for one provider call while it has attempts left: a new version, one whose last attempt failed, one
 * whose claim expired, or one done whose translation the caller found missing (deleted since, by a newer version, a
 * request for older text or the sweep). A version claimed by a live run or out of attempts is not changed.
 */
const CLAIM_VERSION =
  "INSERT INTO scheduled_versions (pr_key, segments_hash, choice_key, state, attempts, claimed_until, updated_at) " +
  "VALUES (?, ?, ?, 'claimed', 1, ?, ?) " +
  "ON CONFLICT (pr_key, segments_hash, choice_key) DO UPDATE SET state = 'claimed', " +
  "attempts = scheduled_versions.attempts + 1, claimed_until = excluded.claimed_until, updated_at = excluded.updated_at " +
  "WHERE scheduled_versions.attempts < ? AND (scheduled_versions.state IN ('pending', 'done') " +
  "OR (scheduled_versions.state = 'claimed' AND scheduled_versions.claimed_until <= ?))";

const SELECT_VERSION =
  "SELECT state, attempts, claimed_until FROM scheduled_versions WHERE pr_key = ? AND segments_hash = ? AND choice_key = ?";

const FINISH_VERSION =
  "UPDATE scheduled_versions SET state = ?, claimed_until = 0, updated_at = ? " +
  "WHERE pr_key = ? AND segments_hash = ? AND choice_key = ? AND state = 'claimed'";

// Gives back a claim whose call was never made, with its attempt: pending (the daily cap was reached) or done (another
// run stored the translation meanwhile).
const RELEASE_UNUSED_CLAIM =
  "UPDATE scheduled_versions SET state = ?, attempts = attempts - 1, claimed_until = 0, updated_at = ? " +
  "WHERE pr_key = ? AND segments_hash = ? AND choice_key = ? AND state = 'claimed'";

// Counts one provider call for the day unless the day's cap is reached.
const COUNT_PROVIDER_CALL =
  "INSERT INTO scheduled_budget (day, provider_calls) VALUES (?, 1) " +
  "ON CONFLICT (day) DO UPDATE SET provider_calls = scheduled_budget.provider_calls + 1 " +
  "WHERE scheduled_budget.provider_calls < ?";

const SELECT_CURSOR = "SELECT updated_since, created_since FROM scheduled_cursor WHERE id = 1";

// The first run's bound, written before its search so a later run starts from the same one; an existing cursor stays.
const START_CURSOR =
  "INSERT INTO scheduled_cursor (id, updated_since, created_since) VALUES (1, ?, -1) ON CONFLICT (id) DO NOTHING";

// The position only moves forward (a later update bound, or a later creation bound within the same second), so a run
// that finishes after a later one cannot move it back.
const ADVANCE_CURSOR =
  "UPDATE scheduled_cursor SET updated_since = ?, created_since = ? " +
  "WHERE id = 1 AND (updated_since < ? OR (updated_since = ? AND created_since < ?))";

const SWEEP_TRANSLATIONS = "DELETE FROM translations WHERE created_at < ?";
// A claim is deleted only once it expired, so a live run's claim stays whatever its age.
const SWEEP_VERSIONS =
  "DELETE FROM scheduled_versions WHERE updated_at < ? AND (state <> 'claimed' OR claimed_until <= ?)";
const SWEEP_BUDGET = "DELETE FROM scheduled_budget WHERE day < ?";

/** The claim, or why there is none: the version is out of attempts, or claimed by a run still in its time. */
export type ClaimResult = "claimed" | "gave-up" | "busy";

/**
 * Where a search starts: the `updated:>=` bound, and while a second's pull requests are read by creation, the
 * `created:>=` bound within that second (`createdSince`, absent otherwise).
 */
export type CursorPosition = { readonly since: number; readonly createdSince?: number };

export type ScheduledStore = {
  claim: (key: StoredKey) => Promise<ClaimResult>;
  /** Marks a claimed version done (translated and stored) or pending again (the call failed; a later run retries). */
  finish: (key: StoredKey, state: "done" | "pending") => Promise<void>;
  /** Gives back a claim whose provider call was not made, leaving the version pending or done. */
  release: (key: StoredKey, state: "done" | "pending") => Promise<void>;
  /** Counts one provider call against the day's cap; `false` when the cap is reached and nothing was counted. */
  countCall: (cap: number) => Promise<boolean>;
  /** The cursor, written first with `since` when there is none. */
  cursor: (since: number) => Promise<CursorPosition>;
  advanceCursor: (to: CursorPosition) => Promise<void>;
  /** Deletes translations, versions and daily counts older than `RETENTION_MS`. */
  sweep: () => Promise<void>;
};

const VersionRowSchema = v.object({
  state: v.picklist(["pending", "claimed", "done"]),
  attempts: v.number(),
  claimed_until: v.number(),
});
const CursorRowSchema = v.object({ updated_since: v.number(), created_since: v.number() });
const NO_CREATED_SINCE = -1;

export function createScheduledStore(db: D1Database, now: () => number): ScheduledStore {
  return {
    async claim({ prKey, hash, choice }) {
      const time = now();
      const result = await db
        .prepare(CLAIM_VERSION)
        .bind(prKey, hash, choice, time + CLAIM_MS, time, MAX_ATTEMPTS, time)
        .run();
      if (result.meta.changes === 1) return "claimed";
      const row = v.safeParse(VersionRowSchema, await db.prepare(SELECT_VERSION).bind(prKey, hash, choice).first());
      // The row was there a moment ago and rows are deleted only long after their last change; read it as busy.
      if (!row.success) return "busy";
      if (row.output.state === "claimed" && row.output.claimed_until > time) return "busy";
      return row.output.attempts >= MAX_ATTEMPTS ? "gave-up" : "busy";
    },
    async finish({ prKey, hash, choice }, state) {
      await db.prepare(FINISH_VERSION).bind(state, now(), prKey, hash, choice).run();
    },
    async release({ prKey, hash, choice }, state) {
      await db.prepare(RELEASE_UNUSED_CLAIM).bind(state, now(), prKey, hash, choice).run();
    },
    async countCall(cap) {
      const result = await db.prepare(COUNT_PROVIDER_CALL).bind(utcDay(now()), cap).run();
      return result.meta.changes === 1;
    },
    async cursor(since) {
      await db.prepare(START_CURSOR).bind(since).run();
      const row = v.parse(CursorRowSchema, await db.prepare(SELECT_CURSOR).first());
      return row.created_since === NO_CREATED_SINCE
        ? { since: row.updated_since }
        : { since: row.updated_since, createdSince: row.created_since };
    },
    async advanceCursor({ since, createdSince = NO_CREATED_SINCE }) {
      await db.prepare(ADVANCE_CURSOR).bind(since, createdSince, since, since, createdSince).run();
    },
    async sweep() {
      const time = now();
      const before = time - RETENTION_MS;
      await db.batch([
        db.prepare(SWEEP_TRANSLATIONS).bind(before),
        db.prepare(SWEEP_VERSIONS).bind(before, time),
        db.prepare(SWEEP_BUDGET).bind(utcDay(before)),
      ]);
    },
  };
}

/** `YYYY-MM-DD` in UTC. */
function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}
