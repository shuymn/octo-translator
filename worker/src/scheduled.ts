/**
 * The ahead-of-time translation, run by the Cron Trigger: the owner's own pull requests updated since the last run are
 * searched on GitHub, made into the segments the page will ask with (DOM-3), and translated once per text version,
 * stored where `POST /v1/translate` finds them (RES-2).
 *
 * - Only the token user's own pull requests: the search asks for `author:@me`, and each pull request's author is
 *   checked against the token's login again.
 * - PRIV-1: a pull request of a repository GitHub does not answer `private: false` for is translated only when the
 *   repository is in `PRIVATE_REPOSITORIES`. The CEL filter runs after both checks and can only narrow them.
 * - RES-3: a run translates at most `MAX_TRANSLATIONS_PER_RUN` versions and the schedule makes at most
 *   `MAX_PROVIDER_CALLS_PER_DAY` provider calls a UTC day (counted in D1 before each call); a version costs at most
 *   `MAX_ATTEMPTS` calls. A run that reaches a cap stops, and the next run resumes where it stopped.
 * - Once per version: a version is claimed in D1 before its provider call, so a run that overlaps or retries another
 *   skips it; a failed call is not stored and is retried by a later run, up to the attempts cap. A version is done
 *   when its translation is stored, or dropped because a version requested later is stored; one done whose
 *   translation is missing later is claimed again, within the same attempts cap.
 * - Versions are ordered by when their pull request was fetched (`requestedAt`, taken before the fetch), so a run that
 *   read older text and finishes late does not replace a newer version another run stored.
 * - The cursor (`nextCursor`) moves only past pull requests a run finished with, and only after their work is stored,
 *   so a run that fails or stops part way leaves the rest to the next run. More pull requests than a page with one
 *   update time are read by creation time across runs before the cursor leaves that second.
 */
import { translateWith } from "../../src/lib/clients.ts";
import { sourceTooLong } from "../../src/lib/translation.ts";
import { createGitHubClient, type GitHubClient, type SearchItem, type SearchPage } from "./github.ts";
import { errorName, logEvent } from "./log.ts";
import { pullRequestSegments } from "./pr-segments.ts";
import { parseScheduledConfig, type ScheduledConfig, type ScheduledConfigError } from "./scheduled-config.ts";
import { createScheduledStore, type CursorPosition, type ScheduledStore } from "./scheduled-db.ts";
import { createTranslationStore, storedKey, type TranslationStore } from "./translations-db.ts";

/** Versions a run translates at most. */
export const MAX_TRANSLATIONS_PER_RUN = 5;
/** Provider calls the schedule makes at most per UTC day, across runs. */
export const MAX_PROVIDER_CALLS_PER_DAY = 50;
/**
 * Pull requests a run reads at most: one search page of this size, then one request per pull request. With the
 * translations, a run stays under the 50 subrequests the Workers Free plan allows an invocation
 * (https://developers.cloudflare.com/workers/platform/limits/): 1 + 1 + 30 + 5.
 */
export const MAX_PULLS_PER_RUN = 30;
/**
 * How far before a run's start its cursor may move: GitHub's search index trails updates, so a pull request updated
 * just before a run may not be found by it; the next run searches this margin again.
 */
