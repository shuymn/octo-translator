import { describe, expect, test } from "vitest";
import {
  DEFAULT_CHOICE,
  defaultChoice,
  parseChoice,
  PROVIDER_SPECS,
  PROVIDERS,
  resolveChoice,
  withModel,
} from "./providers.ts";

describe("the provider table", () => {
  test("defaults to DeepSeek V4.1 Flash without thinking", () => {
    expect(DEFAULT_CHOICE).toEqual({ provider: "deepseek", model: "deepseek-flash", thinking: "none" });
  });

  test("keeps Gemini as it was: 3.8 Flash with high thinking", () => {
    expect(defaultChoice("gemini")).toEqual({ provider: "gemini", model: "gemini-3.8-flash", thinking: "high" });
  });

  test("offers each model's default level among its levels", () => {
    for (const provider of PROVIDERS) {
      for (const model of PROVIDER_SPECS[provider].models) expect(model.thinking).toContain(model.defaultThinking);
    }
  });
});

describe("resolveChoice", () => {
  test("uses the default when nothing valid is stored", () => {
    expect(resolveChoice(undefined)).toEqual(DEFAULT_CHOICE);
    expect(resolveChoice({ provider: "other", model: "m", thinking: "none" })).toEqual(DEFAULT_CHOICE);
  });

  test("keeps a supported choice", () => {
    const choice = { provider: "openai", model: "gpt-6.1-sol", thinking: "high" };
    expect(resolveChoice(choice)).toEqual(choice);
  });

  test("falls back to the provider's default for a model or level it does not offer", () => {
    expect(resolveChoice({ provider: "openai", model: "gpt-6.1-sol", thinking: "none" })).toEqual(
      defaultChoice("openai"),
    );
    expect(resolveChoice({ provider: "gemini", model: "gemini-1.0", thinking: "high" })).toEqual(
      defaultChoice("gemini"),
    );
    expect(resolveChoice({ provider: "openai", model: "gpt-6.1-sol", thinking: "ultra" })).toEqual(
      defaultChoice("openai"),
    );
    expect(resolveChoice({ provider: "gemini" })).toEqual(defaultChoice("gemini"));
  });
});

describe("parseChoice", () => {
  test("accepts a combination the table offers", () => {
    expect(parseChoice({ provider: "deepseek", model: "deepseek-flash", thinking: "max" })).toEqual({
      ok: true,
      choice: { provider: "deepseek", model: "deepseek-flash", thinking: "max" },
    });
  });

  test.each([
    ["a level the model does not take", { provider: "deepseek", model: "deepseek-flash", thinking: "medium" }],
    ["a model of another provider", { provider: "gemini", model: "deepseek-flash", thinking: "high" }],
    ["an unknown level", { provider: "openai", model: "gpt-6-luna", thinking: "ultra" }],
  ])("refuses %s", (_, input) => {
    expect(parseChoice(input)).toEqual({ ok: false, code: "unsupported" });
  });
});

describe("withModel", () => {
  test("keeps the level when the new model takes it, and uses the model's default otherwise", () => {
    const luna = { provider: "openai", model: "gpt-6-luna", thinking: "high" } as const;
    expect(withModel(luna, "gpt-6.1-sol")).toEqual({ ...luna, model: "gpt-6.1-sol" });
    expect(withModel({ ...luna, thinking: "none" }, "gpt-6.1-sol")).toEqual({
      provider: "openai",
      model: "gpt-6.1-sol",
      thinking: "low",
    });
  });
});
