// PRIV-1, RES-2, RES-3, DOM-3, KEY-2, KEY-5: the scheduled ahead-of-time translation, run against the local D1
// database the migrations made, with a fake GitHub and a fake DeepSeek behind one injected `fetch`. The provider client
// is the real one (`translateWith`). Runs in the Workers runtime.
import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { hashSegments } from "../../src/lib/cache.ts";
import { PULL_REQUEST_SHAPES } from "../../src/lib/pr-shapes.fixtures.ts";
import { ENDPOINTS } from "../../src/lib/responses.ts";
import { SourceSegmentSchema, type SourceSegment, type TranslationResult } from "../../src/lib/translation.ts";
import { ACCESS_JWT_HEADER } from "./auth.ts";
import { createHandler } from "./handler.ts";
import worker from "./index.ts";
import { pullRequestSegments } from "./pr-segments.ts";
import {
  FIRST_RUN_LOOKBACK_MS,
  MAX_PROVIDER_CALLS_PER_DAY,
  MAX_PULLS_PER_RUN,
  MAX_TRANSLATIONS_PER_RUN,
  runScheduled,
  SEARCH_LAG_MS,
  type Outcome,
  type RunResult,
} from "./scheduled.ts";
import { CLAIM_MS, MAX_ATTEMPTS, RETENTION_MS } from "./scheduled-db.ts";
import { makeTestKeys } from "./test-keys.ts";

const GITHUB_TOKEN = "test-github-token";
const DEEPSEEK_KEY = "test-deepseek-key";
const OWNER = "octo-owner";
// Close to the translate tests' clock, so the retention sweep of these runs never reaches their rows.
const START = Date.parse("2023-11-15T00:00:00Z");
const MINUTE = 60 * 1000;

type FakePull = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body_html: string;
  updated_at: number;
  created_at?: number;
  /** `null` leaves the field out of the answer. */
  private?: boolean | null;
  draft?: boolean;
  labels?: string[];
  base?: string;
  author?: string;
};

type Recorded = {
  url: string;
  method: string;
  headers: Record<string, string>;
  redirect: string | undefined;
  body: string;
};

/** GitHub and DeepSeek, as one `fetch`. Any other URL fails the test. */
function fakeWorld() {
  const pulls = new Map<string, FakePull>();
  const requests: Recorded[] = [];
  const state = {
    /** Answers DeepSeek with this status instead of a translation. */
    providerStatus: 200,
    /** Answers these pull requests' fetches with this status. */
    pullStatus: new Map<string, number>(),
    /** Held until released: lets a test overlap two runs while a translation is in flight. */
    providerGate: undefined as Promise<void> | undefined,
    /** Held until released, after the answer is made from the pull request as it was asked for. */
    pullGate: undefined as Promise<void> | undefined,
    providerCalls: [] as SourceSegment[][],
    /** The search's `incomplete_results`. */
    searchIncomplete: false,
  };

  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ url: url.href, method: init?.method ?? "GET", headers, redirect: init?.redirect, body });

    if (url.href === ENDPOINTS.deepseek) {
      const { input: modelInput } = v.parse(v.object({ input: v.string() }), JSON.parse(body));
      const { segments } = v.parse(v.object({ segments: v.array(SourceSegmentSchema) }), JSON.parse(modelInput));
      state.providerCalls.push(segments);
      await state.providerGate;
      if (state.providerStatus !== 200) return new Response("{}", { status: state.providerStatus });
      const text = JSON.stringify({ translations: segments.map((segment) => `訳: ${segment.text}`) });
      return Response.json({
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
      });
    }
    if (url.origin !== "https://api.github.com") throw new Error(`unexpected request to ${url.href}`);
    if (headers.authorization !== `Bearer ${GITHUB_TOKEN}`) return new Response("{}", { status: 401 });

    if (url.pathname === "/user") return Response.json({ login: OWNER });
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") ?? "";
      const perPage = Number(url.searchParams.get("per_page"));
      const range = /updated:(\S+)\.\.(\S+) created:>=(\S+)/.exec(query);
      const byCreation = url.searchParams.get("sort") === "created";
      const since = Date.parse(range?.[1] ?? /updated:>=(\S+)/.exec(query)?.[1] ?? "");
      const until = range ? Date.parse(range[2] ?? "") : Infinity;
      const createdFrom = range ? Date.parse(range[3] ?? "") : -Infinity;
      if (byCreation !== (range !== null)) throw new Error(`unexpected search ${query}`);
      // Ties keep the order they were added in, as GitHub gives no second key.
      const matching = [...pulls.values()]
        .filter((candidate) => candidate.updated_at >= since && candidate.updated_at <= until)
        .filter((candidate) => createdOf(candidate) >= createdFrom)
        .toSorted((a, b) => (byCreation ? createdOf(a) - createdOf(b) : a.updated_at - b.updated_at));
      return Response.json({
        total_count: matching.length,
        incomplete_results: state.searchIncomplete,
        items: matching.slice(0, perPage).map((item) => ({
          number: item.number,
          title: item.title,
          created_at: iso(createdOf(item)),
          updated_at: iso(item.updated_at),
          repository_url: `https://api.github.com/repos/${item.owner}/${item.repo}`,
          pull_request: { url: "" },
        })),
      });
    }
    const match = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(url.pathname);
    const found = match ? pulls.get(`${match[1]}/${match[2]}#${match[3]}`) : undefined;
    if (found === undefined) return new Response("{}", { status: 404 });
    const status = state.pullStatus.get(`${found.owner}/${found.repo}#${found.number}`);
    if (status !== undefined) return new Response("{}", { status });
    const answer = Response.json({
      number: found.number,
      title: found.title,
      body_html: found.body_html,
      draft: found.draft ?? false,
      labels: (found.labels ?? []).map((name) => ({ name })),
      updated_at: iso(found.updated_at),
      user: { login: found.author ?? OWNER },
      base: {
        ref: found.base ?? "main",
        repo: {
          name: found.repo,
          full_name: `${found.owner}/${found.repo}`,
          ...(found.private === null ? {} : { private: found.private ?? false }),
          owner: { login: found.owner },
        },
      },
    });
    await state.pullGate;
    return answer;
  };

  return {
    pulls,
    requests,
    state,
    fetch: fetchFn,
    add(added: FakePull) {
      pulls.set(`${added.owner}/${added.repo}#${added.number}`, added);
    },
  };
}

