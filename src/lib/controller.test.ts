import { afterEach, describe, expect, test, vi } from "vitest";
import { PageController, type ControllerDeps, type Settings } from "./controller.ts";
import type { SourceSegment, TranslationResult } from "./gemini.ts";

const HEADER = `
  <div class="timeline-comment-header">
    <h3><div class="d-flex">author commented</div></h3>
    <div class="timeline-comment-actions"><details><summary>…</summary></details></div>
  </div>`;

// A minimal page with the parts of GitHub's markup the extension reads.
function renderPage({
  visibility = "true",
  title = "Fix <code>parse</code> crash",
  body = '<p>This fixes <code>parse</code>, see <a href="/docs">the docs</a>.</p><pre><code>const x = 1;</code></pre>',
  header = HEADER,
} = {}): void {
  document.head.innerHTML = `<meta name="octolytics-dimension-repository_public" content="${visibility}">`;
  document.body.innerHTML = `
    <h1 data-component="PH_Title"><span class="markdown-title">${title}</span></h1>
    <div data-partial-name="pullRequestsConversationsRoute.Body">
      <div class="timeline-comment">
        ${header}
        <div class="comment-body markdown-body">${body}</div>
      </div>
    </div>`;
}

type Translate = ControllerDeps["translate"];

// Prefixes every segment, keeping its markers.
const prefixAll = vi.fn<Translate>(async (_key: string, segments: SourceSegment[]): Promise<TranslationResult> => ({
  ok: true,
  translations: segments.map((segment) => `【訳】${segment.text}`),
}));

function setup(settings: Partial<Settings> = {}, translate: Translate = prefixAll) {
  const openOptions = vi.fn<() => void>();
  const controller = new PageController(
    { doc: document, pathname: () => "/owner/repo/pull/7", translate, openOptions },
    { autoTranslate: false, privateRepositories: [], ...settings },
  );
  controller.sync();
  return { controller, openOptions };
}

const headerButton = () => document.querySelector<HTMLButtonElement>(".timeline-comment-actions > button");
const notice = () => document.querySelector<HTMLElement>('[data-octo-translator][role="status"]');
const note = () => document.querySelector<HTMLElement>(".timeline-comment-header h3 > div > [data-octo-translator]");
const noticeLinks = () => [...(notice()?.querySelectorAll("button") ?? [])];
const bodyElement = () => document.querySelector(".comment-body");
const visibleTitle = () => document.querySelector<HTMLElement>(".markdown-title:not([hidden])");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  prefixAll.mockClear();
});

