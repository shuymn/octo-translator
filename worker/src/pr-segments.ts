/**
 * DOM-3: the segments the extension would send for a pull request, made from GitHub's REST API instead of the page, so
 * a translation made ahead of time is stored under the hash the page asks with. The extraction is the extension's own
 * (`extractPullRequestSegments` in `src/lib/segments.ts`), run on linkedom instead of the browser's DOM.
 *
 * DOM-1: this is the only place the Worker parses HTML, and what it parses is GitHub's `body_html`, GitHub's own
 * sanitized rendering of the description (https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request, the
 * `application/vnd.github.html+json` and `full+json` media types). The title is raw text and is built with
 * `createTextNode`; a model's output never comes here. The tree is only read: nothing parsed here is serialized,
 * stored or shown.
 */
import { parseHTML } from "linkedom/worker";
import {
  extractPullRequestSegments,
  toSourceSegments,
  type TreeElement,
  type TreeNode,
} from "../../src/lib/segments.ts";
import type { SourceSegment } from "../../src/lib/translation.ts";

/** The fields of GitHub's pull request object this reads. */
export type PullRequestSource = { title: string; body_html: string };

/**
 * The part of linkedom's document used here. linkedom's declarations implement the DOM lib's interfaces
 * (`implements globalThis.Document`) and its `parseHTML` returns `Window & typeof globalThis`; the Worker's TypeScript
 * has no DOM lib (it would declare a global `document` the runtime does not have, and clash with the Workers types), so
 * those declarations do not resolve. `parseDocument` states what the module uses, in the structural types the
 * extraction takes, and the tests run it in workerd.
 */
type ParsedDocument = {
  readonly body: TreeElement;
  createElement(tagName: string): TreeElement & { append(...nodes: TreeNode[]): void };
  createTextNode(data: string): TreeNode;
};
const parseDocument: (html: string) => { document: ParsedDocument } = parseHTML;

/** The segments, title first, exactly as the extension's page controller sends them for this pull request. */
export function pullRequestSegments(source: PullRequestSource): SourceSegment[] {
  // A whole document: linkedom makes a fragment's first element the document element instead of filling the body. The
  // body stands for the page's `.comment-body`, whose children are this same HTML; the root's own tag is not read.
  const { document } = parseDocument(`<!doctype html><html><head></head><body>${source.body_html}</body></html>`);
  return toSourceSegments(extractPullRequestSegments(renderTitle(document, source.title), document.body));
}

/**
 * The title as GitHub's page renders it (`.markdown-title`): text, with code spans (`` `x` ``) as `<code>` elements and
 * nothing else rendered; a reference such as `#12` stays text. Code spans follow CommonMark's rule: a run of backticks
 * closes at the next run of the same length, and one without a match stays as written
 * (https://spec.commonmark.org/0.31.2/#code-spans). A code span becomes a marker, so only where it starts and ends
 * matters; its text is kept as written. Built from text nodes, never parsed.
 */
function renderTitle(document: ParsedDocument, title: string): TreeElement {
  const element = document.createElement("span");
  const appendText = (text: string) => {
    if (text !== "") element.append(document.createTextNode(text));
  };
  const runs = /`+/g;
  let index = 0;
  for (let open = runs.exec(title); open !== null; open = runs.exec(title)) {
    const close = closingRun(title, runs.lastIndex, open[0].length);
    if (close === undefined) continue;
    appendText(title.slice(index, open.index));
    const code = document.createElement("code");
    code.append(document.createTextNode(title.slice(runs.lastIndex, close)));
    element.append(code);
    index = close + open[0].length;
    runs.lastIndex = index;
  }
  appendText(title.slice(index));
  return element;
}

/** Where the next run of exactly `length` backticks from `from` starts, if any. */
function closingRun(title: string, from: number, length: number): number | undefined {
  const runs = /`+/g;
  runs.lastIndex = from;
  for (let run = runs.exec(title); run !== null; run = runs.exec(title)) {
    if (run[0].length === length) return run.index;
  }
  return undefined;
}
