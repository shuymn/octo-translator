/**
 * The GitHub REST API calls of the scheduled translation: who the token belongs to, a search for the owner's pull
 * requests, and a pull request with its rendered description. Answers are checked with Valibot; a pull request's text
 * stays untrusted (R1) and is only read as text (DOM-1, DOM-3).
 *
 * KEY-5: the token travels only to `https://api.github.com`, only in the `Authorization` header, only in GET requests,
 * and a redirect is not followed. Every URL is built here from the fixed origin and parsed parts; none is taken from a
 * response as it is.
 */
import * as v from "valibot";

export const GITHUB_API = "https://api.github.com";

/**
 * The REST API version the responses are read in (https://docs.github.com/en/rest/about-the-rest-api/api-versions).
 * Its breaking changes (https://docs.github.com/en/rest/about-the-rest-api/breaking-changes) touch no field read here.
 */
const API_VERSION = "2026-03-10";

/** A bound per call, well inside a scheduled invocation's 15 minutes of wall time. */
const TIMEOUT_MS = 30_000;

/** `body_html`: the description rendered as GitHub renders it, the input of `pullRequestSegments` (DOM-3). */
const HTML_MEDIA_TYPE = "application/vnd.github.html+json";
const JSON_MEDIA_TYPE = "application/vnd.github+json";

export const GITHUB_ERRORS = [
  "unauthorized",
  "forbidden",
  "not-found",
  "rate-limited",
  "rejected",
  "unavailable",
  "invalid-response",
] as const;
export type GitHubError = (typeof GITHUB_ERRORS)[number];

export type GitHubResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: GitHubError };

const ViewerSchema = v.object({ login: v.string() });

const SearchSchema = v.object({
  total_count: v.number(),
  incomplete_results: v.boolean(),
  items: v.array(
    v.object({
      number: v.pipe(v.number(), v.integer(), v.minValue(1)),
      created_at: v.pipe(v.string(), v.isoTimestamp()),
      updated_at: v.pipe(v.string(), v.isoTimestamp()),
      repository_url: v.string(),
      // Present on pull requests only; the query asks for pull requests, and an issue is dropped if one comes back.
      pull_request: v.optional(v.object({})),
    }),
  ),
});

const PullRequestSchema = v.object({
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
  title: v.string(),
  // Absent or null for an empty description.
  body_html: v.nullish(v.string(), ""),
  draft: v.optional(v.boolean(), false),
  labels: v.array(v.object({ name: v.string() })),
  updated_at: v.pipe(v.string(), v.isoTimestamp()),
  user: v.object({ login: v.string() }),
  base: v.object({
    ref: v.string(),
    repo: v.object({
      name: v.string(),
      full_name: v.string(),
      // PRIV-1: only `false` counts as public.
      private: v.boolean(),
      owner: v.object({ login: v.string() }),
    }),
  }),
});

export type SearchItem = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/**
 * What to search: the pull requests updated at or after `updatedSince`, oldest update first; or, with `createdSince`,
 * those updated within the second `updatedSince` (to the next second, inclusive) and created at or after
 * `createdSince`, oldest creation first. A pull request updated meanwhile leaves that second rather than moving within
 * the order, so that search can be read across runs.
 */
export type SearchWindow = { readonly updatedSince: number; readonly createdSince?: number | undefined };
export type SearchPage = { readonly items: SearchItem[]; readonly totalCount: number; readonly incomplete: boolean };
export type PullRequest = v.InferOutput<typeof PullRequestSchema>;

export type GitHubClient = {
  /** The login of the token's user, the only author whose pull requests are translated. */
  viewer: () => Promise<GitHubResult<string>>;
  /** The token user's pull requests in the window, at most `perPage`. */
  searchPullRequests: (window: SearchWindow, perPage: number) => Promise<GitHubResult<SearchPage>>;
  /** A pull request with `body_html`. */
  pullRequest: (item: SearchItem) => Promise<GitHubResult<PullRequest>>;
};

/** `https://api.github.com/repos/<owner>/<repo>`, the only shape a search item's repository may have. */
const REPOSITORY_URL = /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;

export function createGitHubClient(token: string, fetchFn: typeof fetch): GitHubClient {
  async function get<S extends v.GenericSchema>(
    path: string,
    accept: string,
    schema: S,
  ): Promise<GitHubResult<v.InferOutput<S>>> {
    let response: Response;
    try {
      response = await fetchFn(new URL(path, GITHUB_API), {
        method: "GET",
        headers: {
          Accept: accept,
          Authorization: `Bearer ${token}`,
          // Required by the REST API (https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api).
          "User-Agent": "octo-translator",
          "X-GitHub-Api-Version": API_VERSION,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { ok: false, code: "unavailable" };
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return { ok: false, code: errorOfStatus(response) };
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { ok: false, code: "invalid-response" };
    }
    const parsed = v.safeParse(schema, json);
    return parsed.success ? { ok: true, value: parsed.output } : { ok: false, code: "invalid-response" };
  }

  return {
    async viewer() {
      const result = await get("/user", JSON_MEDIA_TYPE, ViewerSchema);
      return result.ok ? { ok: true, value: result.value.login } : result;
    },
    async searchPullRequests({ updatedSince, createdSince }, perPage) {
      // https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests
      // https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests
      // https://docs.github.com/en/search-github/getting-started-with-searching-on-github/understanding-the-search-syntax
      const byCreation = createdSince !== undefined;
      const window = byCreation
        ? `updated:${searchTime(updatedSince)}..${searchTime(updatedSince + 1000)} created:>=${searchTime(createdSince)}`
        : `updated:>=${searchTime(updatedSince)}`;
      const params = new URLSearchParams({
        q: `is:pr author:@me ${window}`,
        sort: byCreation ? "created" : "updated",
        order: "asc",
        per_page: String(perPage),
      });
      const result = await get(`/search/issues?${params.toString()}`, JSON_MEDIA_TYPE, SearchSchema);
      if (!result.ok) return result;
      const items: SearchItem[] = [];
      for (const item of result.value.items) {
        if (item.pull_request === undefined) continue;
        const match = REPOSITORY_URL.exec(item.repository_url);
        const [, owner, repo] = match ?? [];
        if (owner === undefined || repo === undefined) return { ok: false, code: "invalid-response" };
        items.push({
          owner,
          repo,
          number: item.number,
          createdAt: Date.parse(item.created_at),
          updatedAt: Date.parse(item.updated_at),
        });
      }
      return {
        ok: true,
        value: { items, totalCount: result.value.total_count, incomplete: result.value.incomplete_results },
      };
    },
    pullRequest(item) {
      // https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
      const path = `/repos/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.repo)}/pulls/${String(item.number)}`;
      return get(path, HTML_MEDIA_TYPE, PullRequestSchema);
    },
  };
}

/** `YYYY-MM-DDTHH:MM:SSZ`, rounded down to the second so the bound stays inclusive. */
function searchTime(time: number): string {
  return new Date(Math.floor(time / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

/**
 * Rate limits answer 429, or 403 with no requests left or a `retry-after` (a secondary limit)
 * (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
 */
function errorOfStatus(response: Response): GitHubError {
  const { status } = response;
  if (
    status === 429 ||
    (status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")))
  )
    return "rate-limited";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status >= 500) return "unavailable";
  return "rejected";
}
