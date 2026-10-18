/**
 * Rules that must hold in every source file, including code no behavior test reaches ("How an invariant is pinned" in
 * docs/threat-model.md). Each rule is also run against small fixtures it must catch, so a pattern that silently stopped
 * matching fails here.
 */
import { describe, expect, test } from "vitest";

/**
 * Every non-test script under `src` and `worker/src`, in any module format Vite bundles, keyed by its path from the
 * repository root.
 */
const sources = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>(
      ["../**/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx}", "../../worker/src/**/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx}"],
      {
        query: "?raw",
        import: "default",
        eager: true,
      },
    ),
  )
    .map(([path, source]) => [fromRoot(path), source] as const)
    .filter(([path]) => !/\.test\.[cm]?[jt]sx?$/.test(path)),
);

/**
 * A glob key as a path from the repository root: this directory's files come as `./`, the rest of `src` as `../`, and
 * the Worker's as `../../worker/`.
 */
function fromRoot(path: string): string {
  if (path.startsWith("./")) return `src/lib/${path.slice(2)}`;
  if (path.startsWith("../../")) return path.slice(6);
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

type Rule = {
  readonly name: string;
  readonly pattern: RegExp;
  /** The directories the rule holds in. */
  readonly under: readonly string[];
  readonly allowed: readonly string[];
};

const EXTENSION = ["src/"];
const WORKER = ["worker/src/"];

// DOM-1: no API that parses a string as HTML.
const HTML_SINKS: Rule = {
  name: "an HTML sink",
  pattern:
    /\b(?:innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment|setHTMLUnsafe|parseHTMLUnsafe)\b|\bdocument\.write(?:ln)?\b/,
  // The Worker runs `src/lib` too, and walks `body_html` with a DOM (DOM-3).
  under: [...EXTENSION, ...WORKER],
  allowed: [],
};

// DOM-1, DOM-3: the Worker's HTML parser (linkedom, its `parseHTML` or its `DOMParser`, which HTML_SINKS refuses) is
// used only where GitHub's `body_html` is parsed. Nothing else, a model's output above all, is parsed as HTML.
const HTML_PARSER: Rule = {
  name: "the HTML parser outside the body_html module",
  pattern: /["'`]linkedom(?:\/[\w.-]+)?["'`]|\bparseHTML\b/,
  under: [...EXTENSION, ...WORKER],
  allowed: ["worker/src/pr-segments.ts"],
};

// KEY-1: nothing in storage.sync.
const SYNC_STORAGE: Rule = {
  name: "storage.sync",
  pattern: /\bstorage\.sync\b|["'`]sync:/,
  under: EXTENSION,
  allowed: [],
};

// KEY-1: the secret items (API keys, the Worker's service token) are used only where a secret is needed.
const API_KEY_ITEM: Rule = {
  name: "the secret items",
  pattern: /\b(?:apiKeyItems?|workerAccessItem)\b/,
  under: EXTENSION,
  allowed: ["src/lib/api-keys.ts", "src/entrypoints/background.ts", "src/entrypoints/options/main.ts"],
};

// KEY-1: the module of the key items is imported only where a key is needed. WXT reads an item when it is defined, so
// importing the module at all reads every key.
const API_KEY_MODULE: Rule = {
  name: "the API key module",
  pattern: /["'`](?:\.{1,2}\/)+(?:[\w-]+\/)*api-keys(?:\.[cm]?[jt]s)?["'`]/,
  under: EXTENSION,
  allowed: ["src/entrypoints/background.ts", "src/entrypoints/options/main.ts"],
};

// KEY-1: a secret's storage name (`apiKey`, `deepseekApiKey`, `workerAccess`, ...), which would read it without
// the item, appears only where the items are defined.
const API_KEY_NAME: Rule = {
  name: "a secret's storage name",
  pattern: /["'`](?:local:)?(?:\w*apikey|workeraccess)["'`]/i,
  under: EXTENSION,
  allowed: ["src/lib/api-keys.ts"],
};

// KEY-5: the GitHub token is read from the Worker's environment only by the schedule's configuration, which hands it
// to the GitHub client alone.
const GITHUB_TOKEN_SECRET: Rule = {
  name: "the GitHub token secret",
  pattern: /\bGITHUB_TOKEN\b/,
  under: WORKER,
  allowed: ["worker/src/scheduled-config.ts", "worker/src/env.d.ts"],
};

// RES-3: a statement is prepared only from a constant, so its values can only be bound.
const PREPARED_FROM_CONSTANT: Rule = {
  name: "a statement prepared from anything but a constant",
  pattern: /\.prepare\((?!\s*[A-Z][A-Z0-9_]*\s*,?\s*\))/,
  under: WORKER,
  allowed: [],
};

// RES-3: no SQL built with a template's `${}` or with `+` and a value.
const BUILT_SQL: Rule = {
  name: "SQL built from strings",
  pattern:
    /`(?=[^`]*\$\{)(?=[^`]*\b(?:select|insert|update|delete|replace|create|drop|alter|pragma|from|where|values)\s)[^`]*`|"[^"\n]*\b(?:select|insert|update|delete|replace|from|where|values|set)\b[^"\n]*"\s*\+(?!\s*["'`])|'[^'\n]*\b(?:select|insert|update|delete|replace|from|where|values|set)\b[^'\n]*'\s*\+(?!\s*["'`])/i,
  under: WORKER,
  allowed: [],
};

// RES-3: D1's `exec` runs SQL without bound values.
const UNBOUND_EXEC: Rule = {
  name: "D1 exec",
  pattern: /\b(?:db|DB|database)\s*\.\s*exec\(|\.exec\(\s*["'`]/,
  under: WORKER,
  allowed: [],
};

const RULES = [
  HTML_SINKS,
  HTML_PARSER,
  SYNC_STORAGE,
  API_KEY_ITEM,
  API_KEY_MODULE,
  API_KEY_NAME,
  GITHUB_TOKEN_SECRET,
  PREPARED_FROM_CONSTANT,
  BUILT_SQL,
  UNBOUND_EXEC,
];

/** The files that break a rule. */
function violations(rule: Rule, files: Readonly<Record<string, string>>): string[] {
  return Object.entries(files)
    .filter(
      ([path, source]) =>
        rule.under.some((directory) => path.startsWith(directory)) &&
        !rule.allowed.includes(path) &&
        rule.pattern.test(code(source)),
    )
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
        "worker/src/translations-db.ts",
        "worker/src/translate.ts",
        "worker/src/pr-segments.ts",
        "worker/src/scheduled-config.ts",
        "worker/src/env.d.ts",
      ]),
    );
  });

  test.each(RULES.map((rule) => [rule.name, rule] as const))(
    "no file breaks the rule on %s (DOM-1, DOM-3, KEY-1, KEY-5, RES-3)",
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
    for (const fixture of fixtures) {
      expect(violations(HTML_SINKS, { "src/x.ts": fixture, "worker/src/x.ts": fixture })).toEqual([
        "src/x.ts",
        "worker/src/x.ts",
      ]);
    }
    expect(violations(HTML_SINKS, { "src/x.ts": "// innerHTML is never used\nel.textContent = text;" })).toEqual([]);
    // A `/*` inside a string does not open a comment that hides the sink after it.
    const glob = 'const matches = ["https://github.com/*"];\nel.innerHTML = text;\n/* Update the status. */';
    expect(violations(HTML_SINKS, { "src/x.ts": glob })).toEqual(["src/x.ts"]);
  });

  test("DOM-1: catches the HTML parser outside the body_html module", () => {
    const fixtures = [
      'import { parseHTML } from "linkedom";',
      'import { parseHTML } from "linkedom/worker";',
      "const { DOMParser } = await import('linkedom/worker');",
      "const { document } = parseHTML(translation);",
    ];
    for (const fixture of fixtures) {
      expect(
        violations(HTML_PARSER, {
          "src/x.ts": fixture,
          "worker/src/translate.ts": fixture,
          "worker/src/pr-segments.ts": fixture,
        }),
      ).toEqual(["src/x.ts", "worker/src/translate.ts"]);
    }
    expect(violations(HTML_PARSER, { "worker/src/x.ts": "const html = source.body_html;" })).toEqual([]);
  });

  test("KEY-1: catches storage.sync, and the secret items, their module and storage names outside their files", () => {
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
        "src/lib/translate-service.ts": "await workerAccessItem.getValue();",
        "src/entrypoints/options/main.ts": "await workerAccessItem.getValue();",
      }),
    ).toEqual(["src/entrypoints/github.content.ts", "src/lib/controller.ts", "src/lib/translate-service.ts"]);
    expect(
      violations(API_KEY_NAME, {
        "src/entrypoints/github.content.ts": 'await browser.storage.local.get("apiKey");',
        "src/lib/controller.ts": 'await browser.storage.local.get("local:deepseekApiKey");',
        "src/lib/cache.ts": "storage.getItem(`local:openaiApiKey`);",
        "src/lib/api-keys.ts": 'storage.defineItem<string>("local:apiKey");',
        "src/lib/settings.ts": 'storage.defineItem<string>("local:openaiApiKey");',
        "src/entrypoints/options/main.ts": 'document.querySelector("#api-key");',
        "src/lib/worker-client.ts": 'browser.storage.local.get("workerAccess");',
        "src/lib/messages.ts": 'storage.getItem("local:workerAccess");',
        "src/entrypoints/options/index.ts": 'document.querySelector("#worker-client-secret");',
        "src/lib/worker-edits.ts": 'const FIELDS = ["url", "clientId", "clientSecret"] as const;',
        "src/lib/worker-client.test-helper.ts": 'headers.set("CF-Access-Client-Secret", value);',
      }),
    ).toEqual([
      "src/entrypoints/github.content.ts",
      "src/lib/controller.ts",
      "src/lib/cache.ts",
      "src/lib/settings.ts",
      "src/lib/worker-client.ts",
      "src/lib/messages.ts",
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

  test("KEY-5: catches the GitHub token read outside the schedule's configuration", () => {
    expect(
      violations(GITHUB_TOKEN_SECRET, {
        "worker/src/scheduled.ts": "const token = env.GITHUB_TOKEN;",
        "worker/src/translate.ts": 'const token = env["GITHUB_TOKEN"];',
        "worker/src/scheduled-config.ts": 'GITHUB_TOKEN: v.optional(v.string(), ""),',
        "worker/src/env.d.ts": "GITHUB_TOKEN?: string;",
        "worker/src/github.ts": "Authorization: `Bearer ${token}`,",
      }),
    ).toEqual(["worker/src/scheduled.ts", "worker/src/translate.ts"]);
  });

  test("RES-3: catches SQL built from strings, statements prepared from anything but a constant, and exec", () => {
    const built = [
      "const sql = `SELECT * FROM translations WHERE pr_key = '${key}'`;",
      "db.prepare(`DELETE FROM translations WHERE pr_key = ${key}`);",
      'const sql = "SELECT * FROM translations WHERE pr_key = \'" + key + "\'";',
      'const sql = "SELECT translations FROM translations " +\n  "WHERE pr_key = " + key;',
      "const sql = 'update translations set translations = ' + value;",
    ];
    for (const fixture of built)
      expect(violations(BUILT_SQL, { "worker/src/x.ts": fixture })).toEqual(["worker/src/x.ts"]);
    const literal = [
      'const SELECT = "SELECT translations FROM translations WHERE pr_key = ?";',
      'const UPSERT =\n  "INSERT INTO translations (a, b) VALUES (?, ?) " +\n  "ON CONFLICT (a) DO UPDATE SET b = excluded.b";',
      "console.error(`translations ${operation} failed`);",
    ];
    for (const fixture of literal) expect(violations(BUILT_SQL, { "worker/src/x.ts": fixture })).toEqual([]);

    const prepared = [
      "db.prepare(sql);",
      "db.prepare(`SELECT 1`);",
      'db.prepare("SELECT " + column);',
      "db.prepare(QUERIES[name]);",
    ];
    for (const fixture of prepared) {
      expect(violations(PREPARED_FROM_CONSTANT, { "worker/src/x.ts": fixture })).toEqual(["worker/src/x.ts"]);
    }
    expect(
      violations(PREPARED_FROM_CONSTANT, {
        "worker/src/a.ts": "db.prepare(SELECT_TRANSLATIONS).bind(key);",
        "worker/src/b.ts": "db.prepare( SELECT_TRANSLATIONS ).bind(key);",
        "worker/src/c.ts": "db\n  .prepare(\n    SELECT_TRANSLATIONS,\n  )\n  .bind(key);",
      }),
    ).toEqual([]);

    for (const fixture of ["await db.exec(sql);", 'await env.DB.exec("DELETE FROM translations");']) {
      expect(violations(UNBOUND_EXEC, { "worker/src/x.ts": fixture })).toEqual(["worker/src/x.ts"]);
    }
    expect(violations(UNBOUND_EXEC, { "worker/src/x.ts": "const match = /^\\d+$/.exec(value);" })).toEqual([]);

    // The Worker's rules hold in the Worker, not in the extension.
    expect(violations(PREPARED_FROM_CONSTANT, { "src/x.ts": "db.prepare(sql);" })).toEqual([]);
  });

  // The handler's checks are pinned by behavior in message-handler.test.ts; this pins the wiring no test runs.
  test("MSG-1: the background listens with the message handler and its own runtime id", () => {
    const background = code(sources["src/entrypoints/background.ts"] ?? "");
    expect(background).toMatch(/onMessage\.addListener\(\s*createMessageHandler\(/);
    expect(background).toMatch(/runtimeId:\s*browser\.runtime\.id\b/);
    expect(background.match(/onMessage\.addListener\(/g)).toHaveLength(1);
  });
});