function createdOf(pullRequest: FakePull): number {
  return pullRequest.created_at ?? START - 24 * 60 * MINUTE + pullRequest.number * 1000;
}

function iso(time: number): string {
  return new Date(time).toISOString().replace(".000Z", "Z");
}

type Settings = { filter?: string; allowlist?: string; db?: unknown; token?: string };

function scheduledEnv(settings: Settings = {}) {
  return {
    DB: settings.db ?? env.DB,
    GITHUB_TOKEN: settings.token ?? GITHUB_TOKEN,
    DEEPSEEK_API_KEY: DEEPSEEK_KEY,
    AHEAD_OF_TIME_FILTER: settings.filter ?? "",
    PRIVATE_REPOSITORIES: settings.allowlist ?? "",
    AHEAD_OF_TIME_CHOICE: "",
  };
}

/** A clock for one run, at `time`, moving a millisecond on each reading. */
function clockAt(time: number): () => number {
  let current = time;
  return () => current++;
}

function runAt(world: ReturnType<typeof fakeWorld>, time: number, settings: Settings = {}): Promise<RunResult> {
  return runScheduled(scheduledEnv(settings), { fetch: world.fetch, now: clockAt(time) });
}

/** The run's pull requests by outcome. */
function counted(result: RunResult): Partial<Record<Outcome, number>> | RunResult {
  return result.ok ? result.counts : result;
}

async function cursor(): Promise<number | null> {
  return env.DB.prepare("SELECT updated_since FROM scheduled_cursor WHERE id = 1").first("updated_since");
}

async function createdSince(): Promise<number | null> {
  return env.DB.prepare("SELECT created_since FROM scheduled_cursor WHERE id = 1").first("created_since");
}

async function storedRows(prKey: string) {
  const { results } = await env.DB.prepare(
    "SELECT segments_hash, choice_key, translations FROM translations WHERE pr_key = ?",
  )
    .bind(prKey)
    .all();
  return results;
}

function pull(number: number, updatedAt: number, overrides: Partial<FakePull> = {}): FakePull {
  return {
    owner: "example-org",
    repo: "project",
    number,
    title: `Add the cache ${number}`,
    body_html: `<p>Stores entries for ${number}.</p>`,
    updated_at: updatedAt,
    ...overrides,
  };
}

