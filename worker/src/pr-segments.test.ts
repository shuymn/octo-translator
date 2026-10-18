import { describe, expect, test } from "vitest";
import { hashSegments } from "../../src/lib/cache.ts";
import { EMOJI_TITLE, PULL_REQUEST_SHAPES } from "../../src/lib/pr-shapes.fixtures.ts";
import { pullRequestSegments } from "./pr-segments.ts";

// DOM-3: the Worker's side of the parity with the page. `src/lib/segments.test.ts` reads the page side of the same
// fixtures with happy-dom and expects the same segments and hashes; these run on linkedom in workerd.
describe("DOM-3: segments of a pull request from the REST API", () => {
  test.each(PULL_REQUEST_SHAPES.map((shape) => [shape.name, shape] as const))("%s", async (_, shape) => {
    const segments = pullRequestSegments({ title: shape.title, body_html: shape.api });
    expect(segments).toEqual(shape.segments);
    expect(await hashSegments(segments)).toBe(shape.hash);
  });

  test("decodes character references as the browser does", () => {
    const segments = pullRequestSegments({ title: "A &amp; B", body_html: "<p>Tom &amp; Jerry&nbsp;&lt;3 &#x41;</p>" });
    // The title is text, so its `&amp;` is literal, as on the page.
    expect(segments).toEqual([
      { kind: "title", text: "A &amp; B" },
      { kind: "paragraph", text: "Tom & Jerry <3 A" },
    ]);
  });

  // The page shows "✨ Add the cache" (src/lib/segments.test.ts): the hashes differ, so the page translates on request.
  test("keeps an emoji shortcode in the title as the API returns it", () => {
    expect(pullRequestSegments({ title: EMOJI_TITLE.title, body_html: "" })).toEqual([
      { kind: "title", text: ":sparkles: Add the cache" },
    ]);
  });
});

describe("DOM-1: only GitHub's body_html is parsed", () => {
  test("the title is text, never markup", () => {
    const title = '<img src=x onerror="alert(1)"> Fix <code>parse</code>';
    expect(pullRequestSegments({ title, body_html: "" })).toEqual([{ kind: "title", text: title }]);
  });

  test("a code span in the title holds its text, markup included", () => {
    expect(pullRequestSegments({ title: "Escape `<b>` tags", body_html: "" })).toEqual([
      { kind: "title", text: "Escape ⟦0⟧ tags" },
    ]);
  });

  test("scripts, styles and templates in body_html add no segment", () => {
    const body_html =
      "<script>alert('x')</script><style>p { color: red }</style><template><p>Hidden</p></template><p>Shown</p>";
    expect(pullRequestSegments({ title: "", body_html })).toEqual([{ kind: "paragraph", text: "Shown" }]);
  });
});
