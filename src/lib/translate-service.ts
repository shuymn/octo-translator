import { hashSegments, lookup, store, type Cache } from "./cache.ts";
import type { SourceSegment, TranslationResult } from "./translation.ts";

export type TranslateDeps = {
  getApiKey: () => Promise<string>;
  getCache: () => Promise<Cache>;
  setCache: (cache: Cache) => Promise<void>;
  translate: (segments: SourceSegment[], apiKey: string) => Promise<TranslationResult>;
  now: () => number;
};

export type TranslateService = (key: string, segments: SourceSegment[]) => Promise<TranslationResult>;

// Answers the cached translation of a pull request's segments, or translates them and caches the result. A request
// for segments already being translated (a second tab, or the page rendered again meanwhile) waits for the same answer
// instead of spending another request.
export function createTranslateService(deps: TranslateDeps): TranslateService {
  const inFlight = new Map<string, Promise<TranslationResult>>();
  return async (key, segments) => {
    const hash = await hashSegments(segments);
    const cached = lookup(await deps.getCache(), key, hash);
    if (cached) return { ok: true, translations: cached };
    const id = `${key}\n${hash}`;
    let pending = inFlight.get(id);
    if (!pending) {
      pending = translateAndStore(key, hash, segments, deps).finally(() => inFlight.delete(id));
      inFlight.set(id, pending);
    }
    return pending;
  };
}

async function translateAndStore(
  key: string,
  hash: string,
  segments: SourceSegment[],
  deps: TranslateDeps,
): Promise<TranslationResult> {
  const result = await deps.translate(segments, await deps.getApiKey());
  if (!result.ok) return result;
  try {
    // Read again: another tab may have stored an entry while the request was in flight.
    await deps.setCache(
      store(await deps.getCache(), key, { hash, translations: result.translations, savedAt: deps.now() }),
    );
  } catch {
    // The cache only saves requests; the translation is still good.
  }
  return result;
}
