import { browser } from "wxt/browser";
import { apiKeyItems, workerAccessItem } from "../../lib/api-keys.ts";
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
  type Provider,
} from "../../lib/providers.ts";
import { trackEdits } from "../../lib/edits.ts";
import { parseRepositoryList } from "../../lib/repositories.ts";
import { autoTranslateItem, modelChoiceItem, privateRepositoriesItem } from "../../lib/settings.ts";
import { originPattern, storedAccess, type WorkerAccess } from "../../lib/worker-client.ts";
import {
  normalizeWorkerForm,
  parseWorkerForm,
  storeWorker,
  workerForm,
  type WorkerForm,
  type WorkerFormError,
} from "../../lib/worker-edits.ts";

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
const workerUrl = field("#worker-url", HTMLInputElement);
const workerClientId = field("#worker-client-id", HTMLInputElement);
const workerClientSecret = field("#worker-client-secret", HTMLInputElement);
const workerError = field("#worker-error", HTMLElement);
const status = field("#status", HTMLElement);

const workerInputs: Record<keyof WorkerForm, HTMLInputElement> = {
  url: workerUrl,
  clientId: workerClientId,
  clientSecret: workerClientSecret,
};
const WORKER_ERROR_MESSAGES: Record<WorkerFormError, string> = {
  "bad-url": "https:// で始まり、パスのない URL を書いてください。",
  "missing-token": "Worker を使うにはサービストークンの両方が必要です。",
};

type Keys = Record<Provider, string>;

const writeKey = (id: Provider) => (value: string) => apiKeyItems[id].setValue(value);

// The keys as typed for each provider (kept while another provider is selected).
const keys: Keys = {
  deepseek: await apiKeyItems.deepseek.getValue(),
  openai: await apiKeyItems.openai.getValue(),
  gemini: await apiKeyItems.gemini.getValue(),
};
let choice = resolveChoice(await modelChoiceItem.getValue());
autoTranslate.checked = await autoTranslateItem.getValue();
const loadedRepositories = await privateRepositoriesItem.getValue();
repositories.value = loadedRepositories.join("\n");
const loadedWorker = workerForm(storedAccess(await workerAccessItem.getValue()) ?? null);

// Every setting this page writes, as loaded. Saving writes only those edited here (`trackEdits`).
type Values = Keys & {
  modelChoice: ModelChoice;
  autoTranslate: boolean;
  privateRepositories: string[];
  worker: WorkerForm;
};
const edits = trackEdits<Values>({
  ...keys,
  modelChoice: choice,
  autoTranslate: autoTranslate.checked,
  privateRepositories: loadedRepositories,
  worker: loadedWorker,
});

function showWorker(values: WorkerForm) {
  workerUrl.value = values.url;
  workerClientId.value = values.clientId;
  workerClientSecret.value = values.clientSecret;
}
showWorker(loadedWorker);
const currentWorker = (): WorkerForm => ({
  url: workerUrl.value,
  clientId: workerClientId.value,
  clientSecret: workerClientSecret.value,
});

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

const showWorkerError = (message: string, invalid: readonly HTMLInputElement[] = []) => {
  workerError.textContent = message;
  for (const input of [workerUrl, workerClientId, workerClientSecret]) {
    input.setAttribute("aria-invalid", String(invalid.includes(input)));
  }
};

// The host permission for the Worker's origin. It must be requested from the user's gesture, before any other await.
async function requestOrigin(origin: string): Promise<boolean> {
  try {
    return await browser.permissions.request({ origins: [originPattern(origin)] });
  } catch {
    return false;
  }
}

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
for (const input of [workerUrl, workerClientId, workerClientSecret]) {
  input.addEventListener("input", () => showWorkerError(""));
}

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
  // Each setting as it would be stored; only those that differ from what this page loaded or last saved are written.
  const changes = edits.edited({
    deepseek: keys.deepseek.trim(),
    openai: keys.openai.trim(),
    gemini: keys.gemini.trim(),
    modelChoice: selected.choice,
    autoTranslate: autoTranslate.checked,
    privateRepositories: parsed.repositories,
    worker: normalizeWorkerForm(currentWorker()),
  });
  // The Worker section is checked, and its origin asked for, only when it was edited here.
  let workerAccess: WorkerAccess | null = null;
  if (changes.worker !== undefined) {
    const worker = parseWorkerForm(changes.worker);
    if (!worker.ok) {
      const inputs = worker.fields.map((name) => workerInputs[name]);
      showWorkerError(WORKER_ERROR_MESSAGES[worker.code], inputs);
      inputs[0]?.focus();
      return;
    }
    workerAccess = worker.access;
    // The first await of the handler: Chrome asks only inside the click's user gesture.
    if (workerAccess !== null && !(await requestOrigin(workerAccess.origin))) {
      showWorkerError("この URL への接続が許可されなかったため、保存しませんでした。", [workerUrl]);
      workerUrl.focus();
      return;
    }
  }
  showWorkerError("");
  await edits.save(changes, {
    deepseek: writeKey("deepseek"),
    openai: writeKey("openai"),
    gemini: writeKey("gemini"),
    modelChoice: (value) => modelChoiceItem.setValue(value),
    autoTranslate: (value) => autoTranslateItem.setValue(value),
    privateRepositories: (value) => privateRepositoriesItem.setValue(value),
    // One item, written whole, then the replaced origin's permission dropped.
    worker: () =>
      storeWorker(workerAccess, {
        getStored: () => workerAccessItem.getValue(),
        setStored: (access) => workerAccessItem.setValue(access),
        removePermission: (origins) => browser.permissions.remove({ origins }),
      }),
  });
  for (const id of PROVIDERS) keys[id] = keys[id].trim();
  apiKey.value = keys[choice.provider];
  repositories.value = parsed.repositories.join("\n");
  if (changes.worker !== undefined) showWorker(changes.worker);
  status.textContent = "保存しました。";
});
