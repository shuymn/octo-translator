import { parseRepositoryList } from "../../lib/repositories.ts";
import { apiKeyItem, autoTranslateItem, privateRepositoriesItem } from "../../lib/settings.ts";

const form = document.querySelector<HTMLFormElement>("#settings");
const apiKey = document.querySelector<HTMLInputElement>("#api-key");
const autoTranslate = document.querySelector<HTMLInputElement>("#auto-translate");
const repositories = document.querySelector<HTMLTextAreaElement>("#private-repositories");
const repositoriesError = document.querySelector<HTMLElement>("#private-repositories-error");
const status = document.querySelector<HTMLElement>("#status");
if (!form || !apiKey || !autoTranslate || !repositories || !repositoriesError || !status) {
  throw new Error("The options page is missing a field");
}

apiKey.value = await apiKeyItem.getValue();
autoTranslate.checked = await autoTranslateItem.getValue();
repositories.value = (await privateRepositoriesItem.getValue()).join("\n");

const showRepositoriesError = (message: string) => {
  repositoriesError.textContent = message;
  repositories.setAttribute("aria-invalid", String(message !== ""));
};

repositories.addEventListener("input", () => showRepositoriesError(""));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "";
  const parsed = parseRepositoryList(repositories.value);
  if (!parsed.ok) {
    showRepositoriesError(`${parsed.line} 行目は owner/repo の形ではありません。`);
    repositories.focus();
    return;
  }
  showRepositoriesError("");
  await Promise.all([
    apiKeyItem.setValue(apiKey.value.trim()),
    autoTranslateItem.setValue(autoTranslate.checked),
    privateRepositoriesItem.setValue(parsed.repositories),
  ]);
  repositories.value = parsed.repositories.join("\n");
  status.textContent = "保存しました。";
});