describe("PageController", () => {
  test("puts a button among the description's header actions and translates on click", async () => {
    renderPage();
    setup();
    expect(headerButton()?.nextElementSibling?.tagName).toBe("DETAILS");
    expect(headerButton()?.getAttribute("aria-label")).toBe("日本語訳を表示");
    expect(headerButton()?.getAttribute("aria-pressed")).toBe("false");
    // Nothing shows above the description; the notice only speaks to screen readers.
    expect(notice()?.className).toBe("sr-only");
    expect(notice()?.textContent).toBe("");
    expect(note()?.hidden).toBe(true);
    expect(prefixAll).not.toHaveBeenCalled();

    headerButton()?.click();
    await settle();

    expect(prefixAll).toHaveBeenCalledWith("owner/repo#7", [
      { kind: "title", text: "Fix ⟦0⟧ crash" },
      { kind: "paragraph", text: "This fixes ⟦0⟧, see ⟦1⟧the docs⟦/1⟧." },
    ]);
    expect(visibleTitle()?.innerHTML).toBe("【訳】Fix <code>parse</code> crash");
    expect(bodyElement()?.querySelector("p")?.innerHTML).toBe(
      '【訳】This fixes <code>parse</code>, see <a href="/docs">the docs</a>.',
    );
    expect(bodyElement()?.querySelector("pre")?.textContent).toBe("const x = 1;");
    expect(headerButton()?.getAttribute("aria-pressed")).toBe("true");
    expect(note()?.hidden).toBe(false);
    expect(note()?.textContent).toBe("• Gemini による日本語訳");
    expect(notice()?.className).toBe("sr-only");
    expect(notice()?.nextElementSibling).toBe(bodyElement());
  });

  test("switches back to the original nodes and to the translation again", async () => {
    renderPage();
    setup();
    const originalCode = bodyElement()?.querySelector("p code");
    headerButton()?.click();
    await settle();

    headerButton()?.click();
    expect(bodyElement()?.querySelector("p code")).toBe(originalCode);
    expect(visibleTitle()?.textContent).toBe("Fix parse crash");
    expect(headerButton()?.getAttribute("aria-pressed")).toBe("false");
    expect(note()?.hidden).toBe(true);

    headerButton()?.click();
    expect(visibleTitle()?.textContent).toBe("【訳】Fix parse crash");
    expect(prefixAll).toHaveBeenCalledTimes(1);
  });

  test("shows the request in progress in the header, not above the description", async () => {
    renderPage();
    const pending = Promise.withResolvers<TranslationResult>();
    setup({}, () => pending.promise);
    headerButton()?.click();

    expect(headerButton()?.disabled).toBe(true);
    expect(headerButton()?.querySelector("svg")?.classList.contains("anim-rotate")).toBe(true);
    expect(note()?.textContent).toBe("• 翻訳しています…");
    expect(notice()?.className).toBe("sr-only");

    pending.resolve({ ok: true, translations: ["訳", "訳"] });
    await settle();
    expect(headerButton()?.disabled).toBe(false);
  });

  test("offers the button in the notice when the header actions are missing", async () => {
    renderPage({ header: "" });
    setup();
    expect(notice()?.hidden).toBe(false);
    noticeLinks()[0]?.click();
    await settle();
    expect(prefixAll).toHaveBeenCalledTimes(1);
  });

  test("translates on its own when automatic translation is on, once", async () => {
    renderPage();
    const { controller } = setup({ autoTranslate: true });
    controller.sync();
    await settle();
    controller.sync();
    expect(prefixAll).toHaveBeenCalledTimes(1);
    expect(headerButton()?.getAttribute("aria-pressed")).toBe("true");
  });

  test("leaves a private repository alone unless it is listed", () => {
    renderPage({ visibility: "false" });
    const { controller } = setup();
    expect(headerButton()).toBeNull();
    expect(notice()).toBeNull();

    controller.updateSettings({ autoTranslate: false, privateRepositories: ["owner/repo"] });
    expect(headerButton()).not.toBeNull();
  });

  test("does not send a page GitHub has moved away from before the next sync", async () => {
    renderPage({ visibility: "false" });
    let pathname = "/owner/repo/pull/7";
    const controller = new PageController(
      { doc: document, pathname: () => pathname, translate: prefixAll, openOptions: vi.fn<() => void>() },
      { autoTranslate: false, privateRepositories: ["owner/repo"] },
    );
    controller.sync();

    // GitHub navigated to a private pull request that is not allowed; the old button is clicked before sync runs.
    pathname = "/owner/secret/pull/1";
    headerButton()?.click();
    await settle();
    expect(prefixAll).not.toHaveBeenCalled();
  });

  test("shows nothing for a pull request already in Japanese", () => {
    renderPage({ title: "バグを修正", body: "<p>本文です。</p>" });
    setup({ autoTranslate: true });
    expect(headerButton()).toBeNull();
    expect(prefixAll).not.toHaveBeenCalled();
  });

  test("reports an error and offers the settings when the key is missing", async () => {
    renderPage();
    const { openOptions } = setup({}, async () => ({ ok: false, code: "no-api-key" }));
    headerButton()?.click();
    await settle();

    expect(notice()?.classList.contains("flash-warn")).toBe(true);
    expect(notice()?.textContent).toContain("Gemini の API キーが設定されていません。");
    expect(noticeLinks().map((link) => link.textContent)).toEqual(["もう一度試す", "設定を開く"]);
    noticeLinks()[1]?.click();
    expect(openOptions).toHaveBeenCalled();
  });

  test("keeps a part whose markers came back wrong in the original", async () => {
    renderPage();
    setup({}, async () => ({ ok: true, translations: ["タイトル ⟦0⟧", "markers dropped"] }));
    headerButton()?.click();
    await settle();

    expect(bodyElement()?.querySelector("p")?.textContent).toBe("This fixes parse, see the docs.");
    expect(visibleTitle()?.textContent).toBe("タイトル parse");
    expect(note()?.textContent).toBe("• Gemini による日本語訳（一部は原文のまま）");
  });

  test("reports a title left in the original", async () => {
    renderPage();
    setup({}, async () => ({ ok: true, translations: ["markers dropped", "本文 ⟦0⟧、⟦1⟧資料⟦/1⟧。"] }));
    headerButton()?.click();
    await settle();

    expect(visibleTitle()?.textContent).toBe("Fix parse crash");
    expect(bodyElement()?.querySelector("p")?.textContent).toBe("本文 parse、資料。");
    expect(note()?.textContent).toBe("• Gemini による日本語訳（一部は原文のまま）");
  });

  test("follows GitHub when it renders the title, the header or the description again", async () => {
    renderPage();
    const { controller } = setup();
    headerButton()?.click();
    await settle();

    // React renders a new title element with the same text.
    const heading = document.querySelector("h1");
    if (heading) heading.innerHTML = '<span class="markdown-title">Fix <code>parse</code> crash</span>';
    // The header actions are rendered again without the button.
    const actions = document.querySelector(".timeline-comment-actions");
    if (actions) actions.innerHTML = "<details><summary>…</summary></details>";
    controller.sync();
    expect(visibleTitle()?.textContent).toBe("【訳】Fix parse crash");
    expect(headerButton()?.getAttribute("aria-pressed")).toBe("true");

    // GitHub replaces the description after an edit: the page starts over.
    const comment = document.querySelector(".timeline-comment");
    if (comment) comment.innerHTML = `${HEADER}<div class="comment-body markdown-body"><p>Edited text.</p></div>`;
    controller.sync();
    expect(headerButton()?.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelectorAll('[data-octo-translator][role="status"]')).toHaveLength(1);
    expect(visibleTitle()?.textContent).toBe("Fix parse crash");
  });

  test("removes its changes when the page is no longer a pull request", async () => {
    renderPage();
    let pathname = "/owner/repo/pull/7";
    const controller = new PageController(
      { doc: document, pathname: () => pathname, translate: prefixAll, openOptions: vi.fn<() => void>() },
      { autoTranslate: true, privateRepositories: [] },
    );
    controller.sync();
    await settle();

    pathname = "/owner/repo/pull/7/files";
    controller.sync();
    expect(document.querySelectorAll("[data-octo-translator]")).toHaveLength(0);
    expect(document.querySelectorAll(".markdown-title")).toHaveLength(1);
    expect(visibleTitle()?.textContent).toBe("Fix parse crash");
  });
});
