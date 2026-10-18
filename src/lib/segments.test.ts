import { describe, expect, test } from "vitest";
import { buildTranslatedNodes, extractInlineSegment, extractSegments, isJapanese } from "./segments.ts";

function render(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

function serialize(nodes: Node[]): string {
  const container = document.createElement("div");
  container.append(...nodes);
  return container.innerHTML;
}

describe("extractSegments", () => {
  test("PRIV-2: marks kept and wrapped inline elements", () => {
    const root = render(
      '<p>Fix <code>parse</code> in <a href="/docs">the docs</a>, thanks <a class="user-mention" href="/alice">@alice</a>.</p>',
    );
    const [segment] = extractSegments(root);
    expect(segment?.source).toBe("Fix ⟦0⟧ in ⟦1⟧the docs⟦/1⟧, thanks ⟦2⟧.");
  });

  test("splits a list item's text from its nested list", () => {
    const root = render("<ul><li>First item<ul><li>Nested item</li></ul></li></ul>");
    expect(extractSegments(root).map((segment) => segment.source)).toEqual(["First item", "Nested item"]);
  });

  test("PRIV-2: skips code blocks, highlighted blocks and text without letters", () => {
    const root = render(
      '<pre><code>const x = 1;</code></pre><div class="highlight"><pre>let y</pre></div><p>1234</p><p><code>only code</code></p>',
    );
    expect(extractSegments(root)).toEqual([]);
  });

  test("keeps an autolinked URL and a link around other elements", () => {
    const root = render(
      '<p>See <a href="https://example.com">https://example.com</a> or <a href="/x"><code>x</code></a>.</p>',
    );
    expect(extractSegments(root)[0]?.source).toBe("See ⟦0⟧ or ⟦1⟧.");
  });

  test("skips text that contains the marker characters", () => {
    expect(extractSegments(render("<p>a ⟦0⟧ b</p>"))).toEqual([]);
  });

  test("records what kind of block each segment comes from", () => {
    const root = render(
      "<h2>Summary</h2><p>Text.</p><ul><li>Item</li></ul><table><tr><td>Cell</td></tr></table><details><summary>More</summary>Hidden text</details>",
    );
    expect(extractSegments(root).map((segment) => [segment.kind, segment.source])).toEqual([
      ["heading", "Summary"],
      ["paragraph", "Text."],
      ["item", "Item"],
      ["cell", "Cell"],
      ["heading", "More"],
      ["paragraph", "Hidden text"],
    ]);
  });

  test("collapses whitespace and remembers the surrounding spaces", () => {
    const [segment] = extractSegments(render("<li>\n  Some\n  text  </li>"));
    expect(segment?.source).toBe("Some text");
    expect(segment?.leadingSpace).toBe("\n  ");
    expect(segment?.trailingSpace).toBe("  ");
  });
});

describe("buildTranslatedNodes", () => {
  const root = render('<p>Fix <code>parse</code> in <a href="/docs" class="x">the docs</a>.</p>');
  const segment = extractSegments(root)[0];
  if (!segment) throw new Error("no segment");

  test("clones the elements and replaces only the text", () => {
    const nodes = buildTranslatedNodes(segment, "⟦1⟧ドキュメント⟦/1⟧ の ⟦0⟧ を修正。", document);
    expect(nodes && serialize(nodes)).toBe('<a href="/docs" class="x">ドキュメント</a> の <code>parse</code> を修正。');
    // The original nodes are untouched.
    expect(root.innerHTML).toBe('<p>Fix <code>parse</code> in <a href="/docs" class="x">the docs</a>.</p>');
  });

  test("DOM-1: never parses the translation as HTML", () => {
    const nodes = buildTranslatedNodes(segment, "<img src=x onerror=alert(1)> ⟦0⟧ ⟦1⟧<b>x</b>⟦/1⟧", document);
    expect(nodes?.some((node) => node.nodeName === "IMG")).toBe(false);
    expect(nodes && serialize(nodes)).toContain("&lt;img");
  });

  test.each([
    ["a missing marker", "⟦0⟧ だけ"],
    ["a marker used twice", "⟦0⟧ ⟦0⟧ ⟦1⟧x⟦/1⟧"],
    ["an unknown marker", "⟦0⟧ ⟦1⟧x⟦/1⟧ ⟦2⟧"],
    ["an unclosed wrapper", "⟦0⟧ ⟦1⟧x"],
    ["a closed kept element", "⟦0⟧x⟦/0⟧ ⟦1⟧x⟦/1⟧"],
    ["a nested marker", "⟦1⟧x ⟦0⟧⟦/1⟧"],
    ["an empty translation", ""],
    ["markers without text", "⟦0⟧⟦1⟧ ⟦/1⟧"],
  ])("DOM-1: rejects %s", (_, translation) => {
    expect(buildTranslatedNodes(segment, translation, document)).toBeUndefined();
  });

  test("restores the surrounding spaces", () => {
    const [spaced] = extractSegments(render("<li> text </li>"));
    if (!spaced) throw new Error("no segment");
    const nodes = buildTranslatedNodes(spaced, "テキスト", document);
    expect(nodes?.map((node) => node.textContent).join("")).toBe(" テキスト ");
  });
});

test("extractInlineSegment reads an element's content as one segment", () => {
  const title = render("Fix <code>parse</code> crash");
  expect(extractInlineSegment(title, "title")?.source).toBe("Fix ⟦0⟧ crash");
});

test.each([
  ["バグを修正", true],
  ["カタカナ", true],
  ["漢字", false],
  ["Fix a bug", false],
])("isJapanese(%s) is %s", (text, expected) => {
  expect(isJapanese(text)).toBe(expected);
});
