// Turns rendered Markdown into plain-text segments the model can translate, and builds the translated nodes back.
//
// A segment is a run of inline content inside one block (a paragraph, a list item's text, a table cell). Inline
// elements become numbered markers instead of HTML: an element the model must not touch (code, a mention, an image) is
// `⟦n⟧`, and an element whose text is translated (a link, emphasis) is `⟦n⟧text⟦/n⟧`. The translated nodes are clones
// of the original elements with only their text replaced, so the model's output is never parsed as HTML.

import type { SegmentKind } from "./translation.ts";

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

type Slot = { kind: "keep"; node: ChildNode } | { kind: "wrap"; element: Element };

export type Segment = {
  kind: SegmentKind;
  // The nodes the segment replaces, in document order. They stay untouched so the original can be shown again.
  original: ChildNode[];
  // The text sent to the model, with markers for the inline elements.
  source: string;
  slots: Slot[];
  leadingSpace: string;
  trailingSpace: string;
};

export function extractSegments(root: Element): Segment[] {
  const segments: Segment[] = [];
  visitBlock(root, segments);
  return segments;
}

function visitBlock(block: Element, segments: Segment[]): void {
  let run: ChildNode[] = [];
  const flush = () => {
    const segment = toSegment(run, KINDS[block.tagName] ?? "paragraph");
    if (segment) segments.push(segment);
    run = [];
  };
  for (const child of block.childNodes) {
    if (child.nodeType === Node.TEXT_NODE || (isElement(child) && INLINE.has(child.tagName))) {
      run.push(child);
      continue;
    }
    flush();
    if (isElement(child) && !isSkippedBlock(child)) visitBlock(child, segments);
  }
  flush();
}

// The inline content of one element, such as the title, as a single segment.
export function extractInlineSegment(element: Element, kind: SegmentKind): Segment | undefined {
  return toSegment([...element.childNodes], kind);
}

function toSegment(run: ChildNode[], kind: SegmentKind): Segment | undefined {
  const slots: Slot[] = [];
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

function isKept(element: Element): boolean {
  if (KEPT_INLINE.has(element.tagName)) return true;
  // A link or emphasis around other elements (`<a><code>…</code></a>`) is kept whole.
  if (element.childElementCount > 0) return true;
  if (element.tagName !== "A") return false;
  if (REFERENCE_LINK_CLASSES.some((name) => element.classList.contains(name))) return true;
  // An autolinked URL reads the same in any language.
  return element.textContent?.trim() === element.getAttribute("href");
}

function isSkippedBlock(element: Element): boolean {
  return SKIPPED_BLOCKS.has(element.tagName) || SKIPPED_BLOCK_CLASSES.some((name) => element.classList.contains(name));
}

function isElement(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

// Builds the nodes for a translation, or answers undefined when the markers do not match the source: every kept slot
// exactly once, every wrapped slot opened and closed once with only text inside.
export function buildTranslatedNodes(segment: Segment, translation: string, doc: Document): ChildNode[] | undefined {
  // No text at all: the segment has prose, and nothing would be left in the page to swap the original back.
  if (translation.replaceAll(MARKER, "").trim() === "") return undefined;
  const nodes: ChildNode[] = [doc.createTextNode(segment.leadingSpace)];
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
  return nodes.filter((node) => node.nodeType !== Node.TEXT_NODE || node.textContent !== "");
}

// Hiragana or katakana: the text is already Japanese, so it is not sent.
export function isJapanese(text: string): boolean {
  return /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
}
