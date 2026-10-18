// The scheduled translation's CEL filter, run in the Workers runtime (workerd): `@marcbachmann/cel-js` parses, type
// checks and evaluates there. PRIV-1: the filter only narrows; `scheduled.test.ts` pins that it never widens.
import { describe, expect, test } from "vitest";
import { compileFilter, type FilterInput } from "./filter.ts";

const INPUT: FilterInput = {
  repo: { owner: "example-org", name: "project", full_name: "example-org/project", private: false },
  pr: {
    number: 12,
    title: "Add the cache",
    draft: false,
    labels: ["translate", "docs"],
    base: "main",
    updated_at: Date.parse("2026-10-18T03:00:00Z"),
  },
};

function run(expression: string, input: FilterInput = INPUT) {
  const compiled = compileFilter(expression);
  if (!compiled.ok) return compiled;
  return compiled.filter(input);
}

describe("the filter", () => {
  test("an empty or blank expression passes every pull request", () => {
    expect(run("")).toEqual({ ok: true, pass: true });
    expect(run("  \n")).toEqual({ ok: true, pass: true });
  });

  test.each([
    ['repo.owner == "example-org"', true],
    ['repo.full_name == "example-org/other"', false],
    ['repo.name.startsWith("pro")', true],
    ["!repo.private", true],
    ["pr.number == 12", true],
    ["pr.number > 12", false],
    ['pr.title.contains("cache")', true],
    ["pr.draft", false],
    ['"translate" in pr.labels', true],
    ['"skip" in pr.labels', false],
    ['pr.labels.exists(l, l.startsWith("doc"))', true],
    ['pr.base == "main" && !pr.draft', true],
    ['pr.updated_at >= timestamp("2026-10-01T00:00:00Z")', true],
    ['pr.updated_at < timestamp("2026-10-01T00:00:00Z")', false],
  ])("%s is %s", (expression, pass) => {
    expect(run(expression)).toEqual({ ok: true, pass });
  });

  test.each([
    ["a syntax error", "repo.owner =="],
    ["an unknown variable", 'user.login == "x"'],
    ["an unknown field", 'repo.visibility == "public"'],
    ["a type error", 'pr.number == "12"'],
    ["a non-bool result", "pr.title"],
    ["an expression over the size bound", Array.from({ length: 400 }, () => "true").join(" && ")],
  ])("%s does not compile", (_, expression) => {
    expect(compileFilter(expression)).toEqual({ ok: false, code: "invalid-filter" });
  });

  test("an evaluation error fails closed", () => {
    expect(run('pr.labels[5] == "x"')).toEqual({ ok: false, code: "evaluation-failed" });
  });
});
