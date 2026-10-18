import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  // Every module imports what it uses, so oxlint and tsc see the same code as the build.
  imports: false,
  manifest: {
    name: "Octo Translator",
    description: "GitHub のプルリクエストのタイトルと本文を日本語に翻訳します",
    permissions: ["storage"],
    // The provider endpoints only (KEY-2): `ENDPOINTS` in src/lib/responses.ts and `ENDPOINT` in src/lib/gemini.ts.
    host_permissions: [
      "https://api.deepseek.com/*",
      "https://api.openai.com/*",
      "https://generativelanguage.googleapis.com/*",
    ],
  },
});
