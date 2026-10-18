import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  // Every module imports what it uses, so oxlint and tsc see the same code as the build.
  imports: false,
  manifest: {
    name: "Octo Translator",
    description: "GitHub のプルリクエストのタイトルと本文を Gemini で日本語に翻訳します",
    permissions: ["storage"],
    host_permissions: ["https://generativelanguage.googleapis.com/*"],
  },
});
