import * as v from "valibot";
import { expect, test } from "vitest";
import { MessageSchema } from "./messages.ts";

// MSG-1: the background acts only on messages of known shapes.
test("MSG-1: parses the messages the content script sends", () => {
  expect(
    v.is(MessageSchema, { type: "translate", key: "o/r#1", segments: [{ kind: "paragraph", text: "Text" }] }),
  ).toBe(true);
  expect(v.is(MessageSchema, { type: "open-options" })).toBe(true);
});

test.each([
  ["an unknown type", { type: "read-api-key" }],
  ["no type", { key: "o/r#1", segments: [] }],
  ["a segment of an unknown kind", { type: "translate", key: "o/r#1", segments: [{ kind: "script", text: "x" }] }],
  ["a segment that is not text", { type: "translate", key: "o/r#1", segments: [{ kind: "paragraph", text: 1 }] }],
  ["a missing key", { type: "translate", segments: [] }],
  ["not an object", "translate"],
])("MSG-1: refuses %s", (_, message) => {
  expect(v.is(MessageSchema, message)).toBe(false);
});
