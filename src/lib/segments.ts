// Turns rendered Markdown into plain-text segments the model can translate, and builds the translated nodes back.
//
// A segment is a run of inline content inside one block (a paragraph, a list item's text, a table cell). Inline
// elements become numbered markers instead of HTML: an element the model must not touch (code, a mention, an image) is
// `⟦n⟧`, and an element whose text is translated (a link, emphasis) is `⟦n⟧text⟦/n⟧`. The translated nodes are clones
// of the original elements with only their text replaced, so the model's output is never parsed as HTML.
//
// The extension runs this on the page and the Worker on GitHub's `body_html` (DOM-3), each on its own DOM, so the module
// names only the parts of a node it uses (`TreeNode`, `TreeElement`) instead of the DOM lib's types, which the Worker
// does not have, and imports no DOM implementation: the caller passes the root in.

import type { SegmentKind, SourceSegment } from "./translation.ts";

const MARKER = /⟦(\/?)(\d+)⟧/g;
const MARKER_CHARACTERS = /[⟦⟧]/;

// Inline elements. Anything else is a block: its inline runs become segments and its blocks are visited in turn.
const INLINE = new Set([
  "A",
  "ABBR",
  "B",
  "BDI",
  "BDO",
  "BR",
  "CITE",
  "CODE",
  "DATA",
  "DEL",
  "DFN",
  "EM",
  "G-EMOJI",
  "I",
  "IMG",
  "INPUT",
  "INS",
  "KBD",
  "MARK",
  "MATH",
  "Q",
  "S",
  "SAMP",
  "SMALL",
  "SPAN",
  "STRONG",
  "SUB",
  "SUP",
  "SVG",
  "TIME",
  "U",
  "VAR",
  "WBR",
]);

// Inline elements kept as they are.
const KEPT_INLINE = new Set(["BR", "CODE", "G-EMOJI", "IMG", "INPUT", "KBD", "MATH", "SAMP", "SVG", "VAR", "WBR"]);

// Links GitHub generates for references: their text is a name or a number, not prose.
const REFERENCE_LINK_CLASSES = ["user-mention", "team-mention", "issue-link", "commit-link"];

// Blocks whose content is not prose.
const SKIPPED_BLOCKS = new Set(["PRE", "SCRIPT", "STYLE", "TEMPLATE", "TEXTAREA"]);
const SKIPPED_BLOCK_CLASSES = ["highlight", "js-render-enrichment-target"];

const KINDS: Record<string, SegmentKind> = {
  H1: "heading",
  H2: "heading",
  H3: "heading",
  H4: "heading",
  H5: "heading",
  H6: "heading",
  SUMMARY: "heading",
  LI: "item",
  DT: "item",
  TD: "cell",
  TH: "cell",
};

// `Node.ELEMENT_NODE` and `Node.TEXT_NODE`, which the DOM standard fixes; the Worker has no global `Node`.
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// What extraction reads of a node, and what building sets (`textContent` of a cloned element). The page's DOM and the
// Worker's both have these; `N` is the implementation's node type, so the page gets its own nodes back.
export type TreeNode = { readonly nodeType: number; textContent: string | null };
export type TreeElement<N extends TreeNode = TreeNode> = TreeNode & {
  readonly tagName: string;
  readonly childNodes: Iterable<N>;
  readonly childElementCount: number;
  readonly classList: { contains(token: string): boolean };
  getAttribute(name: string): string | null;
};
// What building the translated nodes needs of the document.
export type NodeFactory<N extends TreeNode> = {
  createTextNode(data: string): N;
  importNode<T extends N>(node: T, deep: boolean): T;
};

type Slot<N extends TreeNode> = { kind: "keep"; node: N } | { kind: "wrap"; element: N & TreeElement<N> };

export type Segment<N extends TreeNode = TreeNode> = {
  kind: SegmentKind;
  // The nodes the segment replaces, in document order. They stay untouched so the original can be shown again.
  original: N[];
  // The text sent to the model, with markers for the inline elements.
  source: string;
  slots: Slot<N>[];
  leadingSpace: string;
  trailingSpace: string;
};

export function extractSegments<N extends TreeNode>(root: TreeElement<N>): Segment<N>[] {
  const segments: Segment<N>[] = [];
  visitBlock(root, segments);
  return segments;
}

function visitBlock<N extends TreeNode>(block: TreeElement<N>, segments: Segment<N>[]): void {
  let run: N[] = [];
  const flush = () => {
    const segment = toSegment(run, KINDS[tagOf(block)] ?? "paragraph");
    if (segment) segments.push(segment);
    run = [];
  };
  for (const child of block.childNodes) {
    if (child.nodeType === TEXT_NODE || (isElement(child) && INLINE.has(tagOf(child)))) {
      run.push(child);
      continue;
    }
    flush();
    if (isElement(child) && !isSkippedBlock(child)) visitBlock(child, segments);
  }
  flush();
}

// The inline content of one element, such as the title, as a single segment.
export function extractInlineSegment<N extends TreeNode>(
  element: TreeElement<N>,
  kind: SegmentKind,
): Segment<N> | undefined {
  return toSegment([...element.childNodes], kind);
}

