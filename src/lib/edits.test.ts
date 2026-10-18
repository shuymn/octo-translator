import { describe, expect, test, vi } from "vitest";
import { sameValue, trackEdits, type Writers } from "./edits.ts";

type Values = { key: string; flag: boolean; list: string[]; choice: { provider: string; model: string } };
const LOADED: Values = { key: "k", flag: false, list: ["a/b"], choice: { provider: "p", model: "m" } };

function writers() {
  const writes: [string, unknown][] = [];
  const record =
    (name: string) =>
    async (value: unknown): Promise<void> => {
      writes.push([name, value]);
    };
  const all: Writers<Values> = {
    key: record("key"),
    flag: record("flag"),
    list: record("list"),
    choice: record("choice"),
  };
  return { all, writes };
}

describe("trackEdits", () => {
  test("nothing edited saves nothing", async () => {
    const edits = trackEdits(LOADED);
    // Another object with the same content, keys in another order, is not an edit.
    const changes = edits.edited({ ...LOADED, list: ["a/b"], choice: { model: "m", provider: "p" } });
    expect(changes).toEqual({});
    const { all, writes } = writers();
    await edits.save(changes, all);
    expect(writes).toEqual([]);
  });

  test("saves only the edited fields, and clearing a field is an edit", async () => {
    const edits = trackEdits(LOADED);
    const changes = edits.edited({ ...LOADED, key: "", list: [] });
    expect(changes).toEqual({ key: "", list: [] });
    const { all, writes } = writers();
    await edits.save(changes, all);
    expect(writes).toEqual([
      ["key", ""],
      ["list", []],
    ]);
  });

  test("takes the saved values as the baseline, so saving again writes nothing", async () => {
    const edits = trackEdits(LOADED);
    const current = { ...LOADED, flag: true };
    await edits.save(edits.edited(current), writers().all);
    expect(edits.edited(current)).toEqual({});
    // Going back to the value first loaded is an edit now.
    expect(edits.edited(LOADED)).toEqual({ flag: false });
  });

  test("a field whose write fails stays edited", async () => {
    const edits = trackEdits(LOADED);
    const current = { ...LOADED, key: "new", flag: true };
    const { all } = writers();
    const failing = {
      ...all,
      key: vi.fn<(value: string) => Promise<unknown>>(async () => Promise.reject(new Error("quota"))),
    };
    await expect(edits.save(edits.edited(current), failing)).rejects.toThrow("quota");
    expect(edits.edited(current)).toEqual({ key: "new" });
  });
});

test("sameValue compares stored values by content", () => {
  expect(sameValue({ a: [1, { b: "c" }] }, { a: [1, { b: "c" }] })).toBe(true);
  expect(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  expect(sameValue(["a"], ["a", "b"])).toBe(false);
  expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  expect(sameValue(null, {})).toBe(false);
  expect(sameValue([], {})).toBe(false);
  expect(sameValue("", false)).toBe(false);
});