beforeEach(async () => {
  // The schedule's own tables are this file's; the translations are cleared for its repositories only.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM scheduled_versions"),
    env.DB.prepare("DELETE FROM scheduled_budget"),
    env.DB.prepare("DELETE FROM scheduled_cursor"),
    env.DB.prepare("DELETE FROM translations WHERE pr_key LIKE 'example-org/%'"),
  ]);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RES-2: once per text version", () => {
  test("a new pull request is translated once and stored under the page's key, hash and choice", async () => {
    const world = fakeWorld();
    world.add(pull(1, START - 10 * MINUTE));
    const result = await runAt(world, START);
    expect(result).toMatchObject({ ok: true, complete: true });
    expect(counted(result)).toEqual({ translated: 1 });
    const segments: SourceSegment[] = [
      { kind: "title", text: "Add the cache 1" },
      { kind: "paragraph", text: "Stores entries for 1." },
    ];
    expect(world.state.providerCalls).toEqual([segments]);
    expect(await storedRows("example-org/project#1")).toEqual([
      {
        segments_hash: await hashSegments(segments),
        choice_key: "deepseek/deepseek-flash/none",
        translations: JSON.stringify(["訳: Add the cache 1", "訳: Stores entries for 1."]),
      },
    ]);
    // The cursor moves to the run's start, less the search's lag.
    expect(await cursor()).toBe(START - SEARCH_LAG_MS);
  });

  test("the first run searches the owner's pull requests of the last day, oldest update first", async () => {
    const world = fakeWorld();
    await runAt(world, START);
    const search = world.requests.find((request) => request.url.includes("/search/issues"));
    const url = new URL(search?.url ?? "");
    expect(url.searchParams.get("q")).toBe(`is:pr author:@me updated:>=${iso(START - FIRST_RUN_LOOKBACK_MS)}`);
    expect(url.searchParams.get("sort")).toBe("updated");
    expect(url.searchParams.get("order")).toBe("asc");
    expect(url.searchParams.get("per_page")).toBe(String(MAX_PULLS_PER_RUN));
  });

  test("an unchanged pull request is not translated again, though its update time moved", async () => {
    const world = fakeWorld();
    world.add(pull(2, START - 10 * MINUTE));
    await runAt(world, START);
    // A comment moves `updated_at` without changing the text.
    world.add(pull(2, START + 5 * MINUTE));
    const second = await runAt(world, START + 15 * MINUTE);
    expect(counted(second)).toEqual({ "already-stored": 1 });
    expect(world.state.providerCalls).toHaveLength(1);
  });

  test("a version done but no longer stored is translated again, within its attempts", async () => {
    const world = fakeWorld();
    world.add(pull(3, START - 10 * MINUTE));
    await runAt(world, START);
    await env.DB.prepare("DELETE FROM translations WHERE pr_key = 'example-org/project#3'").run();
    world.add(pull(3, START + 5 * MINUTE));
    expect(counted(await runAt(world, START + 15 * MINUTE))).toEqual({ translated: 1 });
    expect(world.state.providerCalls).toHaveLength(2);
    expect(await storedRows("example-org/project#3")).toHaveLength(1);
  });

  test("an edited pull request is translated again, and the new version replaces the old", async () => {
    const world = fakeWorld();
    world.add(pull(4, START - 10 * MINUTE));
    await runAt(world, START);
    world.add(pull(4, START + 5 * MINUTE, { body_html: "<p>Stores entries for longer.</p>" }));
    expect(counted(await runAt(world, START + 15 * MINUTE))).toEqual({ translated: 1 });
    expect(world.state.providerCalls).toHaveLength(2);
    expect(await storedRows("example-org/project#4")).toEqual([
      expect.objectContaining({
        translations: JSON.stringify(["訳: Add the cache 4", "訳: Stores entries for longer."]),
      }),
    ]);
  });

  test("a pull request whose segments are all Japanese is skipped without a call", async () => {
    const world = fakeWorld();
    world.add(pull(5, START - 10 * MINUTE, { title: "キャッシュを追加する", body_html: "<p>古い項目を消す。</p>" }));
    expect(counted(await runAt(world, START))).toEqual({ japanese: 1 });
    expect(world.state.providerCalls).toEqual([]);
  });

  test("only the English segments are sent when some are Japanese, as the page does", async () => {
    const world = fakeWorld();
    world.add(pull(6, START - 10 * MINUTE, { body_html: "<p>古い項目を消す。</p><p>Deletes old entries.</p>" }));
    await runAt(world, START);
    expect(world.state.providerCalls).toEqual([
      [
        { kind: "title", text: "Add the cache 6" },
        { kind: "paragraph", text: "Deletes old entries." },
      ],
    ]);
  });
});

