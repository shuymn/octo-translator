/**
 * The options page saves only what it edited (`trackEdits` in `edits.ts`), checked by running the page itself on WXT's
 * fake browser: an options page opened before another one saved must not write its stale values back. The first test
 * is the guard for any setting added later: a save with nothing edited writes nothing at all, so a setting written
 * without going through `trackEdits` fails it.
 */
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { DEFAULT_CHOICE, type ModelChoice } from "./providers.ts";

// `wxt/browser` picks the global extension API when it is first loaded, so the fake is in place before the page is
// imported.
vi.stubGlobal("chrome", fakeBrowser);
vi.stubGlobal("browser", fakeBrowser);

afterAll(() => {
  vi.unstubAllGlobals();
});

const html =
  import.meta.glob<string>("../entrypoints/options/index.html", { query: "?raw", import: "default", eager: true })[
    "../entrypoints/options/index.html"
  ] ?? "";

const A = { origin: "https://a.example.com", clientId: "a-id", clientSecret: "a-secret" };
const B = { origin: "https://b.example.com", clientId: "b-id", clientSecret: "b-secret" };
const GEMINI: ModelChoice = { provider: "gemini", model: "gemini-3.8-flash", thinking: "low" };

// Imported only now, after the fake is in place: `wxt/utils/storage` loads `wxt/browser`.
const { storage } = await import("wxt/utils/storage");

// What another options page, or the background, writes: straight to storage, under the items' own names.
const stored = {
  modelChoice: storage.defineItem<unknown>("local:modelChoice"),
  autoTranslate: storage.defineItem<boolean>("local:autoTranslate"),
  privateRepositories: storage.defineItem<string[]>("local:privateRepositories"),
  worker: storage.defineItem<unknown>("local:workerAccess"),
};
// The key items come from their module, so their names are the real ones.
const { apiKeyItems } = await import("./api-keys.ts");

let granted: Set<string>;
type PermissionCall = (permissions: { origins?: string[] }) => Promise<boolean>;
const request = vi.fn<PermissionCall>(async ({ origins = [] }: { origins?: string[] }) => {
  for (const origin of origins) granted.add(origin);
  return true;
});
const remove = vi.fn<PermissionCall>(async ({ origins = [] }: { origins?: string[] }) => {
  for (const origin of origins) granted.delete(origin);
  return true;
});

beforeEach(() => {
  fakeBrowser.reset();
  granted = new Set();
  request.mockClear();
  remove.mockClear();
  Object.assign(fakeBrowser.permissions, { request, remove });
});

// Every write the page makes from now on.
function recordWrites() {
  const set = vi.spyOn(fakeBrowser.storage.local, "set");
  const removed = vi.spyOn(fakeBrowser.storage.local, "remove");
  const clear = vi.spyOn(fakeBrowser.storage.local, "clear");
  // Spying again returns the same spy, with the calls of earlier saves.
  for (const spy of [set, removed, clear]) spy.mockClear();
  return () => [...set.mock.calls, ...removed.mock.calls, ...clear.mock.calls];
}

function element<T extends HTMLElement>(selector: string, type: new () => T): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`missing ${selector}`);
  return found;
}

// Loads a fresh options page from what storage holds now.
async function openPage() {
  vi.resetModules();
  const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "";
  document.body.innerHTML = body.replaceAll(/<script[\s\S]*?<\/script>/g, "");
  await import("../entrypoints/options/main.ts");
}

function typeInto(selector: string, value: string) {
  const input = element(selector, HTMLElement);
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) throw new Error(selector);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function toggleAutoTranslate() {
  element("#auto-translate", HTMLInputElement).click();
}

async function save() {
  const status = element("#status", HTMLElement);
  element("#settings", HTMLFormElement).requestSubmit();
  await vi.waitFor(() => expect(status.textContent).toBe("保存しました。"));
}

test("a save with nothing edited writes nothing", async () => {
  await stored.modelChoice.setValue(GEMINI);
  await stored.autoTranslate.setValue(true);
  await stored.privateRepositories.setValue(["o/r"]);
  await apiKeyItems.deepseek.setValue("ds-key");
  await stored.worker.setValue(A);
  await openPage();
  const writes = recordWrites();
  await save();
  expect(writes()).toEqual([]);
  expect(request).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});

