# octo-translator

A Chrome extension that translates the title and description of a GitHub pull request into Japanese with Gemini
(`gemini-3.8-flash`), in place, keeping GitHub's own markup and styles.

- A button next to the description's "…" menu translates the title and description and switches back to the original.
- Code, code blocks, mentions, references and URLs stay as written; only the prose is translated.
- Translations are kept per pull request in the browser and requested again only when the text changes.
- Private repositories are not translated unless listed in the options. The Gemini API free tier may use what it is
  sent to improve Google's products.

Security invariants and the threat model: [docs/threat-model.md](docs/threat-model.md).
Library choices, the planned stages and the patterns the code follows: [docs/decisions.md](docs/decisions.md).

## Use

1. Create an API key in [Google AI Studio](https://aistudio.google.com/apikey). A key of a project without billing uses
   the free tier.
2. Build the extension (see below) and load `.output/chrome-mv3` from `chrome://extensions` with **Load unpacked**.
3. Open the extension's options, paste the key, and choose whether to translate automatically.

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
pnpm run typecheck          # TypeScript
pnpm run test               # Vitest
```

The GitHub repository settings are declared in `.github/infra.yaml`; review them with `gh infra plan` and apply them
with `gh infra apply`.