function toSegment<N extends TreeNode>(run: N[], kind: SegmentKind): Segment<N> | undefined {
  const slots: Slot<N>[] = [];
  let source = "";
  let prose = "";
  for (const node of run) {
    if (!isElement(node)) {
      source += node.textContent ?? "";
      prose += node.textContent ?? "";
    } else if (isKept(node)) {
      source += `⟦${slots.length}⟧`;
      slots.push({ kind: "keep", node });
    } else {
      const text = node.textContent ?? "";
      source += `⟦${slots.length}⟧${text}⟦/${slots.length}⟧`;
      prose += text;
      slots.push({ kind: "wrap", element: node });
    }
  }
  // Nothing to translate, or text that would be confused with the markers.
  if (!/\p{L}/u.test(prose) || MARKER_CHARACTERS.test(prose)) return undefined;
  const leadingSpace = /^\s*/.exec(source)?.[0] ?? "";
  const trailingSpace = /\s*$/.exec(source)?.[0] ?? "";
  return {
    kind,
    original: run,
    source: source.trim().replaceAll(/\s+/g, " "),
    slots,
    leadingSpace,
    trailingSpace,
  };
}

function isKept(element: TreeElement): boolean {
  if (KEPT_INLINE.has(tagOf(element))) return true;
  // A link or emphasis around other elements (`<a><code>…</code></a>`) is kept whole.
  if (element.childElementCount > 0) return true;
  if (tagOf(element) !== "A") return false;
  if (REFERENCE_LINK_CLASSES.some((name) => element.classList.contains(name))) return true;
  // An autolinked URL reads the same in any language.
  return element.textContent?.trim() === element.getAttribute("href");
}

function isSkippedBlock(element: TreeElement): boolean {
  return SKIPPED_BLOCKS.has(tagOf(element)) || SKIPPED_BLOCK_CLASSES.some((name) => element.classList.contains(name));
}

function isElement<N extends TreeNode>(node: N): node is N & TreeElement<N> {
  return node.nodeType === ELEMENT_NODE;
}

// The tag name in upper case. An HTML element's is upper case everywhere, but an `svg` or `math` element's is lower case
// in a browser (it is not in the HTML namespace) and upper case in the Worker's DOM, and a GitHub alert's title carries
// an `svg` icon, so the page and the Worker would split it differently (DOM-3).
function tagOf(element: TreeElement): string {
  return element.tagName.toUpperCase();
}

// Builds the nodes for a translation, or answers undefined when the markers do not match the source: every kept slot
// exactly once, every wrapped slot opened and closed once with only text inside.
export function buildTranslatedNodes<N extends TreeNode>(
  segment: Segment<N>,
  translation: string,
  doc: NodeFactory<N>,
): N[] | undefined {
  // No text at all: the segment has prose, and nothing would be left in the page to swap the original back.
  if (translation.replaceAll(MARKER, "").trim() === "") return undefined;
  const nodes: N[] = [doc.createTextNode(segment.leadingSpace)];
  const used = new Set<number>();
  let open: number | undefined;
  let last = 0;
  for (const match of translation.matchAll(MARKER)) {
    const closing = match[1] === "/";
    const index = Number(match[2]);
    const slot = segment.slots[index];
    const text = translation.slice(last, match.index);
    last = match.index + match[0].length;
    if (!slot) return undefined;
    if (closing) {
      if (open !== index) return undefined;
      if (slot.kind !== "wrap") return undefined;
      const element = doc.importNode(slot.element, false);
      element.textContent = text;
      nodes.push(element);
      open = undefined;
      continue;
    }
    if (open !== undefined) return undefined;
    if (used.has(index)) return undefined;
    used.add(index);
    nodes.push(doc.createTextNode(text));
    if (slot.kind === "keep") {
      nodes.push(doc.importNode(slot.node, true));
    } else {
      open = index;
    }
  }
  if (open !== undefined || used.size !== segment.slots.length) return undefined;
  nodes.push(doc.createTextNode(translation.slice(last)), doc.createTextNode(segment.trailingSpace));
  return nodes.filter((node) => node.nodeType !== TEXT_NODE || node.textContent !== "");
}

// Hiragana or katakana: the text is already Japanese, so it is not sent.
export function isJapanese(text: string): boolean {
  return /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
}

// The segments of a pull request as the extension sends them: the title's, then the description's, leaving out any that
// is already Japanese. The page controller and the Worker's ahead-of-time translation both take them from here, so the
// Worker stores a translation under the hash of the same segments the page asks with (DOM-3).
export type PullRequestSegments<N extends TreeNode> = { title: Segment<N> | undefined; body: Segment<N>[] };

export function extractPullRequestSegments<N extends TreeNode>(
  title: TreeElement<N> | undefined,
  body: TreeElement<N>,
): PullRequestSegments<N> {
  const titleSegment = title ? extractInlineSegment(title, "title") : undefined;
  return {
    title: titleSegment && !isJapanese(titleSegment.source) ? titleSegment : undefined,
    body: extractSegments(body).filter((segment) => !isJapanese(segment.source)),
  };
}

// The segments as they travel to the background, the Worker and the model, in the order the translations come back.
export function toSourceSegments(segments: PullRequestSegments<TreeNode>): SourceSegment[] {
  return [...(segments.title ? [segments.title] : []), ...segments.body].map((segment): SourceSegment => ({
    kind: segment.kind,
    text: segment.source,
  }));
}
