# octo-translator threat model

What octo-translator protects, from whom, and the security invariants the code must keep, by ID (for example `DOM-1`).
It covers security and privacy only; correctness, translation quality and design are reviewed against their own
criteria. The libraries and patterns that keep these invariants are in [decisions.md](decisions.md).

**Keep it current.** A PR that adds an entry point, asset, trust boundary or accepted risk, or changes an invariant's
status, updates this file. IDs are never reused: an invariant that no longer applies is marked retired with the reason.

## Status of an invariant

Paths are relative to the repository root. **Enforced (main):** the cited source and test exist on `main`. **Planned
(n):** not implemented; required before stage _n_ ships. The stages are listed in [decisions.md](decisions.md#stages):
1 providers in the extension, 2 translation on Cloudflare, 3 repository wiki.

## How an invariant is pinned

Each enforced invariant names how its test pins it.

- **Behavior:** a test drives the code with an input and checks the result (the segments sent, the nodes built, the
  request made).
- **Source analysis:** a test reads the sources and fails on a forbidden shape, for a rule that must hold in every file,
  including code no behavior test reaches. `src/lib/source-analysis.test.ts` reads the sources with
  `import.meta.glob('?raw')`, skips test files, and feeds each pattern small fixtures that must be detected, so a
  pattern that silently stopped matching fails.
- **Configuration:** a setting in a configuration file (the manifest, `package.json`, `pnpm-workspace.yaml`, a
  workflow) that no test exercises. An enforced part pinned by configuration alone cites no test.

`src/lib/threat-model.test.ts` checks this document: an _Enforced (main)_ invariant says how it is pinned; one pinned by
behavior or source analysis cites at least one test file; and every cited test file exists and names the invariant's
ID.

## Deployment assumptions

- One user, the owner, who installs the extension unpacked in their own Chrome and is signed in to GitHub there.
- The extension runs a content script on `https://github.com/*` and a background service worker. It has the `storage`
  permission and host access to the model providers' APIs (DeepSeek, OpenAI, Gemini); `https://*/*` is an optional
  host permission, of which the options page asks for the one https origin of the owner's Worker when it is saved.
- Without a Worker, the background calls the model provider directly with the owner's API key. With a Worker URL and
  an Access service token saved in the options, it calls the Worker instead, which holds the provider keys and a GitHub
  token that reads the owner's pull requests (KEY-5); it falls back to the provider only when the Worker cannot be
  reached and a local key exists (KEY-4).
- A Cron Trigger runs the Worker every 15 minutes to translate the owner's own pull requests ahead of time
  (`worker/src/scheduled.ts`), with settings the owner sets on the Worker: the GitHub token and the private
  repositories it may translate as secrets, a CEL filter and the model choice as variables.
- The Worker (`worker/`) is deployed by the owner behind a Cloudflare Access application whose policy admits the
  extension's service token. The Access application, its policy and the service token are dashboard settings; the
  repository holds none of their identifiers.
- The owner deploys with `pnpm --filter octo-translator-worker run deploy` ([operations.md](operations.md)), which
  merges the public `worker/wrangler.jsonc` with the gitignored `worker/wrangler.deploy.jsonc` (the custom domain, the
  account, the D1 `database_id` and the schedule's two variables, A10), applies the remote D1 migrations and deploys.
  The Worker is reached only on that custom domain: it has no `workers.dev` URL and no preview URLs (AUTH-1), and its
  invocation logs are off (KEY-4, KEY-5). The D1 database is created by the owner beforehand; the secrets (A2, A3, A7,
  `PRIVATE_REPOSITORIES`) are set with `wrangler secret put` and never written to a file of the repository or the
  deployment file.
- From stage 3, one Durable Object per GitHub repository runs a Pi agent and keeps that repository's wiki in its own
  SQLite database.

**Out of scope:** a compromised owner machine, browser profile or GitHub account; a compromised Cloudflare account,
model provider or GitHub; other extensions with broad host permissions reading github.com; and the owner acting against
their own data. TLS is assumed between all parties.

**Not built, on purpose:** publishing the extension to the Chrome Web Store, sharing a Worker between users,
translating comments or review threads, and storing translations anywhere the owner did not configure.

## Assets

| ID  | Asset                                                                    | Why it matters                                                                                           |
| --- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| A1  | The integrity of the github.com page the owner is signed in to           | Script or markup injected there acts with the owner's GitHub session                                     |
| A2  | Model provider API keys (Gemini, DeepSeek, OpenAI)                       | A leaked key spends the owner's money; in the extension's storage and, from stage 2, as Worker secrets   |
| A3  | The GitHub token, a Worker secret (`GITHUB_TOKEN`)                       | It reads the owner's pull requests, private ones included; its least scope is in KEY-5                   |
| A4  | Text of private repositories and pull requests                           | Sending it to a provider discloses it to that provider, and the free tiers may train on it               |
| A5  | The repository wiki, above all its glossary (stage 3)                    | Every later translation of the repository uses it; a planted entry misleads translations for a long time |
| A6  | Cost: model tokens, Cloudflare requests, Durable Object time and storage | The owner pays                                                                                           |
| A7  | The Worker's Access settings: team domain and application audience tag   | Not credentials, but they identify the owner's Cloudflare setup; Worker secrets, never in the repository |
| A8  | The Worker's D1 database: pull request keys and their translations       | Private repositories' names and translated text; read only through the Worker, behind AUTH-1             |
| A9  | The Access service token (client id and secret) in the extension         | It opens the Worker, which spends the owner's provider keys (A2, A6); in the extension's storage only    |
| A10 | The deployment values: the custom domain, account id and D1 database id  | Not credentials, but they identify the owner's setup; in the gitignored deployment file, never committed |

## Adversaries

| ID  | Adversary                                                                   | Capabilities                                                                                                      |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| R1  | Any GitHub user who writes a pull request title, body or repository content | Controls the text the extension reads, sends to a model and shows back; can write instructions aimed at the model |
| R2  | The model's output                                                          | Whatever R1's text or a faulty model makes it return: markup, wrong markers, instructions to tools                |
| R3  | A web page or another extension                                             | Sends messages to the extension's runtime if allowed, and changes the DOM of pages it runs on                     |
| R4  | An anonymous internet client (stage 2 on)                                   | Calls the Worker's public URL with any request                                                                    |
| R5  | A model provider that keeps or trains on requests                           | Reads everything sent to it                                                                                       |
| R6  | A compromised dependency or GitHub Action                                   | Runs code in the build, CI, the extension or the Worker                                                           |

## Entry points

| Entry point                                                     | Reached by | Trusted after                                                                                        | Status and code                                                                                    |
| --------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| The pull request's title and description in the DOM             | R1         | never; read as text, sent as data                                                                    | main: `src/lib/pr-page.ts`, `src/lib/segments.ts`                                                  |
| Model responses                                                 | R2         | schema check, then marker check per segment (DOM-1)                                                  | main: `src/lib/responses.ts`, `src/lib/gemini.ts`, `src/lib/translation.ts`, `src/lib/segments.ts` |
| Runtime messages to the background                              | R3         | sender is this extension, schema check (MSG-1)                                                       | main: `src/entrypoints/background.ts`, `src/lib/messages.ts`                                       |
| The Worker's answers to the background                          | R2, R4     | status 200, `TranslationResultSchema`, one translation per segment, then DOM-1                       | main: `src/lib/worker-client.ts`                                                                   |
| Responses from the background to the content script             | R3         | schema check                                                                                         | main: `src/entrypoints/github.content.ts`                                                          |
| The options page                                                | owner      | form validation; the provider choice by `parseChoice`, the Worker URL by `parseWorkerUrl`            | main: `src/entrypoints/options/`, `src/lib/providers.ts`, `src/lib/worker-client.ts`               |
| Worker routes (`GET /v1/ping`, `POST /v1/translate`)            | R4         | Cloudflare Access, then the Access JWT (AUTH-1)                                                      | main: `worker/src/handler.ts`, `worker/src/auth.ts`                                                |
| The translate route's body                                      | owner      | AUTH-1, then a byte limit and a schema check (RES-1)                                                 | main: `worker/src/body.ts`, `worker/src/translate.ts`                                              |
| Rows read back from D1                                          | the Worker | schema check; a row that does not fit is a miss                                                      | main: `worker/src/translations-db.ts`                                                              |
| A pull request's `title` and `body_html` from GitHub's REST API | R1         | never; `body_html` parsed only by linkedom to be read as text, the title never parsed (DOM-1, DOM-3) | main: `worker/src/pr-segments.ts`, `src/lib/segments.ts`                                           |
| The Cron Trigger (`scheduled`)                                  | Cloudflare | the schedule's settings parsed first, failing closed (`parseScheduledConfig`)                        | main: `worker/src/index.ts`, `worker/src/scheduled-config.ts`                                      |
| The schedule's settings (filter, private repositories, choice)  | owner      | parsed at the start of each run; one invalid setting stops the run before any request                | main: `worker/src/scheduled-config.ts`, `worker/src/filter.ts`                                     |
| Scheduled GitHub search, and fetching pull requests             | R1         | schema check; the text never, read as in DOM-3; author and PRIV-1 checked per pull request           | main: `worker/src/github.ts`, `worker/src/scheduled.ts`                                            |
| Agent tools and the wiki                                        | R1, R2     | tools are read-only except the wiki writer (WIKI-1, WIKI-2)                                          | Planned (3)                                                                                        |
| Build, CI and dependency updates                                | R6         | lockfile, release age, exact versions, pinned Actions (SUP-1)                                        | main: `package.json`, `worker/package.json`, `pnpm-workspace.yaml`, `.github/workflows/`           |

## Invariants

### Page integrity (DOM)

- **DOM-1: nothing from a pull request or a model becomes HTML in the page.** Inline elements travel to the model as
  numbered markers; translated nodes are clones of the page's own elements whose text is set with `textContent`, and
  text nodes are created with `createTextNode`. A translation whose markers do not match its segment exactly (every kept
  element once, every wrapped element opened and closed once with only text inside), or that has no text, is dropped and
  the original stays. _Enforced (main):_ `buildTranslatedNodes` in `src/lib/segments.ts`; `src/lib/segments.test.ts`
  ("DOM-1": a translation carrying an `<img onerror>` stays text, and each malformed marker shape is rejected) and
  `src/lib/controller.test.ts` ("DOM-1": a part whose markers came back wrong stays in the original). _Pinned by
  behavior; and by source analysis, forbidden API:_ `src/lib/source-analysis.test.ts` refuses `innerHTML`,
  `outerHTML`, `insertAdjacentHTML`, `DOMParser`, `document.write`, `createContextualFragment` and the
  `setHTMLUnsafe` family in every non-test file under `src` and `worker/src`. The Worker builds no nodes for the page;
  the one HTML it parses is GitHub's `body_html`, GitHub's sanitized rendering of the description, with linkedom, to
  read its segments (DOM-3); the title is put in a tree with `createTextNode`, and nothing parsed is serialized or
  stored. _Enforced (main):_ `pullRequestSegments` in `worker/src/pr-segments.ts`; `worker/src/pr-segments.test.ts`
  ("DOM-1": markup in the title stays text; scripts, styles and templates in `body_html` add no segment), and
  `src/lib/source-analysis.test.ts` refuses linkedom (any of its entry points) and `parseHTML` in every non-test file
  under `src` and `worker/src` but `worker/src/pr-segments.ts`.
- **DOM-2: the content script runs only on github.com.** Its only match pattern is `https://github.com/*`, and it acts
  only on a pull request's Conversation tab. _Enforced (main):_ `matches` in `src/entrypoints/github.content.ts`;
  `parsePullRequestPath` in `src/lib/pr-page.ts`. _Pinned by configuration._
- **DOM-3: a translation made ahead of time is shown only for the exact segments it was made from.** The Worker keys
  stored translations by the SHA-256 of the segments; the extension asks with the hash of the segments it read from
  the page, and a mismatch falls back to translating on request. The Worker makes the segments of a pull request from
  the REST API's `title` and `body_html` with the extension's own extraction (`extractPullRequestSegments`, which the
  page controller uses too), run on linkedom; tag names are compared in upper case, because a browser gives an `svg`
  or `math` element a lower-case one and linkedom an upper-case one. The served page's description was compared with
  `body_html` on public pull requests, before and after GitHub's scripts ran: the HTML is the same apart from signed
  image URLs, attributes the scripts add and code blocks' copy buttons, none of which changes a segment. The title is
  raw text in the API (https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request documents `body_html` only), and
  the page renders its code spans as `<code>`, so the Worker renders those the same way (CommonMark's rule).
  _Enforced (main)_ for the segments: `extractPullRequestSegments` and `toSourceSegments` in `src/lib/segments.ts`,
  used by `src/lib/controller.ts`; `pullRequestSegments` and `renderTitle` in `worker/src/pr-segments.ts`;
  `src/lib/segments.test.ts` ("DOM-3": each shape's page markup on happy-dom) and `worker/src/pr-segments.test.ts`
  ("DOM-3": the same shapes' `body_html` on linkedom in workerd) expect the same segments and the same written-out
  hash, for paragraphs with inline code, links, mentions, references and emphasis, headings (with and without the
  page's anchors), nested lists, task lists, tables, code and highlighted blocks, images, blockquotes, alerts, details
  and Japanese text, from the fixtures in `src/lib/pr-shapes.fixtures.ts`; `src/lib/source-analysis.test.ts` keeps the
  parser to that module. _Pinned by behavior._ _Gaps, which translate on request:_ an emoji shortcode in the title
  (the page shows the emoji, the API the shortcode; pinned by both tests), math, which GitHub's scripts render in the
  page after it is served (not compared), and markup only a signed-in author's page has, such as a
  task list's drag handles, not compared. GraphQL's `PullRequest.titleHTML` is documented only as the title "rendered
  to HTML" (https://docs.github.com/public/fpt/schema.docs.graphql), not as rendering emoji shortcodes as the page
  does; it is not used, so an emoji title stays a gap. The ahead-of-time translation stores under these hashes with
  the route's own key (`storedKey` in `worker/src/translations-db.ts`): _Enforced (main):_ `processItem` in
  `worker/src/scheduled.ts`; `worker/src/scheduled.test.ts` ("DOM-3": for each fixture shape, the stored translation
  answers the translate route's request with the page's segments, without a provider call). _Pinned by behavior._

### Credentials (KEY)

- **KEY-1: the API keys and the Worker's service token are kept in `storage.local` and read only by the background
  and the options page.** One key per provider, and the Worker configuration (its origin with the Access service token's client id and
  secret, in one item); none is ever in
  `storage.sync` (which copies it to every signed-in browser), and the content script never reads one. It reads only
  the provider choice, to name the provider. The secret items live in their own module, because WXT reads an item's
  value as soon as it is defined: importing the module at all reads every secret. _Enforced (main):_ `apiKeyItems` and
  `workerAccessItem` in `src/lib/api-keys.ts`, imported only by `src/entrypoints/background.ts` and
  `src/entrypoints/options/main.ts`. _Pinned by behavior:_ `src/lib/content-script-storage.test.ts` ("KEY-1") loads
  the content script and everything it imports on WXT's fake browser, runs its `main` on a page, records every
  `storage.local` read, and fails on any secret's storage name (taken from the items themselves) or a bulk read
  (`get()`, `get(null)`, `getKeys()`). _And by source analysis, forbidden pattern:_ `src/lib/source-analysis.test.ts`
  refuses `storage.sync` and `sync:` storage keys under `src`; refuses an import of `api-keys` (static, dynamic or
  re-export) outside those two files, and any reference to `apiKeyItems`, `apiKeyItem` or `workerAccessItem` outside
  them and `src/lib/api-keys.ts`; and refuses a secret's storage name (any string ending in `apiKey`, such as
  `local:apiKey` or `local:deepseekApiKey`, and `workerAccess` or `local:workerAccess`) outside `src/lib/api-keys.ts`. _Gap: the behavior test runs the load and the first sync, not
  a click, a settings change or a later navigation; the accepted risk below covers those paths._
- **KEY-2: a key travels only in a request header to its own provider.** Gemini's is sent as `x-goog-api-key` to the
  Gemini endpoint, DeepSeek's and OpenAI's as `Authorization: Bearer` to their Responses API endpoints; never in a URL
  or the body. Endpoints are constants per provider, not settings, and the extension's required host permissions are
  those three endpoints (the optional one is for the Worker's origin, KEY-4). _Enforced (main):_ `translateSegments` in `src/lib/gemini.ts`, `ENDPOINTS` and `translateResponses`
  in `src/lib/responses.ts`, `translateWith` in `src/lib/clients.ts`, `host_permissions` in `wxt.config.ts`;
  `src/lib/gemini.test.ts` and `src/lib/responses.test.ts` ("KEY-2": the URL has no key, the header has it) and
  `src/lib/clients.test.ts` ("KEY-2": each provider's request goes to that provider's endpoint). _Pinned by behavior._
  The Worker uses the same clients: its keys are Worker secrets, one per provider (`DEEPSEEK_API_KEY`,
  `OPENAI_API_KEY`, `GEMINI_API_KEY`, none in the repository), passed only to `translateWith`, and never part of an
  answer or a log line. _Enforced (main):_ `API_KEY_SECRETS` and `handleTranslate` in `worker/src/translate.ts`, wired
  to `translateWith` in `worker/src/index.ts`; `worker/src/translate.test.ts` ("KEY-2": the request to DeepSeek carries
  the Worker's key in its header only and the answer does not; a failed store logs only the error's name). _Pinned by
  behavior._
- **KEY-3: from stage 2, provider keys and the GitHub token live only on Cloudflare.** They are Worker secrets or AI
  Gateway provider keys; the extension holds only the Access service token, and the agent receives neither keys nor
  the token, only tools that use them. The GitHub token is a Worker secret only and the extension has none (KEY-5).
  _Planned (2)_ for the Worker, _Planned (3)_ for the agent. Until then the
  extension keeps its provider keys for the local fallback of KEY-4; the owner who wants none in the browser leaves
  them empty, and a Worker that cannot be reached then answers `worker-unreachable`.
- **KEY-4: the Access service token goes only to the configured Worker origin, only in headers; provider keys never go
  to the Worker.** The origin and the token are one stored item, `{ origin, clientId, clientSecret }`, written whole
  and read once per request, so a token is never paired with another configuration's origin. The Worker URL is an https origin with the default port and no path, query, fragment or
  credentials (`parseWorkerUrl`), checked on save and again whenever the background reads it. The token travels as
  `CF-Access-Client-Id` and `CF-Access-Client-Secret` to `<origin>/v1/translate` only, never in the URL or the body,
  and a redirect is not followed (Access redirects a request it does not admit to its login page unless strict
  service token authentication is on), so the headers cannot reach another origin. The request body is the pull
  request key, the segments and the provider choice; the provider keys are read only for a local translation. The
  optional host permission is asked for that one origin from the options page, and the background sends nothing
  without it: a revoked permission, a stored URL that no longer parses or half a token answers `worker-rejected`
  without a request. An options page writes the configuration, and asks for or drops a permission, only when the
  owner edited the Worker section there, so a page opened before a newer save does not put an older Worker back or
  drop the newer origin's permission. Only a Worker that cannot be reached (a network failure or a timeout, before the status or while
  the body is read, or a 5xx) falls back to the provider with the local key; a 401, 403, 429 (Access's or
  Cloudflare's refusal; a provider's limit arrives inside a 200 as `rate-limited`), another 4xx or a redirect answers
  `worker-rejected`, and a complete answer that is not a `TranslationResult` for every segment `invalid-response`,
  without a local call. _Enforced (main):_
  `parseWorkerUrl`, `resolveWorker`, `translateWithWorker` and `WORKER_FAILURE_HANDLING` in `src/lib/worker-client.ts`,
  `createTranslateService` in `src/lib/translate-service.ts`, wired in `src/entrypoints/background.ts`;
  `workerAccessItem` in `src/lib/api-keys.ts`; `planWorkerSave` and `storeWorker` in `src/lib/worker-edits.ts`, used
  by `src/entrypoints/options/main.ts` with the permission request; `optional_host_permissions` in `wxt.config.ts`;
  `src/lib/worker-client.test.ts` ("KEY-4": the URL, the headers, a body without the token, `redirect: "manual"`, each
  status, a redirect, a timeout, a body cut off and malformed answers; the URLs accepted and refused; an origin
  always paired with its own token while the configuration changes; an unusable setting),
  `src/lib/worker-edits.test.ts` (a stale page's unrelated save leaves a newer configuration and its permission
  intact; a replaced origin's permission is dropped) and
  `src/lib/translate-service.test.ts` ("KEY-4": a Worker hit reads no provider key; 5xx and network failures, also while the body is
  read, fall back; refusals, 429 included, and a malformed body do not; no local key answers the Worker failure). _Pinned by behavior._ _Gap: the options page's
  permission request runs only in Chrome, inside the save click; no test drives it. Two pages saving the Worker at
  the same moment may leave a replaced origin's permission granted; it is unused, as the token goes only to the
  stored origin._ On the Worker's side, neither the service token nor the Access JWT that replaces it is logged: the
  Worker logs only `logEvent` lines, and Cloudflare's invocation logs, which record the request with heuristic header
  redaction, are off (`observability.logs.invocation_logs` false in `worker/wrangler.jsonc`, which the deployment file
  cannot change; [operations.md](operations.md#schedule-and-logs-key-4-key-5)). _Enforced (main):_
  `worker/wrangler.jsonc`, `mergeDeployConfig` in `worker/scripts/deploy-config.ts`; `worker/src/deploy-config.test.ts`
  ("KEY-4": invocation logs are off, and a deployment file setting `observability` is refused). _Pinned by behavior._
  _Gap: that the deployed Worker's logs hold only `octo.*` lines is checked after deployment._

- **KEY-5: the GitHub token goes only to GitHub's API, only in a header, and is the least the schedule needs.** It is
  the Worker secret `GITHUB_TOKEN`, read only by the schedule's configuration and passed only to the GitHub client,
  which sends it as `Authorization: Bearer` in GET requests to `https://api.github.com` (an origin fixed in the code;
  paths are built from parsed parts, never taken from a response), with `redirect: "manual"`, so it cannot follow a
  redirect elsewhere. It is never in a URL, a body, an answer or a log line. Its least scope: a fine-grained personal
  access token whose resource owner is the owner, with repository access to the repositories to translate (public
  ones only, or the private ones too) and the repository permission **Pull requests: Read-only**; GitHub adds
  **Metadata: Read-only** to every fine-grained token. Getting a pull request takes Pull requests or Contents read
  (https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens),
  and Pull requests is the narrower: it does not read code. The search names no permission and returns only what the
  token can read (https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests); `GET /user` names
  none either. A classic token would need `repo` for private repositories, which also writes, so it is refused.
  _Enforced (main):_ `createGitHubClient` in `worker/src/github.ts`, `parseScheduledConfig` in
  `worker/src/scheduled-config.ts`; `worker/src/scheduled.test.ts` ("KEY-5": every GitHub request is a GET to
  api.github.com with the token in its `Authorization` header only and `redirect: "manual"`, the provider request
  carries none of it, and log lines carry no token, key, repository or text). _Pinned by behavior; and by source
  analysis, forbidden pattern:_ `src/lib/source-analysis.test.ts` refuses `GITHUB_TOKEN` under `worker/src` outside
  `worker/src/scheduled-config.ts` and `worker/src/env.d.ts`. It is set with `wrangler secret put` only: the deployment
  script refuses any variable but the schedule's filter and choice, so the token cannot be deployed as a plain-text
  variable, and invocation logs are off (KEY-4). _Enforced (main):_ `mergeDeployConfig` in
  `worker/scripts/deploy-config.ts`; `worker/src/deploy-config.test.ts` ("KEY-5": `GITHUB_TOKEN` and
  `PRIVATE_REPOSITORIES` as variables are refused). _Pinned by behavior._ _Gap: the token's scope is set in GitHub's
  settings, which no test checks; [operations.md](operations.md#the-github-token) says what to grant._

### Messages (MSG)

- **MSG-1: the background acts only on this extension's own messages, of known shapes.** It ignores a message whose
  sender is not this extension, and parses every message with `MessageSchema` before acting; an unknown or malformed
  message gets no answer. _Enforced (main):_ `createMessageHandler` in `src/lib/message-handler.ts`, `MessageSchema` in
  `src/lib/messages.ts`, the listener in `src/entrypoints/background.ts`. _Pinned by behavior:_
  `src/lib/message-handler.test.ts` ("MSG-1": a message from another sender or none, of an unknown type, of a malformed
  shape or not an object calls neither the translation nor the options and gets no answer; a valid message dispatches;
  a translation that throws answers `api-error`) and `src/lib/messages.test.ts` ("MSG-1": the schema's accepted and
  refused shapes). _And by source analysis, required pattern:_ `src/lib/source-analysis.test.ts` requires that
  `src/entrypoints/background.ts` registers one `onMessage` listener, `createMessageHandler`, with
  `runtimeId: browser.runtime.id`, the wiring no test runs.

### Privacy (PRIV)

- **PRIV-1: a private repository is translated only when the owner listed it.** A repository counts as public only
  when GitHub's page says so explicitly (`octolytics-dimension-repository_public` is `true`); anything else needs an
  entry in the options. The check is repeated right before a request is sent, so a click that lands after GitHub moved
  to another pull request sends nothing. _Enforced (main):_ `#allowed` and `#stillAllowed` in `src/lib/controller.ts`,
  `isPublicRepository` in `src/lib/pr-page.ts`; `src/lib/controller.test.ts` ("PRIV-1": a private repository with and
  without the listing, and a navigation before the next sync). _Pinned by behavior._ On request, the Worker translates
  what the authenticated owner's extension sends (AUTH-1) and relies on the extension's check: it has no list of its
  own and does not ask GitHub. The ahead-of-time translation reads repositories itself, so the Worker checks each pull
  request's repository from the REST API's `base.repo.private` before translating or storing: only `false` counts as
  public, and anything else (true, or a missing field, which fails the schema) needs the repository in the Worker's
  `PRIVATE_REPOSITORIES` secret, compared without case. That list is the Worker's own and is separate from the
  extension's options. The CEL filter runs only after this check and after the author check, so it can narrow but not
  widen either. _Enforced (main):_ `processItem` in `worker/src/scheduled.ts`, `parseScheduledConfig` in
  `worker/src/scheduled-config.ts`; `worker/src/scheduled.test.ts` ("PRIV-1": a private repository unlisted and
  listed, a repository without the field, and a filter of `true || repo.private` that still skips a private
  repository and another author's pull request). _Pinned by behavior._
- **PRIV-2: only the pull request's title and description are sent.** Comments, reviews, code blocks and everything
  else on the page stay out of the request; inline code, mentions, references and autolinked URLs inside the
  description travel as markers, not as text. _Enforced (main):_ `findTitles` and `findBody` in `src/lib/pr-page.ts`,
  `extractSegments` in `src/lib/segments.ts`; `src/lib/controller.test.ts` ("PRIV-2": the exact segments sent) and
  `src/lib/segments.test.ts` ("PRIV-2": code blocks are skipped, inline code and mentions become markers). _Pinned by
  behavior._
- **PRIV-3: requests ask the provider not to keep them.** Gemini and Responses API requests set `store: false`.
  DeepSeek documents that it does not support `store` and always answers `store: false`; that says nothing about how
  long it keeps requests, which is not verified (see the accepted risks). _Enforced (main):_ `buildRequestBody` in
  `src/lib/gemini.ts`, `buildResponsesBody` in `src/lib/responses.ts`; `src/lib/gemini.test.ts` and
  `src/lib/responses.test.ts` ("PRIV-3"). _Pinned by behavior._

### Resources and cost (RES)

- **RES-1: a request is bounded.** At most 40,000 characters of source text per request, and a 120-second timeout.
  The Worker's translate route also refuses a body over 256 KiB (`MAX_BODY_BYTES`): a declared length over it before
  reading, and a stream once it passes it, whatever the declared length; then the body's schema, the choice
  (`parseChoice`) and the source length are checked before any lookup or provider call. _Enforced (main):_
  `readJsonBody` in `worker/src/body.ts`, `handleTranslate` in `worker/src/translate.ts`; `worker/src/translate.test.ts`
  ("RES-1": a declared length and an endless stream over the limit, malformed bodies and choices, and too much text are
  refused before any provider call or statement). And in the extension: `MAX_SOURCE_CHARACTERS` and `sourceTooLong` in `src/lib/translation.ts`, `TIMEOUT_MS` in
  `src/lib/gemini.ts` and `src/lib/responses.ts`, and 130 seconds for the Worker (`TIMEOUT_MS` in
  `src/lib/worker-client.ts`, longer than the Worker's own provider call); `src/lib/translation.test.ts` ("RES-1": the limit counts every
  segment), `src/lib/gemini.test.ts` and `src/lib/responses.test.ts` ("RES-1": too much text is refused before any
  request). _Pinned by behavior._ _Gap: the timeout is not exercised by a test._
- **RES-2: one request per pull request, text version and model.** Translations are cached by the hash of their
  segments together with the provider, model and thinking level that made them, so another choice translates again
  instead of answering an older provider's translation; callers that ask while the same request is in flight share it; the cache keeps at most 5 MB, newest first, and a
  failed cache write still answers the translation. The local cache is asked before the Worker, and a Worker's
  translation is cached the same way. _Enforced (main):_ `createTranslateService` in
  `src/lib/translate-service.ts`, `store` in `src/lib/cache.ts`; `src/lib/translate-service.test.ts` ("RES-2"). _Pinned
  by behavior._ The Worker stores translations in D1 under the same key (pull request, `hashSegments`, `choiceKey`) and
  answers a stored one without a provider call; a failed translation is not stored, a failed store still answers, and a
  row that does not fit the segments is a miss. It keeps one text version per pull request and choice, the one whose
  request started last: storing a version deletes those requested earlier, and a version requested earlier than one
  already stored is dropped, in one batch, so a slow translation of older text never replaces newer text. A tab still
  showing the older text asks again and is translated again. _Enforced (main):_ `createTranslationStore` in
  `worker/src/translations-db.ts`, `handleTranslate` in `worker/src/translate.ts`, `worker/migrations/`;
  `worker/src/translate.test.ts` ("RES-2": a miss translates once and stores, a hit does not call the provider, another
  choice or edited segments translate again, an older version that finishes after a newer one is not stored over it, a
  provider error is not written). The schedule's sweep deletes translations stored more than 90 days ago, rows the
  table would otherwise keep for pull requests nobody opens again; one read later is translated again on request.
  `sweep` in `worker/src/scheduled-db.ts`; `worker/src/scheduled.test.ts` (a run deletes old translations, versions,
  expired abandoned claims and daily counts, and keeps recent rows and live claims). _Gap: two isolates that miss at once both translate; the Worker has no
  in-flight sharing across isolates._
- **RES-3: the Worker spends only on authenticated requests, within a budget.** Authentication (AUTH-1) runs before any
  model call or database query; every SQL value is bound; scheduled translations have a daily cap; AI Gateway sets the
  model budget and rate. _Enforced (main)_ for authentication first and bound values: `createHandler` in
  `worker/src/handler.ts` routes only after AUTH-1, and every statement in `worker/src/translations-db.ts` is a constant
  with `?` placeholders run with `bind`; `worker/src/translate.test.ts` ("RES-3": an unauthenticated request, or a
  refused body, prepares no statement and calls no provider; values with quotes are stored and read back through
  bound statements). _Pinned by behavior; and by source analysis, forbidden pattern:_
  `src/lib/source-analysis.test.ts` refuses, under `worker/src`, a `prepare` of anything but an upper-case constant,
  SQL in a template with `${}` or joined to a value with `+`, and D1's `exec`. The rule is a heuristic over the text,
  not a parse: an upper-case constant built from a value would pass it, so the behavior tests are the pin and the rule
  only catches the common shapes. _Enforced (main)_ for the schedule's bounds: a run reads one search page of at most
  30 pull requests (`MAX_PULLS_PER_RUN`) and translates at most 5 versions (`MAX_TRANSLATIONS_PER_RUN`); the schedule
  makes at most 50 provider calls a UTC day (`MAX_PROVIDER_CALLS_PER_DAY`), counted in D1 by one conditional statement
  before each call, so overlapping runs share the cap; a version costs at most 3 calls (`MAX_ATTEMPTS`), and a call
  not made at the cap costs none. A run that reaches a cap stops and the next resumes. A version is claimed in D1
  before its call and looked up again once claimed, so an overlapping or retried run does not translate it again; a
  failed call is not stored and is retried later. A version is done only when its translation is stored, or dropped
  because a version fetched later is stored (versions are ordered by when their pull request was fetched); a done
  version whose translation is missing later is claimed again within the same attempts. The cursor moves only past
  pull requests a run finished with, forward only; the first run's bound is written before its search; and more pull
  requests than a page with one update time are read by creation time across runs before the cursor leaves that
  second, so a run that fails or stops part way loses nothing. `runScheduled`, `nextCursor` and `processItem` in
  `worker/src/scheduled.ts`, `createScheduledStore` in `worker/src/scheduled-db.ts`, `worker/migrations/`;
  `worker/src/scheduled.test.ts` ("RES-3": the run cap and the daily cap stop runs and the next resumes, a call never
  made costs no attempt, a provider error is retried up to the cap and then given up, overlapping runs translate once,
  a run that claims a version stored meanwhile does not call the provider, a run that read older text and finishes
  late does not replace the newer version, a failure part way leaves the cursor and its claim expires, a search out
  of time leaves the cursor and the first run's bound, more results than a page, and more than a page with one update
  time). _Pinned by behavior._ A model budget in AI Gateway: _Planned (2)._

### Worker access (AUTH)

- **AUTH-1: the Worker answers only the owner's extension.** Cloudflare Access rejects requests without the service
  token, and the Worker also verifies the `Cf-Access-Jwt-Assertion` header with `jose` against the Access team's keys,
  so a request that reaches the Worker another way is refused. Every request is verified before routing: the token's
  RS256 signature against the keys published at `<team domain>/cdn-cgi/access/certs` (cached by jose's remote key set),
  its `iss` (the team domain), its `aud` (the application's tag) and its `exp`, which must be present. A request without
  the header is answered 401 and one with any other token 403, with a fixed body that does not say why; keys that cannot
  be fetched refuse too. Missing or malformed settings (the team domain must be `https://<team>.cloudflareaccess.com`)
  refuse every request with 500 before a token is read. _Enforced (main):_ `verifyAccess` and `remoteKeys` in
  `worker/src/auth.ts`, `parseConfig` in `worker/src/config.ts`, `createHandler` in `worker/src/handler.ts`, wired in
  `worker/src/index.ts`; `worker/src/auth.test.ts` ("AUTH-1": a valid token passes; a missing or empty header, another
  audience or issuer, an expired token, one without `exp`, another key's signature, an unsigned token and a non-JWT are
  refused; the keys are fetched once from the team's certs URL, and a failed fetch refuses) and
  `worker/src/handler.test.ts` ("AUTH-1": refusals come before routing, on any path and method, with fixed answers; bad
  settings refuse without reading the token) and `worker/src/index.test.ts` ("AUTH-1": the deployed entry point, with
  the keys fetched through the runtime's `fetch` from the team's certs URL only, answers a valid token 200, no token
  401, another key's token 403 and an unknown route 404, and refuses without settings). The tests run in the Workers
  runtime with keys made locally and Access settings bound by `worker/vitest.config.ts`, over any `.dev.vars`. _Pinned
  by behavior._ The deployed Worker has no way in that Access does not cover: `workers_dev` and `preview_urls` are false
  in `worker/wrangler.jsonc`, and the deployment file may set only the custom domain (every route on one host, no
  wildcard), the account, the database id and the schedule's variables, never those settings. _Enforced (main):_
  `worker/wrangler.jsonc`, `mergeDeployConfig` and `parseDeployArgs` in `worker/scripts/deploy-config.ts`, run by
  `worker/scripts/deploy.mjs`; `worker/src/deploy-config.test.ts` ("AUTH-1": the public configuration has neither URL;
  a deployment file setting them, a wildcard or second host, or a wrangler option that replaces the configuration is
  refused). _Pinned by behavior._ _Gap: the Access application and its service-token policy are
  dashboard settings no test checks; the Worker accepts any token Access issued for the application, so the policy
  decides who that is (the owner's service token only). That the application covers the whole custom domain is checked
  after deployment ([operations.md](operations.md#deploy))._

### Repository wiki (WIKI)

- **WIKI-1: only trusted sources write the wiki.** The wiki is written from the default branch's content and from the
  owner's own merged pull requests. A session that translates anyone else's pull request has no tool that writes.
  _Planned (3)._
- **WIKI-2: the agent can read the repository and write only the wiki.** Its tools list, read and search files of the
  one repository the Durable Object serves, read a pull request's diff, read the wiki, and (in ingesting sessions only)
  write wiki pages. Tool inputs are Valibot schemas, paths stay inside that repository, and no tool runs a shell, code,
  or an arbitrary request. _Planned (3)._
- **WIKI-3: every glossary entry names its source.** An entry cites the file, document or pull request it came from;
  the weekly lint lists entries without one and entries that contradict each other. Hand edits arrive through the
  Worker's import route, behind AUTH-1. _Planned (3)._

### Supply chain (SUP)

- **SUP-1: dependencies and tools are pinned.** Exact versions in `package.json`, a lockfile, a three-day minimum
  release age, the `mise.lock` checksums, and GitHub Actions pinned by commit SHA. Pi Durable and the Agents SDK are
  pinned exactly and updated by hand. Security mechanisms use established libraries (`jose` for JWTs). _Enforced
  (main):_ `package.json`, `worker/package.json`, `pnpm-workspace.yaml`, `mise.toml`, `mise.lock`,
  `.github/workflows/`. _Pinned by configuration._
- **SUP-2: a committed secret is caught before it is merged.** A secret scan runs before each commit where the
  lefthook hooks are installed, and in CI on every pull request and push to `main` (the shared security workflow). CI
  finds a secret only after it is pushed; the key is then revoked, not just removed. _Enforced (main):_ `lefthook.yml`, `.github/workflows/security.yml`. _Pinned by
  configuration._

## IDs to check by change type

- **Segment extraction, markers or the controls:** DOM-1, DOM-3, PRIV-2. Keep the source analysis for HTML sinks and
  the DOM-3 parity tests on both sides passing.
- **Selectors or page detection:** DOM-2, PRIV-1, PRIV-2.
- **A provider client or the prompt:** KEY-2, PRIV-3, RES-1. Check where the key goes and what is sent.
- **Settings or storage:** KEY-1, KEY-4, RES-2.
- **The extension's Worker client or its fallback:** KEY-4, KEY-2, RES-1, RES-2.
- **Messages between the content script and the background:** MSG-1.
- **The Worker (2):** AUTH-1, KEY-2, KEY-3, KEY-4, KEY-5, PRIV-1, DOM-3, RES-1 to RES-3. Keep the Worker's source analysis passing.
- **The Worker's configuration or deployment script:** AUTH-1 (no way in outside Access), KEY-4 and KEY-5 (no
  invocation logs, no secret as a variable), and no deployment value (A10) committed.
- **The agent, its tools or the wiki (3):** WIKI-1 to WIKI-3, KEY-3, DOM-1 (its output is still a model's output).
- **A new dependency or workflow:** SUP-1, SUP-2. Prefer a maintained, widely used library over custom security code,
  and record its version, age and license in the PR.

## Accepted risks

| Risk                                                                                                                                                                                           | Why accepted                                                                                                                                                                                          | Revisit when                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| The scheduled path orders versions by when their fetch started, and reads a tied second by creation time (RES-2, RES-3)                                                                        | Out-of-order answers from GitHub or more than a page of pull requests sharing both seconds cost a translation on request or a second translation, never a wrong one                                   | the schedule translates for more than one owner                                |
| A content script path the KEY-1 behavior test does not run (a click, a settings change) could read `storage.local` in bulk, where the API keys and the service token are                       | Content scripts run in an isolated world the page cannot reach; the content script neither imports the secret items nor names their storage keys, and its load and first sync are checked by behavior | stage 2 moves the keys off the extension                                       |
| While the Worker cannot be reached, the extension sends the text to the provider directly with its local key (KEY-4)                                                                           | It is what the extension did before the Worker, with the same checks (PRIV-1, KEY-2); the owner opts out by leaving the local keys empty                                                              | KEY-3 removes the local keys                                                   |
| The service token is a long-lived secret in the browser profile                                                                                                                                | A compromised profile is out of scope; the token opens only the Worker, and it is revoked from the Access dashboard                                                                                   | Access offers a shorter-lived credential for the extension                     |
| A pull request can steer its own translation with instructions aimed at the model (R1)                                                                                                         | The output is only text shown to the owner (DOM-1); a wrong translation is visible next to the original                                                                                               | translations are used for anything but reading                                 |
| Public pull request text is sent to the model provider (R5)                                                                                                                                    | It is public already                                                                                                                                                                                  | never                                                                          |
| The free Gemini tier may use requests to improve Google's products                                                                                                                             | Private repositories are opt-in (PRIV-1), and the owner chooses the key's project                                                                                                                     | the owner translates private repositories with Gemini                          |
| DeepSeek's retention and use of API requests is not verified; `store: false` is not supported there (PRIV-3)                                                                                   | Private repositories stay opt-in for every provider (PRIV-1); DeepSeek is the default for public pull requests                                                                                        | the owner lists private repositories while DeepSeek is chosen                  |
| The GitHub token is a long-lived secret on Cloudflare that reads the owner's pull requests, private ones included (KEY-5)                                                                      | A Worker secret, never logged or answered; fine-grained and read-only, scoped by the owner to the repositories to translate, with an expiry; a compromised Cloudflare account is out of scope         | GitHub offers a narrower credential for one user's pull requests               |
| A repository listed in the Worker's `PRIVATE_REPOSITORIES` is translated ahead of time whatever the extension's options list (PRIV-1)                                                          | Both lists are the owner's own settings; the Worker cannot read the extension's                                                                                                                       | the lists are kept in one place                                                |
| Before the first deployment, the first `wrangler secret put` creates the Worker as wrangler's placeholder script, whose `workers.dev` URL may be on until the deployment turns it off (AUTH-1) | The placeholder's code reads no binding or secret and answers no data; the first deployment follows the secrets ([operations.md](operations.md#secrets))                                              | wrangler can set secrets on a Worker that does not exist without a placeholder |
| GitHub's markup changes break the selectors                                                                                                                                                    | The extension then translates nothing; it does not fall back to wider selectors                                                                                                                       | never                                                                          |

## How to use

- **PRs** list the invariant IDs they touch, and the status changes they make to this file.
- **Reviews:** the security lens of a review checks the IDs listed for the change type above, plus anything this model
  is missing.
- **Tests** name the invariant in the test name or a comment (for example `// DOM-1`), so `grep -rn 'DOM-1' src` shows
  its coverage.
- This document covers security and privacy only. It is not a correctness or design checklist.
