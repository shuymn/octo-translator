import { expect, test } from "vitest";
import { editedKeys, type Keys } from "./key-edits.ts";

test("two options pages saving different keys keep both", () => {
  let stored: Keys = { deepseek: "", openai: "", gemini: "old-gemini" };
  const save = (loaded: Keys, current: Keys) => {
    stored = { ...stored, ...editedKeys(loaded, current) };
  };
  // Both pages open from the same stored keys.
  const first = { ...stored };
  const second = { ...stored };
  save(first, { ...first, openai: " sk-openai " });
  save(second, { ...second, deepseek: "sk-deepseek" });
  expect(stored).toEqual({ deepseek: "sk-deepseek", openai: "sk-openai", gemini: "old-gemini" });
});

test("writes a key cleared on purpose, and nothing when nothing changed", () => {
  const loaded: Keys = { deepseek: "a", openai: "b", gemini: "c" };
  expect(editedKeys(loaded, { ...loaded, gemini: "" })).toEqual({ gemini: "" });
  expect(editedKeys(loaded, loaded)).toEqual({});
});
