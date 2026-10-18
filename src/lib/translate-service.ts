import { hashSegments, lookup, store, type Cache } from "./cache.ts";
import { choiceKey, type ModelChoice, type Provider } from "./providers.ts";
import type { SourceSegment, TranslationResult } from "./translation.ts";
import {
  WORKER_FAILURE_HANDLING,
  type WorkerAccess,
  type WorkerRequest,
  type WorkerResult,
  type WorkerSetting,
} from "./worker-client.ts";

export type TranslateDeps = {
  getChoice: () => Promise<ModelChoice>;
  getApiKey: (provider: Provider) => Promise<string>;
  getCache: () => Promise<Cache>;
  setCache: (cache: Cache) => Promise<void>;
  translate: (segments: SourceSegment[], choice: ModelChoice, apiKey: string) => Promise<TranslationResult>;
  getWorker: () => Promise<WorkerSetting>;
  translateWithWorker: (access: WorkerAccess, request: WorkerRequest) => Promise<WorkerResult>;
  now: () => number;
};

export type TranslateService = (key: string, segments: SourceSegment[]) => Promise<TranslationResult>;

// Answers the cached translation of a pull request's segments, or translates them (through the Worker when one is
// configured) and caches the result. A request
// for segments already being translated (a second tab, or the page rendered again meanwhile) waits for the same answer
// instead of spending another request.
export function createTranslateService(deps: TranslateDeps): TranslateService {
  const inFlight = new Map<string, Promise<TranslationResult>>();
  return async (key, segments) => {
    const choice = await deps.getChoice();
    const model = choiceKey(choice);
    const hash = await hashSegments(segments);
    const cached = lookup(await deps.getCache(), key, hash, model);
    if (cached) return { ok: true, translations: cached };
    const id = `${key}\n${hash}\n${model}`;
    let pending = inFlight.get(id);
    if (!pending) {
      pending = translateAndStore(key, hash, model, segments, choice, deps).finally(() => inFlight.delete(id));
      inFlight.set(id, pending);
    }
    return pending;
  };
}

async function translateAndStore(
  key: string,
  hash: string,
  model: string,
  segments: SourceSegment[],
  choice: ModelChoice,
  deps: TranslateDeps,
): Promise<TranslationResult> {
  const result = await translateOnce(key, segments, choice, deps);
  if (!result.ok) return result;
  try {
    // Read again: another tab may have stored an entry while the request was in flight.
    await deps.setCache(
      store(await deps.getCache(), key, { hash, model, translations: result.translations, savedAt: deps.now() }),
    );
  } catch {
    // The cache only saves requests; the translation is still good.
  }
  return result;
}

// Through the Worker when one is configured, locally otherwise. A Worker that cannot be reached falls back to the local
// key, as without a Worker; a Worker that refuses does not, so a broken setup shows instead of being hidden. The
// provider key is read only for a local translation and never reaches the Worker (KEY-4).
async function translateOnce(
  key: string,
  segments: SourceSegment[],
  choice: ModelChoice,
  deps: TranslateDeps,
): Promise<TranslationResult> {
  const worker = await deps.getWorker();
  switch (worker.state) {
    case "off":
      return deps.translate(segments, choice, await deps.getApiKey(choice.provider));
    case "invalid":
      return { ok: false, code: "worker-rejected" };
    case "on": {
      const remote = await deps.translateWithWorker(worker.access, { key, segments, choice });
      if (remote.ok) return remote.result;
      const handling = WORKER_FAILURE_HANDLING[remote.code];
      if (!handling.fallBack) return { ok: false, code: handling.code };
      const apiKey = await deps.getApiKey(choice.provider);
      if (apiKey === "") return { ok: false, code: handling.code };
      return deps.translate(segments, choice, apiKey);
    }
    default:
      return worker satisfies never;
  }
}
