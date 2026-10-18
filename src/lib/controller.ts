import { Controls, MARK, type ControlsView } from "./controls.ts";
import type { SourceSegment, TranslationError, TranslationResult } from "./gemini.ts";
import {
  findBody,
  findCommentHeader,
  findTitles,
  isPublicRepository,
  parsePullRequestPath,
  pullRequestKey,
  repositoryName,
} from "./pr-page.ts";
import { buildTranslatedNodes, extractInlineSegment, extractSegments, isJapanese, type Segment } from "./segments.ts";

export type Settings = {
  autoTranslate: boolean;
  privateRepositories: string[];
};

export type ControllerDeps = {
  doc: Document;
  pathname: () => string;
  translate: (key: string, segments: SourceSegment[]) => Promise<TranslationResult>;
  openOptions: () => void;
};

const ERROR_MESSAGES: Record<TranslationError, string> = {
  "no-api-key": "Gemini の API キーが設定されていません。",
  "api-key-rejected": "API キーが受け付けられませんでした。",
  "rate-limited": "無料枠の上限に達しました。しばらくしてからもう一度試してください。",
  "too-long": "本文が長すぎるため翻訳しません。",
  network: "Gemini API に接続できませんでした。",
  "api-error": "Gemini API がエラーを返しました。",
  "invalid-response": "翻訳結果を読み取れませんでした。",
};

const SETTINGS_ERRORS: ReadonlySet<TranslationError> = new Set(["no-api-key", "api-key-rejected"]);

// "none": nothing on the page needs translating, so no control is shown.
type Phase =
  | { kind: "none" }
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "translated" }
  | { kind: "error"; code: TranslationError };

// One translated span of the description: the original nodes stay, and the translated ones take their place.
type BodyPart = { segment: Segment; translated: ChildNode[] | undefined };

type State = {
  key: string;
  body: HTMLElement;
  // The title as GitHub rendered it, which identifies the title elements to pair with a translation.
  titleText: string;
  // The title to translate, unless it is already Japanese.
  titleSegment: Segment | undefined;
  titleTranslation: string | undefined;
  parts: BodyPart[];
  phase: Phase;
  showTranslation: boolean;
  controls: Controls;
};

// Keeps the translation control and the translated text in step with GitHub's page, which re-renders parts of itself
// at any time. `sync` is idempotent: it changes the page only where it differs from the state.
export class PageController {
  #deps: ControllerDeps;
  #settings: Settings;
  #state: State | undefined;

  constructor(deps: ControllerDeps, settings: Settings) {
    this.#deps = deps;
    this.#settings = settings;
  }

  updateSettings(settings: Settings): void {
    this.#settings = settings;
    this.sync();
  }

