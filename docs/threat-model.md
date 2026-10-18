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
  permission and host access to the model providers' APIs only (DeepSeek, OpenAI, Gemini).
- Today the background calls the model provider directly with the owner's API key. From stage 2, it calls the owner's
  Worker instead, which holds the provider keys and a GitHub token with read access to the owner's repositories.
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
| A2  | Model provider API keys (Gemini, DeepSeek, OpenAI)                       | A leaked key spends the owner's money until revoked                                                      |
| A3  | The GitHub token (stage 2 on)                                            | It reads the owner's private repositories                                                                |
| A4  | Text of private repositories and pull requests                           | Sending it to a provider discloses it to that provider, and the free tiers may train on it               |
| A5  | The repository wiki, above all its glossary (stage 3)                    | Every later translation of the repository uses it; a planted entry misleads translations for a long time |
| A6  | Cost: model tokens, Cloudflare requests, Durable Object time and storage | The owner pays                                                                                           |

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

| Entry point                                         | Reached by | Trusted after                                                 | Status and code                                                                                    |
| --------------------------------------------------- | ---------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| The pull request's title and description in the DOM | R1         | never; read as text, sent as data                             | main: `src/lib/pr-page.ts`, `src/lib/segments.ts`                                                  |
| Model responses                                     | R2         | schema check, then marker check per segment (DOM-1)           | main: `src/lib/responses.ts`, `src/lib/gemini.ts`, `src/lib/translation.ts`, `src/lib/segments.ts` |
| Runtime messages to the background                  | R3         | sender is this extension, schema check (MSG-1)                | main: `src/entrypoints/background.ts`, `src/lib/messages.ts`                                       |
| Responses from the background to the content script | R3         | schema check                                                  | main: `src/entrypoints/github.content.ts`                                                          |
| The options page                                    | owner      | form validation; the provider choice by `parseChoice`         | main: `src/entrypoints/options/`, `src/lib/providers.ts`                                           |
| Worker routes                                       | R4         | Cloudflare Access, then the Access JWT (AUTH-1)               | Planned (2)                                                                                        |
| Scheduled GitHub search and pull request bodies     | R1         | never; read as text                                           | Planned (2)                                                                                        |
| Agent tools and the wiki                            | R1, R2     | tools are read-only except the wiki writer (WIKI-1, WIKI-2)   | Planned (3)                                                                                        |
| Build, CI and dependency updates                    | R6         | lockfile, release age, exact versions, pinned Actions (SUP-1) | main: `package.json`, `pnpm-workspace.yaml`, `.github/workflows/`                                  |

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
  `setHTMLUnsafe` family in every non-test file under `src`.
- **DOM-2: the content script runs only on github.com.** Its only match pattern is `https://github.com/*`, and it acts
  only on a pull request's Conversation tab. _Enforced (main):_ `matches` in `src/entrypoints/github.content.ts`;
  `parsePullRequestPath` in `src/lib/pr-page.ts`. _Pinned by configuration._
- **DOM-3: a translation made ahead of time is shown only for the exact segments it was made from.** The Worker keys
  stored translations by the SHA-256 of the segments; the extension asks with the hash of the segments it read from
  the page, and a mismatch falls back to translating on request. _Planned (2)._

### Credentials (KEY)

- **KEY-1: the API keys are kept in `storage.local` and read only by the background and the options page.** One key
  per provider; none is ever in `storage.sync` (which copies it to every signed-in browser), and the content script
  never reads one. It reads only the provider choice, to name the provider. The key items live in their own module,
  because WXT reads an item's value as soon as it is defined: importing the module at all reads every key. _Enforced
  (main):_ `apiKeyItems` in `src/lib/api-keys.ts`, imported only by `src/entrypoints/background.ts` and
  `src/entrypoints/options/main.ts`. _Pinned by behavior:_ `src/lib/content-script-storage.test.ts` ("KEY-1") loads
  the content script and everything it imports on WXT's fake browser, runs its `main` on a page, records every
  `storage.local` read, and fails on any key's storage name (taken from the items themselves) or a bulk read (`get()`,
  `get(null)`, `getKeys()`). _And by source analysis, forbidden pattern:_ `src/lib/source-analysis.test.ts` refuses
  `storage.sync` and `sync:` storage keys under `src`; refuses an import of `api-keys` (static, dynamic or re-export)
  outside those two files, and any reference to `apiKeyItems` (or `apiKeyItem`) outside them and
  `src/lib/api-keys.ts`; and refuses a key's storage name (any string ending in `apiKey`, such as `local:apiKey` or
  `local:deepseekApiKey`) outside `src/lib/api-keys.ts`. _Gap: the behavior test runs the load and the first sync, not
  a click, a settings change or a later navigation; the accepted risk below covers those paths._
- **KEY-2: a key travels only in a request header to its own provider.** Gemini's is sent as `x-goog-api-key` to the
  Gemini endpoint, DeepSeek's and OpenAI's as `Authorization: Bearer` to their Responses API endpoints; never in a URL
  or the body. Endpoints are constants per provider, not settings, and the extension's only host permissions are those
  three endpoints. _Enforced (main):_ `translateSegments` in `src/lib/gemini.ts`, `ENDPOINTS` and `translateResponses`
  in `src/lib/responses.ts`, `translateWith` in `src/lib/clients.ts`, `host_permissions` in `wxt.config.ts`;
  `src/lib/gemini.test.ts` and `src/lib/responses.test.ts` ("KEY-2": the URL has no key, the header has it) and
  `src/lib/clients.test.ts` ("KEY-2": each provider's request goes to that provider's endpoint). _Pinned by behavior._
