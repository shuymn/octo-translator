// DOM-3 parity fixtures: each shape GitHub renders in a pull request description, written twice, as the page's DOM
// holds it (read by the extension, in `segments.test.ts` with happy-dom) and as the REST API's `body_html` returns it
// (read by the Worker, in `worker/src/pr-segments.test.ts` with linkedom in workerd), with the segments both must
// produce. The text is synthetic.
//
// The two markups were compared on public pull requests, the API's `body_html` against the page's description both as
// served and after GitHub's scripts ran: the served HTML was byte for byte the same apart from signed image URLs, and the
// scripts add attributes (`data-catalyst`, `tabindex`) and the copy buttons of code blocks. The page variants below carry
// those additions.

import type { SourceSegment } from "./translation.ts";

export type PullRequestShape = {
  readonly name: string;
  // The title as the API returns it, and as the page renders it inside `.markdown-title`.
  readonly title: string;
  readonly pageTitle: string;
  readonly page: string;
  readonly api: string;
  readonly segments: readonly SourceSegment[];
  // `hashSegments` of the segments, written out so both runtimes are checked against the same digest.
  readonly hash: string;
};

const TITLE = { title: "Add the cache", pageTitle: "Add the cache" } as const;
const TITLE_SEGMENT: SourceSegment = { kind: "title", text: "Add the cache" };

const SVG_ICON =
  '<svg class="octicon octicon-info mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Z"></path></svg>';

const COPY_BUTTON =
  '<div class="zeroclipboard-container position-absolute right-0 top-0"><clipboard-copy aria-label="Copy" class="ClipboardButton btn js-clipboard-copy m-2 p-0" data-copy-feedback="Copied!" data-tooltip-direction="w" value="npm test" tabindex="0" role="button">' +
  SVG_ICON +
  "</clipboard-copy></div>";

const MENTION =
  '<a class="user-mention notranslate" data-hovercard-type="user" data-hovercard-url="/users/octo-dev/hovercard" data-octo-click="hovercard-link-click" href="https://github.com/octo-dev">@octo-dev</a>';
const ISSUE =
  '<a class="issue-link js-issue-link" data-error-text="Failed to load title" data-id="1" data-permission-text="Title is private" data-url="https://github.com/example/project/issues/12" data-hovercard-type="issue" data-hovercard-url="/example/project/issues/12/hovercard" href="https://github.com/example/project/issues/12">#12</a>';

const PARAGRAPH = `<p dir="auto">Read <code class="notranslate">config.ts</code> and <a href="https://example.com/guide" rel="nofollow">the guide</a>, as ${MENTION} asked in ${ISSUE}. It is <em>much</em> <strong>faster</strong> now; see <a href="https://example.com/x" rel="nofollow">https://example.com/x</a>.<br>
Second line &amp; more.</p>`;

const HEADINGS_API = `<h2 dir="auto">Summary</h2>
<h3 dir="auto">How it <code class="notranslate">works</code></h3>`;
// The anchor GitHub adds beside a heading where it links headings (rendered files); no pull request description seen
// had it, in the page or the API. Its only text is an attribute, so it adds no segment either way.
const HEADINGS_PAGE = `<div class="markdown-heading" dir="auto"><h2 tabindex="-1" class="heading-element" dir="auto">Summary</h2><a id="user-content-summary" class="anchor" aria-label="Permalink: Summary" href="#summary">${SVG_ICON}</a></div>
<div class="markdown-heading" dir="auto"><h3 tabindex="-1" class="heading-element" dir="auto">How it <code class="notranslate">works</code></h3><a id="user-content-how-it-works" class="anchor" aria-label="Permalink: How it works" href="#how-it-works">${SVG_ICON}</a></div>`;

const LISTS = `<ul dir="auto">
<li>First change</li>
<li>Second change
<ul dir="auto">
<li>A detail with <code class="notranslate">flag</code></li>
</ul>
</li>
</ul>
<ol dir="auto">
<li>Step one</li>
</ol>`;

const TASKS = `<ul class="contains-task-list">
<li class="task-list-item"><input type="checkbox" id="" disabled="" class="task-list-item-checkbox" aria-label="Completed task" checked=""> Tests pass</li>
<li class="task-list-item"><input type="checkbox" id="" disabled="" class="task-list-item-checkbox" aria-label="Incomplete task"> Docs updated</li>
</ul>`;