describe("PRIV-1: private repositories", () => {
  test("a private repository is skipped unless it is listed", async () => {
    const world = fakeWorld();
    world.add(pull(1, START - 10 * MINUTE, { repo: "secret", private: true }));
    expect(counted(await runAt(world, START))).toEqual({ private: 1 });
    expect(world.state.providerCalls).toEqual([]);
    expect(world.requests.some((request) => request.url === ENDPOINTS.deepseek)).toBe(false);
  });

  test("a repository GitHub does not say is public or private is not translated", async () => {
    const world = fakeWorld();
    world.add(pull(1, START - 10 * MINUTE, { private: null }));
    expect(counted(await runAt(world, START))).toEqual({ unavailable: 1 });
    expect(world.state.providerCalls).toEqual([]);
  });

  test("a listed private repository is translated, the listing compared without case", async () => {
    const world = fakeWorld();
    world.add(pull(1, START - 10 * MINUTE, { repo: "Secret", private: true }));
    const result = await runAt(world, START, { allowlist: "example-org/other, Example-Org/secret" });
    expect(counted(result)).toEqual({ translated: 1 });
    expect(await storedRows("example-org/secret#1")).toHaveLength(1);
  });

  test("the filter cannot widen past PRIV-1 or the owner's own pull requests", async () => {
    const world = fakeWorld();
    world.add(pull(1, START - 10 * MINUTE, { repo: "secret", private: true }));
    // The search asks for `author:@me`; a pull request by someone else that came back anyway is still skipped.
    world.add(pull(2, START - 9 * MINUTE, { author: "someone-else" }));
    const result = await runAt(world, START, { filter: "true || repo.private" });
    expect(counted(result)).toEqual({ private: 1, "not-author": 1 });
    expect(world.state.providerCalls).toEqual([]);
  });
});

describe("the filter", () => {
  test("a pull request passes when the expression is true and is skipped when it is false", async () => {
    const world = fakeWorld();
    world.add(pull(1, START - 10 * MINUTE, { draft: true }));
    world.add(pull(2, START - 9 * MINUTE, { labels: ["translate"] }));
    const result = await runAt(world, START, { filter: '!pr.draft && "translate" in pr.labels' });
    expect(counted(result)).toEqual({ filtered: 1, translated: 1 });
    expect(world.state.providerCalls.map((segments) => segments[0]?.text)).toEqual(["Add the cache 2"]);
  });

  test("an invalid expression stops the run before any request, with one log line", async () => {
    const world = fakeWorld();
    world.add(pull(1, START - 10 * MINUTE));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runAt(world, START, { filter: "pr.draft ==" });
    expect(result).toEqual({ ok: false, code: "invalid-filter" });
    expect(world.requests).toEqual([]);
    expect(errors.mock.calls).toEqual([['{"event":"octo.scheduled.config.invalid","reason":"invalid-filter"}']]);
    expect(await cursor()).toBeNull();
  });

  test("an expression that fails on a pull request skips it", async () => {
    const world = fakeWorld();
    world.add(pull(1, START - 10 * MINUTE));
    const result = await runAt(world, START, { filter: 'pr.labels[0] == "translate"' });
    expect(counted(result)).toEqual({ filtered: 1 });
    expect(world.state.providerCalls).toEqual([]);
  });
});