export const SEARCH_LAG_MS = 5 * 60 * 1000;
/** Where the very first run starts searching: it does not translate the owner's older pull requests. */
export const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** What a run did with one pull request. */
export const OUTCOMES = [
  "translated",
  "already-stored",
  "superseded",
  "japanese",
  "too-long",
  "private",
  "filtered",
  "not-author",
  "inaccessible",
  "gave-up",
  "busy",
  "unavailable",
  "provider-failed",
  "run-cap",
  "daily-cap",
  "github-limited",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * Per outcome: whether the run is finished with the pull request (the cursor may move past it), and whether the run
 * stops there.
 */
const HANDLING: Record<Outcome, { readonly finished: boolean; readonly stop: boolean }> = {
  translated: { finished: true, stop: false },
  // Stored already, by an earlier run or on request, under the same key.
  "already-stored": { finished: true, stop: false },
  // Translated, but a version requested later was stored first: this older text is not kept.
  superseded: { finished: true, stop: false },
  // Every segment is Japanese: the page sends nothing either.
  japanese: { finished: true, stop: false },
  // Over RES-1's bound: the route would refuse it too.
  "too-long": { finished: true, stop: false },
  // PRIV-1. A repository listed later is translated when the pull request next changes.
  private: { finished: true, stop: false },
  filtered: { finished: true, stop: false },
  "not-author": { finished: true, stop: false },
  // 403 or 404: the token cannot read it, and will not on a retry.
  inaccessible: { finished: true, stop: false },
  // Out of attempts: one bad pull request does not hold the cursor or spend the budget.
  "gave-up": { finished: true, stop: false },
  // Another run holds the claim; if it fails, a later run retries.
  busy: { finished: false, stop: false },
  // GitHub failed for this pull request; a later run reads it again.
  unavailable: { finished: false, stop: false },
  // Not stored; a later run retries, up to the attempts cap.
  "provider-failed": { finished: false, stop: false },
  "run-cap": { finished: false, stop: true },
  "daily-cap": { finished: false, stop: true },
  "github-limited": { finished: false, stop: true },
};

export type ScheduledDependencies = {
  /** For GitHub and the provider: the runtime's `fetch` in the Worker, a fake in tests. */
  readonly fetch: typeof fetch;
  readonly now: () => number;
};

export type RunError = ScheduledConfigError | "github-failed" | "state-failed";

export type RunResult =
  | {
      readonly ok: true;
      /** Every pull request found was finished with, and the cursor moved to the run's start, less the lag. */
      readonly complete: boolean;
      /** Pull requests by outcome; an outcome no pull request had is left out. */
      readonly counts: Readonly<Partial<Record<Outcome, number>>>;
    }
  | { readonly ok: false; readonly code: RunError };

export async function runScheduled(env: unknown, deps: ScheduledDependencies): Promise<RunResult> {
  const parsed = parseScheduledConfig(env);
  if (!parsed.ok) {
    logEvent("octo.scheduled.config.invalid", { reason: parsed.code });
    return { ok: false, code: parsed.code };
  }
  try {
    return await run(parsed.config, deps);
  } catch (error) {
    // D1 failed. Nothing after the failure ran: the cursor did not move, and a claim left behind expires.
    logEvent("octo.scheduled.state.failed", { error: errorName(error) });
    return { ok: false, code: "state-failed" };
  }
}

async function run(config: ScheduledConfig, deps: ScheduledDependencies): Promise<RunResult> {
  const startedAt = deps.now();
  const github = createGitHubClient(config.githubToken, deps.fetch);
  const state = createScheduledStore(config.db, deps.now);
  const translations = createTranslationStore(config.db, deps.now);

  const viewer = await github.viewer();
  if (!viewer.ok) {
    logEvent("octo.scheduled.github.failed", { reason: viewer.code });
    return { ok: false, code: "github-failed" };
  }
  await state.sweep();

  // Written before the first search, so a first run that does not finish leaves its bound to the next.
  const position = await state.cursor(startedAt - FIRST_RUN_LOOKBACK_MS);
  const page = await github.searchPullRequests(
    { updatedSince: position.since, createdSince: position.createdSince },
    MAX_PULLS_PER_RUN,
  );
  if (!page.ok) {
    logEvent("octo.scheduled.github.failed", { reason: page.code });
    return { ok: false, code: "github-failed" };
  }

  const counts = new Map<Outcome, number>();
  const context: ItemContext = {
    config,
    deps,
    github,
    state,
    translations,
    login: viewer.value.toLowerCase(),
    calls: 0,
  };
  // The first pull request the run did not finish with: the cursor stops there.
  let unfinished: SearchItem | undefined;
  for (const item of page.value.items) {
    const outcome = await processItem(item, context);
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    if (!HANDLING[outcome].finished) unfinished ??= item;
    if (HANDLING[outcome].stop) break;
  }

  const next = nextCursor(position, page.value, unfinished, startedAt - SEARCH_LAG_MS);
  if (next !== undefined) await state.advanceCursor(next);

  const complete =
    position.createdSince === undefined &&
    !page.value.incomplete &&
    page.value.totalCount <= page.value.items.length &&
    unfinished === undefined;
  const byOutcome = Object.fromEntries(counts);
  logEvent("octo.scheduled.run", { complete, counts: byOutcome });
  return { ok: true, complete, counts: byOutcome };
}

/**
 * Where the next run searches, from where this one did and what it finished; `undefined` leaves the cursor. It never
 * passes `latest` (the run's start less the search's lag), and the store refuses a position behind the current one.
 */
export function nextCursor(
  position: CursorPosition,
  page: SearchPage,
  unfinished: SearchItem | undefined,
  latest: number,
): CursorPosition | undefined {
  // The search ran out of time: what it missed may be anywhere in the window.
  if (page.incomplete) return undefined;
  const more = page.totalCount > page.items.length;
  const last = page.items.at(-1);
  const { since, createdSince } = position;
  if (createdSince === undefined) {
    let target: CursorPosition;
    // The next run starts at the first unfinished pull request's update (`>=` reads it again).
    if (unfinished !== undefined) target = { since: unfinished.updatedAt };
    else if (!more || last === undefined) target = { since: latest };
    // A whole page with the cursor's update time: read that second by creation time, from the start.
    else if (last.updatedAt <= since) target = { since, createdSince: 0 };
    else target = { since: last.updatedAt };
    if (target.since > latest) return { since: latest };
    return target.since === since && target.createdSince === undefined ? undefined : target;
  }
  // Reading the second `since` by creation time.
  if (unfinished !== undefined) {
    return unfinished.createdAt > createdSince ? { since, createdSince: unfinished.createdAt } : undefined;
  }
  if (more) {
    // More than a page created in one second, all with one update time, stays here: not expected of one owner.
    return last !== undefined && last.createdAt > createdSince ? { since, createdSince: last.createdAt } : undefined;
  }
  // The second is read: the cursor leaves it, unless that would pass `latest`.
  return since + 1000 <= latest ? { since: since + 1000 } : undefined;
}

type ItemContext = {
  readonly config: ScheduledConfig;
  readonly deps: ScheduledDependencies;
  readonly github: GitHubClient;
  readonly state: ScheduledStore;
  readonly translations: TranslationStore;
  /** The token user's login, lowercased. */
  readonly login: string;
  /** Provider calls made by this run. */
  calls: number;
};

async function processItem(item: SearchItem, context: ItemContext): Promise<Outcome> {
  const { config, deps, github, state, translations } = context;
  // Taken before the fetch: the store orders versions by it (RES-2), so it must follow which text was read, not when
  // the translation finished.
  const requestedAt = deps.now();
  const fetched = await github.pullRequest(item);
  if (!fetched.ok) {
    logEvent("octo.scheduled.pull.failed", { reason: fetched.code });
    if (fetched.code === "rate-limited") return "github-limited";
    return fetched.code === "not-found" || fetched.code === "forbidden" ? "inaccessible" : "unavailable";
  }
  const pr = fetched.value;
  if (pr.user.login.toLowerCase() !== context.login) return "not-author";

  // PRIV-1: only GitHub's explicit `private: false` counts as public; the schema refuses an answer without the field.
  const repository = pr.base.repo.full_name.toLowerCase();
  if (pr.base.repo.private && !config.allowlist.has(repository)) return "private";

  const filtered = config.filter({
    repo: {
      owner: pr.base.repo.owner.login,
      name: pr.base.repo.name,
      full_name: pr.base.repo.full_name,
      private: pr.base.repo.private,
    },
    pr: {
      number: pr.number,
      title: pr.title,
      draft: pr.draft,
      labels: pr.labels.map((label) => label.name),
      base: pr.base.ref,
      updated_at: Date.parse(pr.updated_at),
    },
  });
  if (!filtered.ok) logEvent("octo.scheduled.filter.failed", { reason: filtered.code });
  if (!filtered.ok || !filtered.pass) return "filtered";

  const segments = pullRequestSegments({ title: pr.title, body_html: pr.body_html });
  if (segments.length === 0) return "japanese";
  if (sourceTooLong(segments)) return "too-long";

  // The extension's key for the page (`pullRequestKey`): the repository as the URL names it, lowercased.
  const key = await storedKey(`${repository}#${pr.number}`, segments, config.choice);
  if ((await translations.lookup(key, segments.length)) !== undefined) return "already-stored";

  if (context.calls >= MAX_TRANSLATIONS_PER_RUN) return "run-cap";
  const claim = await state.claim(key);
  if (claim === "busy") return "busy";
  if (claim === "gave-up") {
    logEvent("octo.scheduled.gave-up");
    return "gave-up";
  }
  // Another run may have stored it between the lookup and the claim.
  if ((await translations.lookup(key, segments.length)) !== undefined) {
    await state.release(key, "done");
    return "already-stored";
  }
  if (!(await state.countCall(MAX_PROVIDER_CALLS_PER_DAY))) {
    await state.release(key, "pending");
    return "daily-cap";
  }
  context.calls += 1;
  const result = await translateWith(config.choice, segments, config.apiKey, deps.fetch);
  if (!result.ok) {
    logEvent("octo.scheduled.translate.failed", { reason: result.code });
    await state.finish(key, "pending");
    return "provider-failed";
  }
  const saved = await translations.save(key, result.translations, requestedAt);
  await state.finish(key, "done");
  return saved === "stored" ? "translated" : "superseded";
}