describe("a stale page saving something else leaves the newer value intact", () => {
  test("the model choice", async () => {
    await openPage();
    await stored.modelChoice.setValue(GEMINI);
    toggleAutoTranslate();
    await save();
    expect(await stored.modelChoice.getValue()).toEqual(GEMINI);
    expect(await stored.autoTranslate.getValue()).toBe(true);
  });

  test("auto-translate", async () => {
    await openPage();
    await stored.autoTranslate.setValue(true);
    typeInto("#private-repositories", "o/r");
    await save();
    expect(await stored.autoTranslate.getValue()).toBe(true);
    expect(await stored.privateRepositories.getValue()).toEqual(["o/r"]);
  });

  test("the private repositories", async () => {
    await openPage();
    await stored.privateRepositories.setValue(["o/newer"]);
    toggleAutoTranslate();
    await save();
    expect(await stored.privateRepositories.getValue()).toEqual(["o/newer"]);
  });

  test("a provider key, while this page saves another provider's", async () => {
    await openPage();
    await apiKeyItems.openai.setValue("newer-openai");
    typeInto("#api-key", " ds-key ");
    await save();
    expect(await apiKeyItems.openai.getValue()).toBe("newer-openai");
    expect(await apiKeyItems.deepseek.getValue()).toBe("ds-key");
  });

  test("KEY-4: the Worker configuration and its permission", async () => {
    await openPage();
    await stored.worker.setValue(B);
    granted.add(`${B.origin}/*`);
    toggleAutoTranslate();
    await save();
    expect(await stored.worker.getValue()).toEqual(B);
    expect(granted).toEqual(new Set([`${B.origin}/*`]));
    expect(request).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  test("KEY-4: a stale page showing Worker A does not put A back over B", async () => {
    await stored.worker.setValue(A);
    await openPage();
    await stored.worker.setValue(B);
    toggleAutoTranslate();
    await save();
    expect(await stored.worker.getValue()).toEqual(B);
  });
});

describe("an edited field is saved, and clearing one counts as an edit", () => {
  test("the model choice", async () => {
    await stored.modelChoice.setValue(DEFAULT_CHOICE);
    await openPage();
    const provider = element("#provider", HTMLSelectElement);
    provider.value = "gemini";
    provider.dispatchEvent(new Event("change"));
    await save();
    expect(await stored.modelChoice.getValue()).toMatchObject({ provider: "gemini" });
  });

  test("auto-translate", async () => {
    await stored.autoTranslate.setValue(true);
    await openPage();
    toggleAutoTranslate();
    await save();
    expect(await stored.autoTranslate.getValue()).toBe(false);
  });

  test("the private repositories, cleared", async () => {
    await stored.privateRepositories.setValue(["o/r"]);
    await openPage();
    typeInto("#private-repositories", "");
    await save();
    expect(await stored.privateRepositories.getValue()).toEqual([]);
  });

  test("a provider key, cleared", async () => {
    await apiKeyItems.deepseek.setValue("ds-key");
    await openPage();
    typeInto("#api-key", "");
    await save();
    expect(await apiKeyItems.deepseek.getValue()).toBe("");
  });

  test("KEY-4: the Worker configuration, asking for its origin inside the save", async () => {
    await openPage();
    typeInto("#worker-url", "https://B.example.com/");
    typeInto("#worker-client-id", B.clientId);
    typeInto("#worker-client-secret", B.clientSecret);
    await save();
    expect(request).toHaveBeenCalledWith({ origins: [`${B.origin}/*`] });
    expect(await stored.worker.getValue()).toEqual(B);
    // Shown as stored, so saving again writes nothing.
    expect(element("#worker-url", HTMLInputElement).value).toBe(B.origin);
    const writes = recordWrites();
    await save();
    expect(writes()).toEqual([]);
  });

  test("KEY-4: the Worker URL, cleared, turns the Worker off and drops its permission", async () => {
    await stored.worker.setValue(A);
    granted.add(`${A.origin}/*`);
    await openPage();
    typeInto("#worker-url", "");
    await save();
    expect(await stored.worker.getValue()).toBeNull();
    expect(granted).toEqual(new Set());
  });
});