describe("RES-3: caps", () => {
  test("a run stops at its cap, and the next run resumes where it stopped", async () => {
    const world = fakeWorld();
    for (let number = 1; number <= MAX_TRANSLATIONS_PER_RUN + 2; number += 1) {
      world.add(pull(number, START - 60 * MINUTE + number * MINUTE));
    }
    const first = await runAt(world, START);
    expect(first).toMatchObject({ ok: true, complete: false });
    expect(counted(first)).toEqual({ translated: MAX_TRANSLATIONS_PER_RUN, "run-cap": 1 });
    // The cursor stops at the first pull request not translated.
    expect(await cursor()).toBe(START - 60 * MINUTE + (MAX_TRANSLATIONS_PER_RUN + 1) * MINUTE);

    const second = await runAt(world, START + 15 * MINUTE);
    expect(second).toMatchObject({ ok: true, complete: true });
    expect(counted(second)).toEqual({ translated: 2 });
    expect(world.state.providerCalls).toHaveLength(MAX_TRANSLATIONS_PER_RUN + 2);
  });

  test("the daily cap stops every run that day, and the next day resumes", async () => {
    const world = fakeWorld();
    world.add(pull(1, START - 10 * MINUTE));
    world.add(pull(2, START - 9 * MINUTE));
    await env.DB.prepare("INSERT INTO scheduled_budget (day, provider_calls) VALUES (?, ?)")
      .bind(iso(START).slice(0, 10), MAX_PROVIDER_CALLS_PER_DAY - 1)
      .run();
    const first = await runAt(world, START);
    expect(counted(first)).toEqual({ translated: 1, "daily-cap": 1 });
    const later = await runAt(world, START + 15 * MINUTE);
    // The cursor stopped at the second pull request, so the later run reads only that one.
    expect(counted(later)).toEqual({ "daily-cap": 1 });
    expect(world.state.providerCalls).toHaveLength(1);

    // The claim given back at the cap kept its attempts: the version is translated the next day.
    const nextDay = await runAt(world, START + 24 * 60 * MINUTE);
    expect(counted(nextDay)).toEqual({ translated: 1 });
    expect(world.state.providerCalls).toHaveLength(2);
  });

  test("a call never made at the daily cap costs the version no attempt", async () => {
    const world = fakeWorld();
    world.add(pull(1, START - 10 * MINUTE));
    await env.DB.prepare("INSERT INTO scheduled_budget (day, provider_calls) VALUES (?, ?)")
      .bind(iso(START).slice(0, 10), MAX_PROVIDER_CALLS_PER_DAY)
      .run();
    for (let run = 0; run < MAX_ATTEMPTS; run += 1) {
      expect(counted(await runAt(world, START + run * 15 * MINUTE))).toEqual({ "daily-cap": 1 });
    }
    expect(counted(await runAt(world, START + 24 * 60 * MINUTE))).toEqual({ translated: 1 });
  });

  test("more pull requests than a page with one update time are all read, and the cursor then moves on", async () => {
    const world = fakeWorld();
    const tie = START - 60 * MINUTE;
    const tied = MAX_PULLS_PER_RUN + 5;
    for (let number = 1; number <= tied; number += 1) world.add(pull(number, tie));
    for (let number = tied + 1; number <= tied + 3; number += 1) world.add(pull(number, START - 30 * MINUTE));
    let time = START;
    let complete = false;
    for (let run = 0; run < 20 && !complete; run += 1) {
      const result = await runAt(world, time);
      expect(result.ok).toBe(true);
      // One of the tied pull requests, already translated, is edited while the second is being read.
      if (run === 2) world.add(pull(1, time + MINUTE, { body_html: "<p>Edited while the second is read.</p>" }));
      complete = run > 2 && result.ok && result.complete;
      time += 15 * MINUTE;
    }
    expect(complete).toBe(true);
    // The second was read by creation time.
    expect(world.requests.some((request) => new URL(request.url).searchParams.get("sort") === "created")).toBe(true);
    for (let number = 1; number <= tied + 3; number += 1) {
      expect(await storedRows(`example-org/project#${String(number)}`)).toHaveLength(1);
    }
    expect(await storedRows("example-org/project#1")).toEqual([
      expect.objectContaining({
        translations: JSON.stringify(["訳: Add the cache 1", "訳: Edited while the second is read."]),
      }),
    ]);
    expect(world.state.providerCalls).toHaveLength(tied + 3 + 1);
    expect(await cursor()).toBeGreaterThan(START);
    expect(await createdSince()).toBe(-1);
  });

  test("more pull requests than a run reads leave the cursor at the last one read", async () => {
    const world = fakeWorld();
    for (let number = 1; number <= MAX_PULLS_PER_RUN + 1; number += 1) {
      world.add(pull(number, START - 120 * MINUTE + number * MINUTE, { title: `キャッシュ ${number}`, body_html: "" }));
    }
    const first = await runAt(world, START);
    expect(first).toMatchObject({ ok: true, complete: false });
    expect(await cursor()).toBe(START - 120 * MINUTE + MAX_PULLS_PER_RUN * MINUTE);
    const second = await runAt(world, START + 15 * MINUTE);
    expect(counted(second)).toEqual({ japanese: 2 });
    expect(second).toMatchObject({ complete: true });
  });
});