const table = (open: string, close: string) => `${open}
<thead>
<tr>
<th>Option</th>
<th>Default</th>
</tr>
</thead>
<tbody>
<tr>
<td><code class="notranslate">timeout</code></td>
<td>Two minutes</td>
</tr>
</tbody>
${close}`;

const CODE_API = `<pre class="notranslate"><code class="notranslate">npm test
</code></pre>
<div class="highlight highlight-source-ts notranslate position-relative overflow-auto" dir="auto" data-snippet-clipboard-copy-content="const value = load();"><pre class="notranslate"><span class="pl-k">const</span> <span class="pl-s1">value</span> <span class="pl-c1">=</span> <span class="pl-en">load</span><span class="pl-kos">(</span><span class="pl-kos">)</span><span class="pl-kos">;</span></pre></div>
<p dir="auto">After the code.</p>`;
const CODE_PAGE = `<div class="snippet-clipboard-content notranslate position-relative overflow-auto"><pre class="notranslate"><code class="notranslate">npm test
</code></pre>${COPY_BUTTON}</div>
<div class="highlight highlight-source-ts notranslate position-relative overflow-auto" dir="auto" data-snippet-clipboard-copy-content="const value = load();"><pre class="notranslate"><span class="pl-k">const</span> <span class="pl-s1">value</span> <span class="pl-c1">=</span> <span class="pl-en">load</span><span class="pl-kos">(</span><span class="pl-kos">)</span><span class="pl-kos">;</span></pre>${COPY_BUTTON}</div>
<p dir="auto">After the code.</p>`;

const image = (signature: string) => `<p dir="auto">Before:</p>
<p dir="auto"><a target="_blank" rel="noopener noreferrer" href="https://private-user-images.githubusercontent.com/1/2-screenshot.png?jwt=${signature}"><img src="https://private-user-images.githubusercontent.com/1/2-screenshot.png?jwt=${signature}" alt="screenshot" style="max-width: 100%;"></a></p>
<p dir="auto"><a target="_blank" rel="noopener noreferrer nofollow" href="https://camo.githubusercontent.com/abc/def"><img src="https://camo.githubusercontent.com/abc/def" alt="badge" data-canonical-src="https://example.com/badge.svg" style="max-width: 100%;"></a> Coverage badge</p>`;

const QUOTE = `<blockquote>
<p dir="auto">Quoted <em>reason</em> here.</p>
</blockquote>`;

const ALERT = `<div class="markdown-alert markdown-alert-note" dir="auto"><p class="markdown-alert-title" dir="auto">${SVG_ICON}Note</p><p dir="auto">Restart the server.</p>
</div>`;

const DETAILS = `<details>
<summary>More context</summary>
<p dir="auto">Hidden text.</p>
</details>`;

