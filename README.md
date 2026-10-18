# octo-translator

A Chrome extension that translates the title and description of a GitHub pull request into Japanese, in place, keeping
GitHub's own markup and styles. It uses DeepSeek V4.1 Flash (`deepseek-flash`, without thinking) by default; OpenAI
and Gemini can be chosen in the options, with the model and thinking level.

- A button next to the description's "…" menu translates the title and description and switches back to the original.
- Code, code blocks, mentions, references and URLs stay as written; only the prose is translated.
- Translations are kept per pull request in the browser and requested again only when the text changes.
- Private repositories are not translated unless listed in the options, whichever provider is chosen. A provider may
  keep or train on what it is sent: the Gemini API free tier may use it to improve Google's products, and DeepSeek's
  handling of API requests has not been checked.

Security invariants and the threat model: [docs/threat-model.md](docs/threat-model.md).
Library choices, the planned stages and the patterns the code follows: [docs/decisions.md](docs/decisions.md).

## Use

1. Create an API key for the provider you use: [DeepSeek Platform](https://platform.deepseek.com/api_keys) (the
   default), [OpenAI Platform](https://platform.openai.com/api-keys) or
   [Google AI Studio](https://aistudio.google.com/apikey) (a Gemini key of a project without billing uses the free
   tier).
2. Build the extension (see below) and load `.output/chrome-mv3` from `chrome://extensions` with **Load unpacked**.
3. Open the extension's options, choose the provider, model and thinking level, paste the key, and choose whether to
   translate automatically. Each provider keeps its own key, so switching does not lose the others; a Gemini key saved
   by an earlier version is kept.

## Development

Tool versions come from `mise.toml`, with exact versions pinned in `mise.lock`.

```sh
mise install                # Node.js, pnpm and the workflow linters
pnpm install                # dependencies, then `wxt prepare` for the generated types
pnpm exec lefthook install  # git hooks (optional)
pnpm run dev                # Chrome with the extension, reloaded on change
pnpm run build              # .output/chrome-mv3
pnpm run lint               # oxlint with type-aware rules
pnpm run fmt                # oxfmt check (pnpm run fmt:fix to apply)
pnpm run typecheck          # TypeScript, the extension's and the Worker's
pnpm run test               # Vitest, the extension's and then the Worker's
```

### Worker

The Worker (stage 2) is a workspace package in `worker/`. It refuses every request without a valid Cloudflare Access
token (AUTH-1), so it needs the Access team domain and the application's audience tag even locally.

```sh
cp worker/.dev.vars.example worker/.dev.vars  # fill in the Access settings (git-ignored)
pnpm --filter octo-translator-worker run dev       # wrangler dev, local only
pnpm --filter octo-translator-worker run test      # Vitest in the Workers runtime
pnpm --filter octo-translator-worker run typecheck # checks the generated types are current, then TypeScript
pnpm --filter octo-translator-worker run types     # regenerate worker-configuration.d.ts after changing wrangler.jsonc
```

Locally, requests do not pass through Access, so `wrangler dev` answers 401 unless a request carries a token the
configured team signed.

The GitHub repository settings are declared in `.github/infra.yaml`; review them with `gh infra plan` and apply them
with `gh infra apply`.