describe("RES-3: failures and retries", () => {
  test("a provider error is not stored, holds the cursor, and is retried up to the attempts cap", async () => {
    const world = fakeWorld();
    world.add(pull(1, START - 10 * MINUTE));
    world.state.providerStatus = 500;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const result = await runAt(world, START + attempt * 15 * MINUTE);
      expect(counted(result)).toEqual({ "provider-failed": 1 });
      expect(await cursor()).toBe(START - 10 * MINUTE);
    }
    expect(await storedRows("example-org/project#1")).toEqual([]);
    const after = await runAt(world, START + MAX_ATTEMPTS * 15 * MINUTE);
    expect(counted(after)).toEqual({ "gave-up": 1 });
    expect(world.state.providerCalls).toHaveLength(MAX_ATTEMPTS);
    expect(await cursor()).toBe(START + MAX_ATTEMPTS * 15 * MINUTE - SEARCH_LAG_MS);
  });

  test("a failed retry recovers: the next run translates and stores", async () => {
    const world = fakeWorld();
    world.add(pull(1, START - 10 * MINUTE));
    world.state.providerStatus = 503;
    await runAt(world, START);
    world.state.providerStatus = 200;
    expect(counted(await runAt(world, START + 15 * MINUTE))).toEqual({ translated: 1 });
    expect(await storedRows("example-org/project#1")).toHaveLength(1);
  });

  test("a run that fails part way does not move the cursor, and a later run finishes the work", async () => {
    const world = fakeWorld();
    world.add(pull(1, START - 10 * MINUTE));
    // D1 fails when the translation is stored.
    const failing = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: (statements: D1PreparedStatement[]) =>
        statements.length === 2 ? Promise.reject(new Error("D1_ERROR")) : env.DB.batch(statements),
    };
    expect(await runAt(world, START, { db: failing })).toEqual({ ok: false, code: "state-failed" });
    expect(await cursor()).toBe(START - FIRST_RUN_LOOKBACK_MS);
    expect(await storedRows("example-org/project#1")).toEqual([]);

    // Its claim holds while that run could still be running, then expires.
    const during = await runAt(world, START + 15 * MINUTE);
    expect(counted(during)).toEqual({ busy: 1 });
    expect(await cursor()).toBe(START - 10 * MINUTE);
    const after = await runAt(world, START + CLAIM_MS + MINUTE);
    expect(counted(after)).toEqual({ translated: 1 });
    expect(await storedRows("example-org/project#1")).toHaveLength(1);
  });

  test("a pull request GitHub fails to answer holds the cursor; later ones are still translated", async () => {
    const world = fakeWorld();
    world.add(pull(1, START - 10 * MINUTE));
    world.add(pull(2, START - 9 * MINUTE));
    world.state.pullStatus.set("example-org/project#1", 502);
    expect(counted(await runAt(world, START))).toEqual({ unavailable: 1, translated: 1 });
    expect(await cursor()).toBe(START - 10 * MINUTE);
  });

  test("a GitHub rate limit stops the run", async () => {
    const world = fakeWorld();
    world.add(pull(1, START - 10 * MINUTE));
    world.add(pull(2, START - 9 * MINUTE));
    world.state.pullStatus.set("example-org/project#1", 429);
    expect(counted(await runAt(world, START))).toEqual({ "github-limited": 1 });
    expect(world.state.providerCalls).toEqual([]);
  });

  test("a search that ran out of time does not move the cursor", async () => {
    const world = fakeWorld();
    world.add(pull(1, START - 10 * MINUTE));
    world.state.searchIncomplete = true;
    const result = await runAt(world, START);
    expect(result).toMatchObject({ ok: true, complete: false });
    expect(counted(result)).toEqual({ translated: 1 });
    expect(await cursor()).toBe(START - FIRST_RUN_LOOKBACK_MS);
  });

  test("the first run's bound is kept for the next run when the first does not finish", async () => {
    const world = fakeWorld();
    world.state.searchIncomplete = true;
    await runAt(world, START);
    world.state.searchIncomplete = false;
    await runAt(world, START + 120 * MINUTE);
    const searches = world.requests
      .filter((request) => request.url.includes("/search/issues"))
      .map((request) => new URL(request.url).searchParams.get("q"));
    const bound = `is:pr author:@me updated:>=${iso(START - FIRST_RUN_LOOKBACK_MS)}`;
    expect(searches).toEqual([bound, bound]);
    expect(await cursor()).toBe(START + 120 * MINUTE - SEARCH_LAG_MS);
  });

  test("a failed search fails the run without moving the cursor", async () => {
    const world = fakeWorld();
    expect(await runAt(world, START, { token: "another-token" })).toEqual({ ok: false, code: "github-failed" });
    expect(await cursor()).toBeNull();
  });

  test("overlapping runs translate a version once, and only the run that finished it moves the cursor past it", async () => {
    const world = fakeWorld();
    world.add(pull(1, START - 10 * MINUTE));
    const gate = Promise.withResolvers<void>();
    world.state.providerGate = gate.promise;
    const first = runAt(world, START);
    // The second run starts while the first one's translation is in flight.
    await vi.waitFor(() => expect(world.state.providerCalls).toHaveLength(1));
    const second = await runAt(world, START + MINUTE);
    expect(counted(second)).toEqual({ busy: 1 });
    expect(await cursor()).toBe(START - 10 * MINUTE);
    gate.resolve();
    expect(counted(await first)).toEqual({ translated: 1 });
    expect(world.state.providerCalls).toHaveLength(1);
    expect(await cursor()).toBe(START - SEARCH_LAG_MS);
  });

  test("a run that read older text and finishes late does not replace the newer version another run stored", async () => {
    const world = fakeWorld();
    world.add(pull(1, START - 10 * MINUTE));
    // One clock for both runs, so their readings follow the order the runs actually took.
    const clock = clockAt(START);
    const held = Promise.withResolvers<void>();
    world.state.pullGate = held.promise;
    const first = runScheduled(scheduledEnv(), { fetch: world.fetch, now: clock });
    // The first run has asked for the pull request and holds the older text; it is edited, and a second run stores
    // the newer version before the first one's answer arrives.
    await vi.waitFor(() => expect(world.requests.some((request) => request.url.endsWith("/pulls/1"))).toBe(true));
    world.state.pullGate = undefined;
    world.add(pull(1, START - 5 * MINUTE, { body_html: "<p>Stores entries for longer.</p>" }));
    const second = await runScheduled(scheduledEnv(), { fetch: world.fetch, now: clock });
    expect(counted(second)).toEqual({ translated: 1 });
    held.resolve();
    expect(counted(await first)).toEqual({ superseded: 1 });
    expect(await storedRows("example-org/project#1")).toEqual([
      expect.objectContaining({
        translations: JSON.stringify(["訳: Add the cache 1", "訳: Stores entries for longer."]),
      }),
    ]);
    expect(counted(await runAt(world, START + 15 * MINUTE))).toEqual({ "already-stored": 1 });
    expect(world.state.providerCalls).toHaveLength(2);
  });

  test("a run that claims a version another run stored meanwhile does not translate it again", async () => {
    const world = fakeWorld();
    world.add(pull(1, START - 10 * MINUTE));
    const provider = Promise.withResolvers<void>();
    world.state.providerGate = provider.promise;
    const first = runAt(world, START);
    await vi.waitFor(() => expect(world.state.providerCalls).toHaveLength(1));

    // The second run looks the version up while the first translates, and claims it only after the first stored it.
    const claimGate = Promise.withResolvers<void>();
    let claiming = false;
    const heldClaims = {
      prepare: (sql: string) => {
        const statement = env.DB.prepare(sql);
        if (!sql.startsWith("INSERT INTO scheduled_versions")) return statement;
        return {
          bind: (...values: unknown[]) => {
            const bound = statement.bind(...values);
            return {
              run: async () => {
                claiming = true;
                await claimGate.promise;
                return bound.run();
              },
            };
          },
        };
      },
      batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
    };
    const second = runAt(world, START + MINUTE, { db: heldClaims });
    await vi.waitFor(() => expect(claiming).toBe(true));
    provider.resolve();
    expect(counted(await first)).toEqual({ translated: 1 });
    claimGate.resolve();
    expect(counted(await second)).toEqual({ "already-stored": 1 });
    expect(world.state.providerCalls).toHaveLength(1);
  });

  test("the cursor never moves back when an earlier run finishes after a later one", async () => {
    const world = fakeWorld();
    await runAt(world, START + 60 * MINUTE);
    await runAt(world, START);
    expect(await cursor()).toBe(START + 60 * MINUTE - SEARCH_LAG_MS);
  });
});

