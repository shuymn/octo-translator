/**
 * KEY-1 by behavior: the content script, with everything it imports, runs on WXT's fake browser, and every storage read
 * it makes is recorded. WXT reads an item as soon as it is defined, so importing a module that defines a key item is
 * caught here even though no code calls it.
 */
import { afterAll, expect, test, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

// `wxt/browser` picks the global extension API when it is first loaded, so the fake is in place before the content
// script is imported below. Nothing else in this file may import `wxt/browser` or a module that does.
vi.stubGlobal("chrome", fakeBrowser);
vi.stubGlobal("browser", fakeBrowser);

afterAll(() => {
  vi.unstubAllGlobals();
});

/** Every key the code asked `storage.local` for, and whether it asked for everything at once. */
function recordReads() {
  const get = vi.spyOn(fakeBrowser.storage.local, "get");
  const getKeys = vi.spyOn(fakeBrowser.storage.local, "getKeys");
  return {
    keys: () =>
      new Set(
        get.mock.calls.flatMap(([query]): string[] => {
          if (typeof query === "string") return [query];
          if (Array.isArray(query)) return query.map(String);
          return query ? Object.keys(query) : [];
        }),
      ),
    bulk: () =>
      getKeys.mock.calls.length > 0 || get.mock.calls.some(([query]) => query === null || query === undefined),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("KEY-1: the content script never reads an API key or the Worker's service token from storage", async () => {
  const reads = recordReads();
  document.head.innerHTML = '<meta name="octolytics-dimension-repository_public" content="true">';
  document.body.innerHTML = "";

  const { default: contentScript } = await import("../entrypoints/github.content.ts");
  // WXT's own context needs the build's `import.meta.env`; the content script uses only `onInvalidated`.
  const ctx = { onInvalidated: vi.fn<(callback: () => void) => () => void>(() => () => {}) };
  await Reflect.apply(contentScript.main, contentScript, [ctx]);
  await settle();
  for (const [stop] of ctx.onInvalidated.mock.calls) stop();

  // The recorder sees the settings the content script does read.
  expect(reads.keys()).toContain("autoTranslate");
  expect(reads.keys()).toContain("modelChoice");
  expect(reads.bulk()).toBe(false);

  // The secrets' names come from the items themselves, imported only now: importing them reads the secrets too.
  const readByContentScript = reads.keys();
  const { apiKeyItems, workerAccessItem } = await import("./api-keys.ts");
  const keyNames = [...Object.values(apiKeyItems), workerAccessItem].map((item) => item.key.replace(/^local:/, ""));
  expect(keyNames).toContain("workerAccess");
  for (const name of keyNames) expect(readByContentScript).not.toContain(name);
});
