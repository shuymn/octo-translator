// GitHub's rules for owner and repository names: letters, digits, hyphens, and for repositories also dots and
// underscores.
const REPOSITORY = /^[a-z\d](?:[a-z\d-]*[a-z\d])?\/[\w.-]+$/i;

export type RepositoryListResult = { ok: true; repositories: string[] } | { ok: false; line: number };

// Reads one `owner/repo` per line, ignoring blank lines, into lowercase names without duplicates.
export function parseRepositoryList(text: string): RepositoryListResult {
  const repositories = new Set<string>();
  const lines = text.split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "") continue;
    if (!REPOSITORY.test(line)) return { ok: false, line: index + 1 };
    repositories.add(line.toLowerCase());
  }
  return { ok: true, repositories: [...repositories] };
}
