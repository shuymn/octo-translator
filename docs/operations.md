# Operating the octo-translator Worker

How to set up and deploy the Worker, check its schedule and logs, rotate its credentials, and point the extension at
it. The security invariants these steps keep are in [threat-model.md](threat-model.md) (AUTH-1, KEY-2, KEY-4, KEY-5,
PRIV-1, RES-3).

Values in angle brackets are placeholders: `<WORKER_HOST>` is the Worker's custom domain (for example
`translate.example.com`), `<DATABASE_ID>` the D1 database's id, `<TEAM>` the Cloudflare Access team name. None of them
is written in this repository.

Commands run from the repository root, with the tools from `mise.toml`: `npx wrangler` below means
`pnpm --filter octo-translator-worker exec wrangler`, and `<MERGED>` means `.wrangler/deploy-config/wrangler.json`, the
merged configuration `pnpm run deploy` writes (relative to `worker/`, where wrangler runs).

## What runs

- The Worker `octo-translator`, on the custom domain `<WORKER_HOST>` behind a Cloudflare Access application. It answers
  `GET /v1/ping` and `POST /v1/translate`, each only after verifying the Access JWT (AUTH-1).
- The D1 database bound as `DB`, which holds the stored translations and the schedule's state (`worker/migrations/`).
- A cron trigger every 15 minutes (`triggers.crons` in `worker/wrangler.jsonc`) that translates the owner's own pull
  requests ahead of time (`worker/src/scheduled.ts`).

The Worker has no `workers.dev` URL and no preview URLs (`workers_dev` and `preview_urls` are false): the custom domain,
behind Access, is the only way in.

## One-time setup

### The D1 database

Create it **before the first deployment**, and keep its id for the deployment file:

```sh
npx wrangler d1 create octo-translator --no-update-config
```

`--no-update-config` keeps wrangler from writing the new database into `worker/wrangler.jsonc`, a tracked file: run
without it, `d1 create` asks whether to add the binding and answers yes by default. Put the printed id only into the
deployment file. `pnpm run deploy` refuses a deployment file without a `database_id`, so wrangler never provisions a
database of its own either. The deployment applies the migrations.

### The Access application and its service token

In the Cloudflare dashboard (Zero Trust):

1. **Access controls > Service credentials > Service Tokens > Create Service Token.** Choose a duration (for example a
   year) and copy the client id and the client secret: the secret is shown only once. They go into the extension's
   options (below) and nowhere else (KEY-1, KEY-4).
2. **Access controls > Applications > Add an application > Self-hosted**, on `<WORKER_HOST>` with no path, so the
   whole host is covered. Add one policy with the action **Service Auth** that includes the service token from step 1,
   and no other policy: the Worker accepts any token Access issues for the application (AUTH-1), so the policy decides
   who that is.
3. From the application's overview, copy its **Application Audience (AUD) tag**. The team domain is
   `https://<TEAM>.cloudflareaccess.com` (Zero Trust settings, under the team name).

The custom domain must be in a zone of the same account. Every route in the deployment file must be on `<WORKER_HOST>`;
`pnpm run deploy` refuses a wildcard host and a second host, which the application would not cover.

### The GitHub token

Create a fine-grained personal access token (GitHub **Settings > Developer settings > Personal access tokens >
Fine-grained tokens**) whose resource owner is you, with an expiry, repository access to the repositories to translate
(public ones only, or the private ones too), and the repository permission **Pull requests: Read-only**; GitHub adds
**Metadata: Read-only** itself. Grant nothing else, and do not use a classic token (KEY-5).

### Secrets

Secrets are set with `wrangler secret put` only, never in a file of this repository or the deployment file. Write the
deployment file (below) and run `pnpm --filter octo-translator-worker run deploy --dry-run` first, so `<MERGED>` names
the Worker and the account. Each command prompts for the value:

```sh
npx wrangler secret put ACCESS_TEAM_DOMAIN --config <MERGED>   # https://<TEAM>.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD --config <MERGED>           # the application's AUD tag
npx wrangler secret put DEEPSEEK_API_KEY --config <MERGED>     # each provider key is optional (KEY-2)
npx wrangler secret put OPENAI_API_KEY --config <MERGED>
npx wrangler secret put GEMINI_API_KEY --config <MERGED>
npx wrangler secret put GITHUB_TOKEN --config <MERGED>         # the fine-grained token (KEY-5)
npx wrangler secret put PRIVATE_REPOSITORIES --config <MERGED> # owner/repo, comma-separated; empty means none (PRIV-1)
```