- **KEY-3: from stage 2, provider keys and the GitHub token live only on Cloudflare.** They are Worker secrets or AI
  Gateway provider keys; the extension holds only the Access service token, and the agent receives neither keys nor
  the token, only tools that use them. _Planned (2)_ for the Worker, _Planned (3)_ for the agent.

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
  without the listing, and a navigation before the next sync). _Pinned by behavior._ The Worker applies the same list
  before translating or storing: _Planned (2)._
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
  _Enforced (main):_ `MAX_SOURCE_CHARACTERS` and `sourceTooLong` in `src/lib/translation.ts`, `TIMEOUT_MS` in
  `src/lib/gemini.ts` and `src/lib/responses.ts`; `src/lib/translation.test.ts` ("RES-1": the limit counts every
  segment), `src/lib/gemini.test.ts` and `src/lib/responses.test.ts` ("RES-1": too much text is refused before any
  request). _Pinned by behavior._ _Gap: the timeout is not exercised by a test._
- **RES-2: one request per pull request, text version and model.** Translations are cached by the hash of their
  segments together with the provider, model and thinking level that made them, so another choice translates again
  instead of answering an older provider's translation; callers that ask while the same request is in flight share it; the cache keeps at most 5 MB, newest first, and a
  failed cache write still answers the translation. _Enforced (main):_ `createTranslateService` in
  `src/lib/translate-service.ts`, `store` in `src/lib/cache.ts`; `src/lib/translate-service.test.ts` ("RES-2"). _Pinned
  by behavior._
- **RES-3: the Worker spends only on authenticated requests, within a budget.** Authentication (AUTH-1) runs before any
  model call or database query; every SQL value is bound; scheduled translations have a daily cap; AI Gateway sets the
  model budget and rate. _Planned (2)._

### Worker access (AUTH)

- **AUTH-1: the Worker answers only the owner's extension.** Cloudflare Access rejects requests without the service
  token, and the Worker also verifies the `Cf-Access-Jwt-Assertion` header with `jose` against the Access team's keys,
  so a request that reaches the Worker another way is refused. _Planned (2)._

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
  (main):_ `package.json`, `pnpm-workspace.yaml`, `mise.toml`, `mise.lock`, `.github/workflows/`. _Pinned by
  configuration._
- **SUP-2: a committed secret is caught before it is merged.** A secret scan runs before each commit where the
  lefthook hooks are installed, and in CI on every pull request and push to `main` (the shared security workflow). CI
  finds a secret only after it is pushed; the key is then revoked, not just removed. _Enforced (main):_ `lefthook.yml`, `.github/workflows/security.yml`. _Pinned by
  configuration._

## IDs to check by change type

- **Segment extraction, markers or the controls:** DOM-1, PRIV-2. Keep the source analysis for HTML sinks passing.
- **Selectors or page detection:** DOM-2, PRIV-1, PRIV-2.
- **A provider client or the prompt:** KEY-2, PRIV-3, RES-1. Check where the key goes and what is sent.
- **Settings or storage:** KEY-1, RES-2.
- **Messages between the content script and the background:** MSG-1.
- **The Worker (2):** AUTH-1, KEY-3, PRIV-1, DOM-3, RES-3.
- **The agent, its tools or the wiki (3):** WIKI-1 to WIKI-3, KEY-3, DOM-1 (its output is still a model's output).
- **A new dependency or workflow:** SUP-1, SUP-2. Prefer a maintained, widely used library over custom security code,
  and record its version, age and license in the PR.

## Accepted risks

| Risk                                                                                                                                               | Why accepted                                                                                                                                                                                       | Revisit when                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| A content script path the KEY-1 behavior test does not run (a click, a settings change) could read `storage.local` in bulk, where the API keys are | Content scripts run in an isolated world the page cannot reach; the content script neither imports the key items nor names their storage keys, and its load and first sync are checked by behavior | stage 2 moves the key off the extension                       |
| A pull request can steer its own translation with instructions aimed at the model (R1)                                                             | The output is only text shown to the owner (DOM-1); a wrong translation is visible next to the original                                                                                            | translations are used for anything but reading                |
| Public pull request text is sent to the model provider (R5)                                                                                        | It is public already                                                                                                                                                                               | never                                                         |
| The free Gemini tier may use requests to improve Google's products                                                                                 | Private repositories are opt-in (PRIV-1), and the owner chooses the key's project                                                                                                                  | the owner translates private repositories with Gemini         |
| DeepSeek's retention and use of API requests is not verified; `store: false` is not supported there (PRIV-3)                                       | Private repositories stay opt-in for every provider (PRIV-1); DeepSeek is the default for public pull requests                                                                                     | the owner lists private repositories while DeepSeek is chosen |
| GitHub's markup changes break the selectors                                                                                                        | The extension then translates nothing; it does not fall back to wider selectors                                                                                                                    | never                                                         |

## How to use

- **PRs** list the invariant IDs they touch, and the status changes they make to this file.
- **Reviews:** the security lens of a review checks the IDs listed for the change type above, plus anything this model
  is missing.
- **Tests** name the invariant in the test name or a comment (for example `// DOM-1`), so `grep -rn 'DOM-1' src` shows
  its coverage.
- This document covers security and privacy only. It is not a correctness or design checklist.