export const PULL_REQUEST_SHAPES: readonly PullRequestShape[] = [
  {
    name: "a paragraph with inline code, links, a mention, a reference, emphasis and an autolink",
    ...TITLE,
    page: PARAGRAPH,
    api: PARAGRAPH,
    hash: "103f887302afccafc90a0eede0c260195750c1fcf4e137afdcc478a3f0b2bb8a",
    segments: [
      TITLE_SEGMENT,
      {
        kind: "paragraph",
        text: "Read ⟦0⟧ and ⟦1⟧the guide⟦/1⟧, as ⟦2⟧ asked in ⟦3⟧. It is ⟦4⟧much⟦/4⟧ ⟦5⟧faster⟦/5⟧ now; see ⟦6⟧.⟦7⟧ Second line & more.",
      },
    ],
  },
  {
    name: "headings, with the page's anchors",
    ...TITLE,
    page: HEADINGS_PAGE,
    api: HEADINGS_API,
    hash: "c6ee91b9e993c309f31a4df378cfb25d28a75dbd3de6dfa59bb91c7eb1084ee5",
    segments: [TITLE_SEGMENT, { kind: "heading", text: "Summary" }, { kind: "heading", text: "How it ⟦0⟧" }],
  },
  {
    name: "lists and nested lists",
    ...TITLE,
    page: LISTS,
    api: LISTS,
    hash: "337d0ef32dc2fd54216f954e914d044fe91e3e8426de13c8b6ea07cccc60c05d",
    segments: [
      TITLE_SEGMENT,
      { kind: "item", text: "First change" },
      { kind: "item", text: "Second change" },
      { kind: "item", text: "A detail with ⟦0⟧" },
      { kind: "item", text: "Step one" },
    ],
  },
  {
    name: "a task list",
    ...TITLE,
    page: TASKS,
    api: TASKS,
    hash: "c94b63523eee65b26bb24a0805679afad60b4218273d755cc6367aaa042f94a5",
    segments: [TITLE_SEGMENT, { kind: "item", text: "⟦0⟧ Tests pass" }, { kind: "item", text: "⟦0⟧ Docs updated" }],
  },
  {
    name: "a table, with the page's attributes",
    ...TITLE,
    page: table(
      '<markdown-accessiblity-table data-catalyst=""><table role="table" tabindex="0">',
      "</table></markdown-accessiblity-table>",
    ),
    api: table('<markdown-accessiblity-table><table role="table">', "</table></markdown-accessiblity-table>"),
    hash: "bc9513821dcb99d23d337895e3d921b4cc9d0bdbfe00e3879ddc7102d53b11c7",
    segments: [
      TITLE_SEGMENT,
      { kind: "cell", text: "Option" },
      { kind: "cell", text: "Default" },
      { kind: "cell", text: "Two minutes" },
    ],
  },
  {
    name: "a code block and a highlighted block, with the page's copy buttons",
    ...TITLE,
    page: CODE_PAGE,
    api: CODE_API,
    hash: "5cd38a1c17e601c8cfb7af7ed96e61792fc9d55c3df5630da464526db1f28714",
    segments: [TITLE_SEGMENT, { kind: "paragraph", text: "After the code." }],
  },
  {
    name: "images, with other signed URLs on the page",
    ...TITLE,
    page: image("page-signature"),
    api: image("api-signature"),
    hash: "26502713feac6f36cd7a103d19bbea9af947a4e810171a75953d152f08bd1193",
    segments: [
      TITLE_SEGMENT,
      { kind: "paragraph", text: "Before:" },
      { kind: "paragraph", text: "⟦0⟧ Coverage badge" },
    ],
  },
  {
    name: "a blockquote",
    ...TITLE,
    page: QUOTE,
    api: QUOTE,
    hash: "7e421dcc4b3c7bc73f71b05e42941652a414eab16aebff84a0040ac5ac427006",
    segments: [TITLE_SEGMENT, { kind: "paragraph", text: "Quoted ⟦0⟧reason⟦/0⟧ here." }],
  },
  {
    name: "an alert, whose title carries an svg icon",
    ...TITLE,
    page: ALERT,
    api: ALERT,
    hash: "593070f4fc4dd22ae67de8be078e990e85bf68e46534b377b29502f8b8991cb6",
    segments: [
      TITLE_SEGMENT,
      { kind: "paragraph", text: "⟦0⟧Note" },
      { kind: "paragraph", text: "Restart the server." },
    ],
  },
  {
    name: "details and summary",
    ...TITLE,
    page: DETAILS,
    api: DETAILS,
    hash: "acfd974487eb1ed3021102df136926f1aa2c52b2d5376049dc5ded5d989c3516",
    segments: [TITLE_SEGMENT, { kind: "heading", text: "More context" }, { kind: "paragraph", text: "Hidden text." }],
  },
  {
    name: "a title with code spans, and one already in Japanese",
    title: "Fix `parse` for ``a`b`` and a lone ` tick",
    pageTitle: "Fix <code>parse</code> for <code>a`b</code> and a lone ` tick",
    page: '<p dir="auto">キャッシュを追加します。</p><p dir="auto">English text.</p>',
    api: '<p dir="auto">キャッシュを追加します。</p><p dir="auto">English text.</p>',
    hash: "bfc67d8a607dc80402b38f3046b1323366a52c246872742e28d6d1888450c3a0",
    segments: [
      { kind: "title", text: "Fix ⟦0⟧ for ⟦1⟧ and a lone ` tick" },
      { kind: "paragraph", text: "English text." },
    ],
  },
  {
    name: "a Japanese title and an empty description",
    title: "キャッシュを追加",
    pageTitle: "キャッシュを追加",
    page: "",
    api: "",
    hash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    segments: [],
  },
];

// A shape that cannot match: the page renders an emoji shortcode in the title as the emoji, and the API returns the
// shortcode. The Worker does not carry GitHub's emoji table, so such a pull request is translated on request (DOM-3's
// fallback).
export const EMOJI_TITLE = {
  title: ":sparkles: Add the cache",
  pageTitle: "✨ Add the cache",
} as const;