`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are required (`secrets.required` in `worker/wrangler.jsonc`): `wrangler deploy`
fails while either is missing. Before the first deployment the Worker does not exist yet; the first `secret put` asks to
create it, as a placeholder script that answers nothing useful, and the first deployment replaces it and turns its
`workers.dev` URL off. Run the first deployment right after setting the secrets.

## The deployment file

`worker/wrangler.jsonc` holds what is the same for every deployment: the bindings, the cron, the migrations directory,
the compatibility date and the logging settings. The deployment values are in `worker/wrangler.deploy.jsonc`, which git
ignores:

```sh
cp worker/wrangler.deploy.example.jsonc worker/wrangler.deploy.jsonc
```

Then replace every value:

| Key                         | Value                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `account_id`                | The Cloudflare account id (32 hex characters). Leave the key out to use wrangler's default   |
| `routes`                    | The custom domain: `[{ "pattern": "<WORKER_HOST>", "custom_domain": true }]`                 |
| `d1_databases`              | `[{ "binding": "DB", "database_id": "<DATABASE_ID>" }]`, the id `wrangler d1 create` printed |
| `vars.AHEAD_OF_TIME_FILTER` | Optional: the schedule's CEL filter (`worker/src/filter.ts`); empty means every pull request |
| `vars.AHEAD_OF_TIME_CHOICE` | Optional: `provider/model/thinking` for the schedule; empty means the extension's default    |

`worker/scripts/deploy.mjs` refuses any other key, any other variable (a secret's name among them), a route that is not
on one lowercase host without a wildcard, a malformed id, and a filter or choice the Worker would refuse, so the file
cannot change the bindings, the cron, the compatibility settings or the logging settings, nor turn on the `workers.dev`
URL. The variables it sets are all the Worker's variables: a deployment removes any variable set elsewhere, for example
in the dashboard. Secrets are never removed by a deployment.

## Deploy

```sh
# Checks and merges the files, writes <MERGED>, prints the wrangler commands and stops before any of them.
pnpm --filter octo-translator-worker run deploy --dry-run
# Applies the remote D1 migrations, checks that none is pending, then deploys.
pnpm --filter octo-translator-worker run deploy
```

The script merges the deployment file into `wrangler.jsonc`, writes the result to
`worker/.wrangler/deploy-config/wrangler.json` (ignored by git), runs `wrangler d1 migrations apply DB --remote`,
`wrangler d1 migrations list DB --remote` and `wrangler deploy`, all with `--config` on that file, and stops at the
first failure. `wrangler d1 migrations apply` lists the migrations and asks before applying them; answering no exits
with status 0 and leaves them pending, so the script deploys only when `migrations list` then reports
`No migrations to apply!`. Otherwise it stops before deploying, and the Worker keeps running the previous version. The script accepts only `--dry-run` and `--profile <name>`
(given to every wrangler command); it refuses any other option, since wrangler's options (`--var`, `--route`,
`--triggers`, `--compatibility-date`, `--config`, `--env`, `--secrets-file`, ...) could replace what the files hold.

After the first deployment:

1. Check with the service token that the Worker answers:
   `curl -sS https://<WORKER_HOST>/v1/ping -H 'CF-Access-Client-Id: <id>' -H 'CF-Access-Client-Secret: <secret>'`
   answers 200; without the headers, Access refuses the request. Keep the secret out of shell history.
2. In the dashboard's **Workers & Pages > octo-translator > Settings > Domains & Routes**, only the custom domain is
   listed: no `workers.dev` route and no preview URLs.
3. Fill in the extension's options (below).

## The extension

In the extension's options, Worker section:

- **Worker URL:** `https://<WORKER_HOST>`, the origin only, no path.
- **Client id** and **client secret:** the service token's.

Save, and allow the extension to connect to that origin when Chrome asks (KEY-4). Leave the provider keys empty to
never translate outside the Worker; otherwise the extension translates with them while the Worker cannot be reached.

## Schedule and logs (KEY-4, KEY-5)

Workers Logs keep the Worker's `console` output, which only `logEvent` writes: an `octo.*` event with a reason code,
an error's name or counts (`worker/src/log.ts`). The settings are in `worker/wrangler.jsonc` under `observability`:

- `enabled: true` keeps that output for the plan's retention (3 days on Workers Free, 7 on Workers Paid).
- `logs.invocation_logs: false` turns off the log Cloudflare writes for each invocation. Cloudflare's Workers Logs
  documentation says an invocation log "contains details such as the Request, Response, and related metadata" without
  listing the fields; the tail handler's documentation describes the request headers as redacted by heuristics
  ("subject to false positives and negatives"). Requests to the Worker carry the Access JWT (`Cf-Access-Jwt-Assertion`)
  and may carry the service token, so invocation logs are turned off rather than trusted to redact them.

Uncaught exceptions are still logged; the Worker's code catches its failures and logs only their names.

To check the schedule:

1. The Worker's settings in the dashboard list the cron trigger `*/15 * * * *`, with its past runs.
2. In the Worker's **Observability** view, each run logs `{"event":"octo.scheduled.run",...}` with its counts. A run
   that cannot start logs `octo.scheduled.config.invalid` with a reason (for example `missing-github-token`,
   `invalid-filter`, `no-api-key`); the other `octo.scheduled.*` events name a failed step.
3. The logs of a translate request and of a run hold only `octo.*` lines, with no request URL, header or body.

## Rotation

- **Service token:** rotate its secret in **Access controls > Service credentials > Service Tokens** (the client id
  stays; the old secret can stay valid for a grace period), or refresh it to extend its expiry. Enter the new secret in
  the extension's options. To replace the token, create a new one, add it to the application's policy, update the
  options, then remove the old token from the policy and revoke it. Nothing changes on the Worker.
- **Provider keys and the GitHub token:** create the new one, run `npx wrangler secret put <NAME> --config <MERGED>`
  (it deploys a new version with the new value at once), check the next run's `octo.scheduled.run` line, then revoke the
  old one at the provider or on GitHub. Renew the GitHub token before it expires: an expired token stops the schedule
  with `octo.scheduled.github.failed`.
- **Access settings:** a new application or team means new `ACCESS_AUD` or `ACCESS_TEAM_DOMAIN` secrets; until both
  match, the Worker refuses every request (AUTH-1).
- **A leaked secret:** revoke it at its issuer first (Access, the provider, GitHub), then set the new one.
