import { expect, test } from "vitest";
import { parseRepositoryList } from "./repositories.ts";

test("reads one repository per line, in lowercase and without duplicates", () => {
  expect(parseRepositoryList("Owner/Repo\n\n  owner/repo  \nacme/my.repo_name\n")).toEqual({
    ok: true,
    repositories: ["owner/repo", "acme/my.repo_name"],
  });
});

test.each(["owner", "owner/repo/extra", "-owner/repo", "https://github.com/owner/repo"])("rejects %s", (line) => {
  expect(parseRepositoryList(`ok/repo\n${line}`)).toEqual({ ok: false, line: 2 });
});
