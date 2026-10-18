/**
 * The threat model and the tests agree: every invariant that docs/threat-model.md marks _Enforced (main)_ says how it
 * is pinned, cites test files that exist, and each cited file names the invariant's ID in a test name or a comment. An
 * ID in a test is how `grep -rn 'DOM-1' src` shows its coverage ("How to use" in the threat model).
 */
import { describe, expect, test } from "vitest";

const threatModel =
  import.meta.glob<string>("../../docs/threat-model.md", { query: "?raw", import: "default", eager: true })[
    "../../docs/threat-model.md"
  ] ?? "";

/** Every test file under `src` and `worker/src`, keyed by its path from the repository root. */
const testFiles = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>(["../**/*.test.ts", "../../worker/src/**/*.test.ts"], {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ).map(([path, source]) => [fromRoot(path), source]),
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

type Invariant = { readonly id: string; readonly text: string };

/** The invariants of the document: each `- **ID: ...**` bullet with its continuation lines, as one line. */
function invariants(document: string): Invariant[] {
  const found: Invariant[] = [];
  let current: { id: string; lines: string[] } | undefined;
  const close = () => {
    if (current !== undefined) found.push({ id: current.id, text: current.lines.join(" ").replaceAll(/\s+/g, " ") });
    current = undefined;
  };
  for (const line of document.split("\n")) {
    const start = /^- \*\*([A-Z]+-\d+):/.exec(line);
    if (start?.[1] !== undefined) {
      close();
      current = { id: start[1], lines: [line] };
    } else if (current !== undefined && /^\s+\S/.test(line)) {
      current.lines.push(line);
    } else {
      close();
    }
  }
  close();
  return found;
}

/** The test files an invariant's text cites, as paths from the repository root. */
function citedTests(text: string): string[] {
  return [...new Set([...text.matchAll(/`([^`\s]*\.test\.ts)`/g)].map((match) => match[1] ?? ""))];
}

/** `DOM-1` but not `DOM-10`. */
function namesId(source: string, id: string): boolean {
  return new RegExp(`\\b${id}(?!\\d)`).test(source);
}

// How an enforced part is pinned ("How an invariant is pinned" in the threat model). Behavior and source analysis are
// tests, so an invariant pinned by either cites at least one test file; one pinned by configuration only may cite none.
const PINNED_BY_TEST = /Pinned by (?:behavior|source analysis)/;
const PINNED_BY_CONFIGURATION = /Pinned by configuration/;

/** Problems with the citations of every invariant marked _Enforced (main)_. */
function citationProblems(document: string, files: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  for (const { id, text } of invariants(document)) {
    // A status cut off from its bullet (a blank line inside the item) would otherwise skip the invariant silently.
    if (!/Planned \(\d\)/.test(text) && !text.includes("Enforced (main)")) problems.push(`${id}: has no status`);
    if (!text.includes("Enforced (main)")) continue;
    const cited = citedTests(text);
    if (PINNED_BY_TEST.test(text)) {
      if (cited.length === 0) problems.push(`${id}: cites no test`);
    } else if (!PINNED_BY_CONFIGURATION.test(text)) {
      problems.push(`${id}: does not say how it is pinned`);
    }
    for (const path of cited) {
      const source = files[path];
      if (source === undefined) problems.push(`${id}: ${path} does not exist`);
      else if (!namesId(source, id)) problems.push(`${id}: ${path} does not name ${id}`);
    }
  }
  return problems;
}

describe("the threat model's citations of tests", () => {
  test("reads the threat model and the test files", () => {
    const enforced = invariants(threatModel).filter(({ text }) => text.includes("Enforced (main)"));
    // Guards against a parser that silently finds nothing to compare.
    expect(enforced.length).toBeGreaterThanOrEqual(10);
    expect(enforced.flatMap(({ text }) => citedTests(text)).length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(testFiles)).toEqual(
      // A glob leaves out the file that runs it, so this file is not among them.
      expect.arrayContaining([
        "src/lib/segments.test.ts",
        "src/lib/source-analysis.test.ts",
        "worker/src/auth.test.ts",
      ]),
    );
  });

  test("finds every cited test file, and the invariant's ID in it", () => {
    expect(citationProblems(threatModel, testFiles)).toEqual([]);
  });

  test("detects a missing file, a missing ID, no cited test, no way of pinning and no status", () => {
    const document = [
      "### Example (EX)",
      "",
      '- **EX-1: a rule.** _Enforced (main):_ `src/a.test.ts` ("EX-1") and `src/b.test.ts`. _Pinned by behavior._',
      "- **EX-2: another rule.** _Enforced (main):_ `src/missing.test.ts`. _Pinned by behavior._",
      '- **EX-3: a third rule.** _Enforced (main):_ `src/a.test.ts` ("EX-3"), but the file names EX-30. _Pinned by behavior._',
      "- **EX-4: a planned rule.** _Planned (2)._ `src/missing.test.ts`.",
      "- **EX-5: a rule over",
      "  two lines.** _Enforced",
      "  (main):_ `src/b.test.ts`. _Pinned by behavior._",
      "- **EX-6: a rule without a test.** _Enforced (main):_ `src/a.ts`. _Pinned by source analysis._",
      "- **EX-7: a configured rule.** _Enforced (main):_ `package.json`. _Pinned by configuration._",
      "- **EX-8: a rule that does not say.** _Enforced (main):_ `src/a.ts`.",
      "- **EX-9: a rule split by a blank line.**",
      "",
      "  _Enforced (main):_ `src/missing.test.ts`. _Pinned by behavior._",
      "",
    ].join("\n");
    expect(
      citationProblems(document, {
        "src/a.test.ts": "// EX-1, EX-30\n",
        "src/b.test.ts": "test('EX-1: works')\n",
      }),
    ).toEqual([
      "EX-2: src/missing.test.ts does not exist",
      "EX-3: src/a.test.ts does not name EX-3",
      "EX-5: src/b.test.ts does not name EX-5",
      "EX-6: cites no test",
      "EX-8: does not say how it is pinned",
      "EX-9: has no status",
    ]);
  });
});
