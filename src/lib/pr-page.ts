// Where the pull request's title and description live in GitHub's DOM. GitHub changes its markup without notice, so
// every selector is here and nowhere else.
const SELECTORS = {
  // The page header's title and the sticky header's copy of it.
  title: '[data-component="PH_Title"] .markdown-title:not([data-octo-translator])',
  // The description is the first timeline comment, rendered inside the partial that serves the PR body.
  body: '[data-partial-name="pullRequestsConversationsRoute.Body"] .comment-body.markdown-body',
  // The description's header, relative to the description: the line with the author and the time, and the actions
  // around its "…" menu.
  comment: ".timeline-comment",
  commentHeading: ".timeline-comment-header h3 > div",
  commentActions: ".timeline-comment-header .timeline-comment-actions",
  repositoryPublic: 'meta[name="octolytics-dimension-repository_public"]',
} as const;

export type PullRequestRef = {
  owner: string;
  repo: string;
  number: number;
};

// Only the Conversation tab shows the description.
const CONVERSATION_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;

export function parsePullRequestPath(pathname: string): PullRequestRef | undefined {
  const match = CONVERSATION_PATH.exec(pathname);
  if (!match) return undefined;
  const [, owner, repo, number] = match;
  if (owner === undefined || repo === undefined || number === undefined) return undefined;
  return { owner, repo, number: Number(number) };
}

export function repositoryName(ref: PullRequestRef): string {
  return `${ref.owner}/${ref.repo}`.toLowerCase();
}

export function pullRequestKey(ref: PullRequestRef): string {
  return `${repositoryName(ref)}#${ref.number}`;
}

export function findTitles(doc: Document): HTMLElement[] {
  return [...doc.querySelectorAll<HTMLElement>(SELECTORS.title)];
}

export function findBody(doc: Document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(SELECTORS.body);
}

export type CommentHeader = { heading: Element | null; actions: Element | null };

export function findCommentHeader(body: HTMLElement): CommentHeader {
  const comment = body.closest(SELECTORS.comment);
  return {
    heading: comment?.querySelector(SELECTORS.commentHeading) ?? null,
    actions: comment?.querySelector(SELECTORS.commentActions) ?? null,
  };
}

// GitHub states the repository's visibility in a meta tag. Anything other than an explicit "true" counts as private,
// so a missing tag never sends a private description to the free tier.
export function isPublicRepository(doc: Document): boolean {
  return doc.querySelector(SELECTORS.repositoryPublic)?.getAttribute("content") === "true";
}
