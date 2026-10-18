import { apiKeyItems } from "../../lib/api-keys.ts";
import {
  defaultChoice,
  parseChoice,
  PROVIDER_SPECS,
  PROVIDERS,
  resolveChoice,
  THINKING_LABELS,
  THINKING_LEVELS,
  withModel,
  type ModelChoice,
} from "../../lib/providers.ts";
import { editedKeys, type Keys } from "../../lib/key-edits.ts";
import { parseRepositoryList } from "../../lib/repositories.ts";
import { autoTranslateItem, modelChoiceItem, privateRepositoriesItem } from "../../lib/settings.ts";

function field<T extends HTMLElement>(selector: string, type: new () => T): T {
  const element = document.querySelector(selector);
  if (!(element instanceof type)) throw new Error(`The options page is missing ${selector}`);
  return element;
}

const form = field("#settings", HTMLFormElement);
const provider = field("#provider", HTMLSelectElement);
const model = field("#model", HTMLSelectElement);
const thinking = field("#thinking", HTMLSelectElement);
const thinkingError = field("#thinking-error", HTMLElement);
const apiKeyLabel = field("#api-key-label", HTMLElement);
const apiKey = field("#api-key", HTMLInputElement);
const apiKeyHelp = field("#api-key-help", HTMLElement);
const autoTranslate = field("#auto-translate", HTMLInputElement);
const repositories = field("#private-repositories", HTMLTextAreaElement);
const repositoriesError = field("#private-repositories-error", HTMLElement);
const status = field("#status", HTMLElement);

// The keys as loaded or last saved, and as typed for each provider (kept while another provider is selected).
let loadedKeys: Keys = {
  deepseek: await apiKeyItems.deepseek.getValue(),
  openai: await apiKeyItems.openai.getValue(),
  gemini: await apiKeyItems.gemini.getValue(),
};
const keys: Keys = { ...loadedKeys };
let choice = resolveChoice(await modelChoiceItem.getValue());
autoTranslate.checked = await autoTranslateItem.getValue();
repositories.value = (await privateRepositoriesItem.getValue()).join("\n");

function fillSelect(select: HTMLSelectElement, options: readonly { value: string; label: string }[], value: string) {
  select.replaceChildren(
    ...options.map((option) => {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      return element;
    }),
  );
  select.value = value;
}

// Offers only the models of the chosen provider and the levels of the chosen model.
function render(next: ModelChoice) {
  choice = next;
  const spec = PROVIDER_SPECS[next.provider];
  fillSelect(
    provider,
    PROVIDERS.map((id) => ({ value: id, label: PROVIDER_SPECS[id].label })),
    next.provider,
  );
  fillSelect(
    model,
    spec.models.map((entry) => ({ value: entry.id, label: entry.label })),
    next.model,
  );
  const levels = spec.models.find((entry) => entry.id === next.model)?.thinking ?? [];
  fillSelect(
    thinking,
    levels.map((level) => ({ value: level, label: THINKING_LABELS[level] })),
    next.thinking,
  );
  apiKeyLabel.textContent = `${spec.label} API キー`;
  apiKey.value = keys[next.provider];
  const link = document.createElement("a");
  link.href = spec.keySite.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = spec.keySite.name;
  apiKeyHelp.replaceChildren(
    link,
    ` で発行したキーです。このブラウザーにだけ保存され、${spec.label} API への送信にだけ使います。`,
  );
}

const showThinkingError = (message: string) => {
  thinkingError.textContent = message;
  thinking.setAttribute("aria-invalid", String(message !== ""));
};

const showRepositoriesError = (message: string) => {
  repositoriesError.textContent = message;
  repositories.setAttribute("aria-invalid", String(message !== ""));
};

render(choice);

apiKey.addEventListener("input", () => {
  keys[choice.provider] = apiKey.value;
});
provider.addEventListener("change", () => {
  const next = PROVIDERS.find((id) => id === provider.value);
  if (next) render(defaultChoice(next));
  showThinkingError("");
});
model.addEventListener("change", () => {
  render(withModel(choice, model.value));
  showThinkingError("");
});
thinking.addEventListener("change", () => {
  choice = { ...choice, thinking: THINKING_LEVELS.find((level) => level === thinking.value) ?? choice.thinking };
  showThinkingError("");
});
repositories.addEventListener("input", () => showRepositoriesError(""));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "";
  // The selects offer only supported levels; this refuses anything else that reaches the form.
  const selected = parseChoice({ provider: provider.value, model: model.value, thinking: thinking.value });
  if (!selected.ok) {
    showThinkingError("このモデルはこの思考の深さに対応していません。");
    thinking.focus();
    return;
  }
  showThinkingError("");
  const parsed = parseRepositoryList(repositories.value);
  if (!parsed.ok) {
    showRepositoriesError(`${parsed.line} 行目は owner/repo の形ではありません。`);
    repositories.focus();
    return;
  }
  showRepositoriesError("");
  const edited = editedKeys(loadedKeys, keys);
  await Promise.all([
    // Only the keys changed here: another options page may have saved the others since this one loaded.
    ...PROVIDERS.map((id) => {
      const value = edited[id];
      return value === undefined ? undefined : apiKeyItems[id].setValue(value);
    }),
    modelChoiceItem.setValue(selected.choice),
    autoTranslateItem.setValue(autoTranslate.checked),
    privateRepositoriesItem.setValue(parsed.repositories),
  ]);
  Object.assign(keys, edited);
  loadedKeys = { ...keys };
  apiKey.value = keys[choice.provider];
  repositories.value = parsed.repositories.join("\n");
  status.textContent = "保存しました。";
});
