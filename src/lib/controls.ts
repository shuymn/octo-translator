import { createIcon } from "./icons.ts";
import type { CommentHeader } from "./pr-page.ts";

// The translation controls, built from GitHub's own classes so they look like the rest of the page:
// - a button among the description's header actions (next to its "…" menu), which turns the translation on and off;
// - a note on the header's "author commented …" line while the translation is requested or shown, the way GitHub
//   marks an edited comment;
// - a warning above the description when the translation fails.
// Without the header actions (GitHub changed its markup), a notice above the description carries all of it instead.

export const MARK = "data-octo-translator";

export type ControlsView =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "translated"; showTranslation: boolean; partial: boolean }
  | { kind: "error"; message: string; offerSettings: boolean };

export type ControlsHandlers = {
  onToggle: () => void;
  onOpenSettings: () => void;
};

const BUTTON_LABEL = "日本語訳を表示";

export class Controls {
  #doc: Document;
  #handlers: ControlsHandlers;
  #button: HTMLButtonElement;
  #note: HTMLElement;
  #notice: HTMLElement;
  #view: ControlsView = { kind: "idle" };

  constructor(doc: Document, handlers: ControlsHandlers) {
    this.#doc = doc;
    this.#handlers = handlers;
    // The markup of the header's own "…" button. `mr-1` evens the space on both sides: the actions sit 8px after
    // the author's label, and the "…" button has 4px of padding of its own.
    this.#button = doc.createElement("button");
    this.#button.type = "button";
    this.#button.setAttribute(MARK, "");
    this.#button.className =
      "timeline-comment-action Link--secondary Button--link Button--medium Button tooltipped tooltipped-nw mr-1";
    this.#button.setAttribute("aria-label", BUTTON_LABEL);
    this.#button.addEventListener("click", () => this.#handlers.onToggle());
    // Visual only: the notice announces the same state to screen readers.
    this.#note = doc.createElement("span");
    this.#note.setAttribute(MARK, "");
    this.#note.setAttribute("aria-hidden", "true");
    this.#note.className = "fgColor-muted";
    this.#notice = doc.createElement("div");
    this.#notice.setAttribute(MARK, "");
    this.#notice.setAttribute("role", "status");
  }

  // Puts the controls back where GitHub's re-renders removed them from.
  attach(body: HTMLElement, header: CommentHeader): void {
    let moved = false;
    if (header.actions && !header.actions.contains(this.#button)) {
      header.actions.prepend(this.#button);
      moved = true;
    }
    if (header.heading && !header.heading.contains(this.#note)) {
      header.heading.append(this.#note);
      moved = true;
    }
    if (!this.#notice.isConnected) {
      body.before(this.#notice);
      moved = true;
    }
    if (moved) this.render(this.#view);
  }

  render(view: ControlsView): void {
    this.#view = view;
    this.#renderButton(view);
    if (this.#button.isConnected) {
      this.#renderInHeader(view);
    } else {
      this.#note.hidden = true;
      this.#renderNotice(view);
    }
  }

  #renderButton(view: ControlsView): void {
    const button = this.#button;
    button.disabled = view.kind === "loading";
    button.setAttribute("aria-pressed", String(view.kind === "translated" && view.showTranslation));
    const icon = createIcon(this.#doc, view.kind === "loading" ? "spinner" : "globe");
    if (view.kind === "translated" && view.showTranslation) icon.classList.add("fgColor-accent");
    const content = this.#doc.createElement("span");
    content.className = "Button-content";
    const label = this.#doc.createElement("span");
    label.className = "Button-label";
    label.append(icon);
    content.append(label);
    button.replaceChildren(content);
  }

  #renderInHeader(view: ControlsView): void {
    const note = this.#noteText(view);
    this.#note.hidden = note === undefined;
    this.#note.textContent = note === undefined ? "" : `• ${note}`;
    if (view.kind === "error") {
      this.#renderNotice(view);
      return;
    }
    // Kept in the page and visually hidden, so screen readers hear each change.
    this.#notice.className = "sr-only";
    this.#notice.hidden = false;
    this.#notice.textContent = note ?? "";
  }

  #noteText(view: ControlsView): string | undefined {
    if (view.kind === "loading") return "翻訳しています…";
    if (view.kind === "translated" && view.showTranslation) {
      return `Gemini による日本語訳${view.partial ? "（一部は原文のまま）" : ""}`;
    }
    return undefined;
  }

  #renderNotice(view: ControlsView): void {
    const notice = this.#notice;
    notice.hidden = false;
    notice.className =
      view.kind === "error"
        ? "flash flash-warn f6 mb-2 py-2 px-3 d-flex flex-items-center flex-wrap gap-2"
        : "f6 fgColor-muted mb-2 d-flex flex-items-center flex-wrap gap-1";
    switch (view.kind) {
      case "idle":
        notice.replaceChildren(createIcon(this.#doc, "globe"), this.#link("日本語に翻訳", this.#handlers.onToggle));
        break;
      case "loading":
        notice.replaceChildren(createIcon(this.#doc, "spinner"), "Gemini で翻訳しています…");
        break;
      case "translated":
        notice.replaceChildren(
          createIcon(this.#doc, "globe"),
          this.#noteText(view) ?? "原文を表示しています",
          "·",
          this.#link(view.showTranslation ? "原文を表示" : "翻訳を表示", this.#handlers.onToggle),
        );
        break;
      case "error":
        notice.replaceChildren(
          createIcon(this.#doc, "alert"),
          view.message,
          this.#link("もう一度試す", this.#handlers.onToggle),
          ...(view.offerSettings ? [this.#link("設定を開く", this.#handlers.onOpenSettings)] : []),
        );
        break;
    }
  }

  #link(text: string, onClick: () => void): HTMLButtonElement {
    const link = this.#doc.createElement("button");
    link.type = "button";
    link.className = "btn-link f6";
    link.textContent = text;
    link.addEventListener("click", onClick);
    return link;
  }
}