  sync(): void {
    const { doc } = this.#deps;
    const ref = parsePullRequestPath(this.#deps.pathname());
    const body = ref ? findBody(doc) : null;
    if (!ref || !body || !this.#allowed(repositoryName(ref), doc)) {
      this.#reset();
      return;
    }
    const key = pullRequestKey(ref);
    const title = findTitles(doc)[0];
    const titleText = title?.textContent ?? "";
    let current = this.#state;
    if (current?.key !== key || current.body !== body || (titleText !== "" && current.titleText !== titleText)) {
      this.#reset();
      current = this.#createState(key, body, title);
      this.#state = current;
    }
    if (current.phase.kind === "none") return;
    current.controls.attach(body, findCommentHeader(body));
    this.#applyTitles(current);
    if (current.phase.kind === "idle" && this.#settings.autoTranslate) void this.#translate(current);
  }

  #allowed(repository: string, doc: Document): boolean {
    return isPublicRepository(doc) || this.#settings.privateRepositories.includes(repository);
  }

  #createState(key: string, body: HTMLElement, title: HTMLElement | undefined): State {
    const extracted = title ? extractInlineSegment(title, "title") : undefined;
    const titleSegment = extracted && !isJapanese(extracted.source) ? extracted : undefined;
    const parts = extractSegments(body)
      .filter((segment) => !isJapanese(segment.source))
      .map((segment) => ({ segment, translated: undefined }));
    const state: State = {
      key,
      body,
      titleText: title?.textContent ?? "",
      titleSegment,
      titleTranslation: undefined,
      parts,
      phase: titleSegment === undefined && parts.length === 0 ? { kind: "none" } : { kind: "idle" },
      showTranslation: false,
      controls: new Controls(this.#deps.doc, {
        onToggle: () => this.#onToggle(state),
        onOpenSettings: () => this.#deps.openOptions(),
      }),
    };
    this.#render(state);
    return state;
  }

  #onToggle(state: State): void {
    if (state.phase.kind === "loading" || state.phase.kind === "none") return;
    if (state.phase.kind !== "translated") {
      void this.#translate(state);
      return;
    }
    state.showTranslation = !state.showTranslation;
    this.#applyBody(state);
    this.#applyTitles(state);
    this.#render(state);
  }

  async #translate(state: State): Promise<void> {
    state.phase = { kind: "loading" };
    this.#render(state);
    const sources = [
      ...(state.titleSegment ? [state.titleSegment] : []),
      ...state.parts.map((part) => part.segment),
    ].map((segment): SourceSegment => ({ kind: segment.kind, text: segment.source }));
    const result = await this.#deps.translate(state.key, sources);
    // The page moved on while the request was in flight.
    if (this.#state !== state) return;
    if (!result.ok) {
      state.phase = { kind: "error", code: result.code };
      this.#render(state);
      return;
    }
    const translations = [...result.translations];
    const titleTranslation = state.titleSegment ? translations.shift() : undefined;
    // Kept only when it fits the title's markers, so the notice can tell a title left in the original.
    if (state.titleSegment && titleTranslation !== undefined) {
      const fits = buildTranslatedNodes(state.titleSegment, titleTranslation, this.#deps.doc) !== undefined;
      state.titleTranslation = fits ? titleTranslation : undefined;
    }
    state.parts.forEach((part, index) => {
      const translation = translations[index];
      part.translated =
        translation === undefined ? undefined : buildTranslatedNodes(part.segment, translation, this.#deps.doc);
    });
    state.phase = { kind: "translated" };
    state.showTranslation = true;
    this.#applyBody(state);
    this.#applyTitles(state);
    this.#render(state);
  }

  #applyBody(state: State): void {
    for (const { segment, translated } of state.parts) {
      if (!translated) continue;
      const [shown, hidden] = state.showTranslation ? [translated, segment.original] : [segment.original, translated];
      const anchor = hidden[0];
      if (!anchor?.parentNode) continue;
      anchor.before(...shown);
      for (const node of hidden) node.remove();
    }
  }

  // The title belongs to GitHub's React tree, so its nodes are never replaced: a copy with the translation is placed
  // next to it, and the original is hidden while the translation shows.
  #applyTitles(state: State): void {
    const translation = state.titleTranslation;
    for (const title of findTitles(this.#deps.doc)) {
      let copy = title.nextElementSibling?.hasAttribute(MARK) ? title.nextElementSibling : undefined;
      if (translation !== undefined && !copy && title.textContent === state.titleText) {
        const segment = extractInlineSegment(title, "title");
        const nodes = segment ? buildTranslatedNodes(segment, translation, this.#deps.doc) : undefined;
        if (nodes) {
          copy = this.#deps.doc.importNode(title, false);
          copy.setAttribute(MARK, "");
          copy.append(...nodes);
          title.after(copy);
        }
      }
      const show = state.showTranslation && copy !== undefined;
      if (title.hidden !== show) title.hidden = show;
      if (copy instanceof HTMLElement && copy.hidden === show) copy.hidden = !show;
    }
  }

  #render(state: State): void {
    state.controls.render(this.#view(state));
  }

  #view(state: State): ControlsView {
    const { phase } = state;
    if (phase.kind === "loading") return { kind: "loading" };
    if (phase.kind === "error") {
      return { kind: "error", message: ERROR_MESSAGES[phase.code], offerSettings: SETTINGS_ERRORS.has(phase.code) };
    }
    if (phase.kind === "translated") {
      return {
        kind: "translated",
        showTranslation: state.showTranslation,
        partial:
          (state.titleSegment !== undefined && state.titleTranslation === undefined) ||
          state.parts.some((part) => !part.translated),
      };
    }
    // "none" shows nothing at all: sync never attaches its controls.
    return { kind: "idle" };
  }

  // Puts the page back as GitHub rendered it and forgets the pull request.
  #reset(): void {
    const state = this.#state;
    if (!state) return;
    this.#state = undefined;
    state.showTranslation = false;
    this.#applyBody(state);
    // Everything else the extension added, the controls and the title copies, carries the mark.
    for (const added of this.#deps.doc.querySelectorAll(`[${MARK}]`)) added.remove();
    for (const title of findTitles(this.#deps.doc)) title.hidden = false;
  }
}
