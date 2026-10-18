/**
 * Rules that must hold in every source file, including code no behavior test reaches ("How an invariant is pinned" in
 * docs/threat-model.md). Each rule is also run against small fixtures it must catch, so a pattern that silently stopped
 * matching fails here.
 */
import { describe, expect, test } from "vitest";

/** Every non-test script under `src`, in any module format Vite bundles, keyed by its path from the repository root. */
const sources = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../**/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx}", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  )
    .map(([path, source]) => [fromRoot(path), source] as const)
    .filter(([path]) => !/\.test\.[cm]?[jt]sx?$/.test(path)),
);

/** A glob key as a path from the repository root: this directory's files come as `./`, the others as `../`. */
function fromRoot(path: string): string {
  if (path.startsWith("./")) return `src/lib/${path.slice(2)}`;
  if (path.startsWith("../")) return `src/${path.slice(3)}`;
  throw new Error(`unexpected glob key ${path}`);
}

/**
 * The code of a file without the comments that start a line. A `/*` or `//` after code on the same line stays, so one
 * inside a string (`"https://github.com/*"`) cannot hide the code after it; a trailing comment is only checked too.
 */
function code(source: string): string {
  return source.replaceAll(/^\s*\/\*[\s\S]*?\*\//gm, "").replaceAll(/^\s*\/\/.*$/gm, "");
}

type Rule = { readonly name: string; readonly pattern: RegExp; readonly allowed: readonly string[] };

// DOM-1: no API that parses a string as HTML.
const HTML_SINKS: Rule = {
  name: "an HTML sink",
  pattern:
    /\b(?:innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment|setHTMLUnsafe|parseHTMLUnsafe)\b|\bdocument\.write(?:ln)?\b/,
  allowed: [],
};

// KEY-1: nothing in storage.sync.
const SYNC_STORAGE: Rule = {
  name: "storage.sync",
  pattern: /\bstorage\.sync\b|["'`]sync:/,
  allowed: [],
};

// KEY-1: the API key items are used only where a key is needed.
const API_KEY_ITEM: Rule = {
  name: "the API key items",
  pattern: /\bapiKeyItems?\b/,
  allowed: ["src/lib/api-keys.ts", "src/entrypoints/background.ts", "src/entrypoints/options/main.ts"],
};

// KEY-1: the module of the key items is imported only where a key is needed. WXT reads an item when it is defined, so
// importing the module at all reads every key.
const API_KEY_MODULE: Rule = {
  name: "the API key module",
  pattern: /["'`](?:\.{1,2}\/)+(?:[\w-]+\/)*api-keys(?:\.[cm]?[jt]s)?["'`]/,
  allowed: ["src/entrypoints/background.ts", "src/entrypoints/options/main.ts"],
};

// KEY-1: a key's storage name (`apiKey`, `deepseekApiKey`, ...), which would read it without the item, appears only
// where the items are defined.
const API_KEY_NAME: Rule = {
  name: "an API key's storage name",
  pattern: /["'`](?:local:)?\w*apikey["'`]/i,
  allowed: ["src/lib/api-keys.ts"],
};

const RULES = [HTML_SINKS, SYNC_STORAGE, API_KEY_ITEM, API_KEY_MODULE, API_KEY_NAME];

/** The files that break a rule. */
function violations(rule: Rule, files: Readonly<Record<string, string>>): string[] {
  return Object.entries(files)
    .filter(([path, source]) => !rule.allowed.includes(path) && rule.pattern.test(code(source)))
    .map(([path]) => path);
}

describe("source analysis", () => {
  test("reads the sources", () => {
    // Guards against a glob that silently finds nothing.
    expect(Object.keys(sources)).toEqual(
      expect.arrayContaining([
        "src/lib/segments.ts",
        "src/entrypoints/background.ts",
        "src/entrypoints/options/main.ts",
      ]),
    );
  });

  test.each(RULES.map((rule) => [rule.name, rule] as const))(
    "no file breaks the rule on %s (DOM-1, KEY-1)",
    (_, rule) => {
      expect(violations(rule, sources)).toEqual([]);
    },
  );

  test("DOM-1: catches each HTML sink", () => {
    const fixtures = [
      "el.innerHTML = text;",
      "el.outerHTML = text;",
      'el.insertAdjacentHTML("beforeend", text);',
      'new DOMParser().parseFromString(text, "text/html");',
      "range.createContextualFragment(text);",
      "el.setHTMLUnsafe(text);",
      "Document.parseHTMLUnsafe(text);",
      "document.write(text);",
      "document.writeln(text);",
    ];
    for (const fixture of fixtures) expect(violations(HTML_SINKS, { "src/x.ts": fixture })).toEqual(["src/x.ts"]);
    expect(violations(HTML_SINKS, { "src/x.ts": "// innerHTML is never used\nel.textContent = text;" })).toEqual([]);
    // A `/*` inside a string does not open a comment that hides the sink after it.
    const glob = 'const matches = ["https://github.com/*"];\nel.innerHTML = text;\n/* Update the status. */';
    expect(violations(HTML_SINKS, { "src/x.ts": glob })).toEqual(["src/x.ts"]);
  });

  test("KEY-1: catches storage.sync, and the key items, their module and storage names outside their files", () => {
    expect(violations(SYNC_STORAGE, { "src/x.ts": "browser.storage.sync.set({ k: 1 });" })).toEqual(["src/x.ts"]);
    expect(violations(SYNC_STORAGE, { "src/x.ts": 'storage.defineItem("sync:apiKey");' })).toEqual(["src/x.ts"]);
    expect(violations(SYNC_STORAGE, { "src/x.ts": "// storage.sync would copy it\nconst url = 'https://x';" })).toEqual(
      [],
    );
    expect(
      violations(API_KEY_ITEM, {
        "src/entrypoints/github.content.ts": "await apiKeyItems.deepseek.getValue();",
        "src/lib/controller.ts": "await apiKeyItem.getValue();",
        "src/entrypoints/background.ts": "await apiKeyItems[provider].getValue();",
      }),
    ).toEqual(["src/entrypoints/github.content.ts", "src/lib/controller.ts"]);
    expect(
      violations(API_KEY_NAME, {
        "src/entrypoints/github.content.ts": 'await browser.storage.local.get("apiKey");',
        "src/lib/controller.ts": 'await browser.storage.local.get("local:deepseekApiKey");',
        "src/lib/cache.ts": "storage.getItem(`local:openaiApiKey`);",
        "src/lib/api-keys.ts": 'storage.defineItem<string>("local:apiKey");',
        "src/lib/settings.ts": 'storage.defineItem<string>("local:openaiApiKey");',
        "src/entrypoints/options/main.ts": 'document.querySelector("#api-key");',
      }),
    ).toEqual([
      "src/entrypoints/github.content.ts",
      "src/lib/controller.ts",
      "src/lib/cache.ts",
      "src/lib/settings.ts",
    ]);
    expect(
      violations(API_KEY_MODULE, {
        "src/entrypoints/github.content.ts": 'import { apiKeyItems } from "../lib/api-keys.ts";',
        "src/lib/settings.ts": 'export * from "./api-keys";',
        "src/lib/controller.ts": "const keys = await import(`./api-keys.js`);",
        "src/entrypoints/background.ts": 'import { apiKeyItems } from "../lib/api-keys.ts";',
        "src/entrypoints/options/main.ts": 'import { apiKeyItems } from "../../lib/api-keys.ts";',
        "src/lib/providers.ts": 'const url = "https://platform.openai.com/api-keys";',
      }),
    ).toEqual(["src/entrypoints/github.content.ts", "src/lib/settings.ts", "src/lib/controller.ts"]);
  });

  test("MSG-1: the background checks the sender and parses every message", () => {
    const background = code(sources["src/entrypoints/background.ts"] ?? "");
    expect(background).toMatch(/sender\.id\s*!==\s*browser\.runtime\.id/);
    expect(background).toMatch(/safeParse\(\s*MessageSchema\s*,/);
  });
});