describe("KEY-2, KEY-5: where the credentials go", () => {
  test("the GitHub token goes only to api.github.com, in the Authorization header of GET requests that do not follow redirects", async () => {
    const world = fakeWorld();
    world.add(pull(1, START - 10 * MINUTE));
    await runAt(world, START);
    const github = world.requests.filter((request) => request.url.startsWith("https://api.github.com/"));
    expect(github.map((request) => new URL(request.url).pathname)).toEqual([
      "/user",
      "/search/issues",
      "/repos/example-org/project/pulls/1",
    ]);
    for (const request of github) {
      expect(request).toMatchObject({ method: "GET", redirect: "manual", body: "" });
      expect(request.headers.authorization).toBe(`Bearer ${GITHUB_TOKEN}`);
      expect(request.url).not.toContain(GITHUB_TOKEN);
    }
    expect(github[2]?.headers.accept).toBe("application/vnd.github.html+json");
    const others = world.requests.filter((request) => !request.url.startsWith("https://api.github.com/"));
    expect(others.map((request) => request.url)).toEqual([ENDPOINTS.deepseek]);
    expect(JSON.stringify(others)).not.toContain(GITHUB_TOKEN);
    expect(others[0]?.headers.authorization).toBe(`Bearer ${DEEPSEEK_KEY}`);
  });

  test("log lines carry no token, key, repository or text", async () => {
    const world = fakeWorld();
    world.add(pull(1, START - 10 * MINUTE, { repo: "secret", private: true }));
    world.add(pull(2, START - 9 * MINUTE));
    world.state.providerStatus = 500;
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await runAt(world, START);
    const lines = [...logs.mock.calls, ...errors.mock.calls].flat().join("\n");
    for (const secret of [GITHUB_TOKEN, DEEPSEEK_KEY, "secret", "example-org", "Add the cache"]) {
      expect(lines).not.toContain(secret);
    }
    expect(errors.mock.calls).toEqual([['{"event":"octo.scheduled.translate.failed","reason":"api-error"}']]);
  });
});

describe("retention", () => {
  test("a run deletes translations, versions and daily counts older than the retention", async () => {
    const world = fakeWorld();
    const old = START - RETENTION_MS - MINUTE;
    const recent = START - MINUTE;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO translations (pr_key, segments_hash, choice_key, translations, requested_at, created_at) VALUES (?, 'h', 'c', '[]', ?, ?)",
      ).bind("example-org/old#1", old, old),
      env.DB.prepare(
        "INSERT INTO translations (pr_key, segments_hash, choice_key, translations, requested_at, created_at) VALUES (?, 'h', 'c', '[]', ?, ?)",
      ).bind("example-org/recent#1", recent, recent),
      env.DB.prepare(
        "INSERT INTO scheduled_versions (pr_key, segments_hash, choice_key, state, attempts, claimed_until, updated_at) VALUES ('example-org/old#1', 'h', 'c', 'done', 1, 0, ?)",
      ).bind(old),
      // An abandoned claim long expired, and a claim still live however old its row.
      env.DB.prepare(
        "INSERT INTO scheduled_versions (pr_key, segments_hash, choice_key, state, attempts, claimed_until, updated_at) VALUES ('example-org/abandoned#1', 'h', 'c', 'claimed', 1, ?, ?)",
      ).bind(old + CLAIM_MS, old),
      env.DB.prepare(
        "INSERT INTO scheduled_versions (pr_key, segments_hash, choice_key, state, attempts, claimed_until, updated_at) VALUES ('example-org/live#1', 'h', 'c', 'claimed', 1, ?, ?)",
      ).bind(START + CLAIM_MS, old),
      env.DB.prepare("INSERT INTO scheduled_budget (day, provider_calls) VALUES (?, 1)").bind(iso(old).slice(0, 10)),
    ]);
    await runAt(world, START);
    expect(await storedRows("example-org/old#1")).toEqual([]);
    expect(await storedRows("example-org/recent#1")).toHaveLength(1);
    const { results } = await env.DB.prepare("SELECT pr_key FROM scheduled_versions").all();
    expect(results).toEqual([{ pr_key: "example-org/live#1" }]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scheduled_budget").first("n")).toBe(0);
  });
});

describe("DOM-3: the extension finds the stored translation", () => {
  test.each(
    PULL_REQUEST_SHAPES.filter((shape) => shape.segments.length > 0).map((shape) => [shape.name, shape] as const),
  )("%s", async (_, shape) => {
    const world = fakeWorld();
    world.add(pull(1, START - 10 * MINUTE, { title: shape.title, body_html: shape.api }));
    expect(counted(await runAt(world, START))).toEqual({ translated: 1 });

    // The extension asks with the segments it read from the page (the shape's), through the translate route.
    const keys = await makeTestKeys();
    const calls: SourceSegment[][] = [];
    const handle = createHandler({
      keys: () => keys.local,
      translate: async (_choice, segments): Promise<TranslationResult> => {
        calls.push(segments);
        return { ok: false, code: "api-error" };
      },
      now: () => START + MINUTE,
    });
    const request = new Request("https://worker.example/v1/translate", {
      method: "POST",
      headers: { [ACCESS_JWT_HEADER]: await keys.sign() },
      body: JSON.stringify({ key: "example-org/project#1", segments: shape.segments }),
    });
    const response = await handle(request, {
      ACCESS_TEAM_DOMAIN: env.ACCESS_TEAM_DOMAIN,
      ACCESS_AUD: env.ACCESS_AUD,
      DB: env.DB,
      DEEPSEEK_API_KEY: DEEPSEEK_KEY,
    });
    expect(await response.json()).toEqual({
      ok: true,
      translations: shape.segments.map((segment) => `訳: ${segment.text}`),
    });
    expect(calls).toEqual([]);
    expect(pullRequestSegments({ title: shape.title, body_html: shape.api })).toEqual(shape.segments);
  });
});

describe("the entry point", () => {
  test("a run without a GitHub token fails the invocation and logs why", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // vitest.config.ts binds an empty GITHUB_TOKEN.
    await expect(worker.scheduled(createScheduledController(), env)).rejects.toThrow("the scheduled run failed");
    expect(errors.mock.calls).toEqual([['{"event":"octo.scheduled.config.invalid","reason":"missing-github-token"}']]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
