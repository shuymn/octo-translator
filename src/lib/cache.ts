import type { SourceSegment } from "./translation.ts";

// Translations kept per pull request, so a description is translated once until its text changes.

export type CacheEntry = {
  // SHA-256 of the segments sent, so an edited title or description is translated again.
  hash: string;
  translations: string[];
  savedAt: number;
};

export type Cache = Record<string, CacheEntry>;

// Bytes of JSON the cache may take: half of the 10 MB of storage.local, so a write never fails for lack of room.
export const MAX_CACHE_BYTES = 5_000_000;

export async function hashSegments(segments: SourceSegment[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(segments)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function lookup(cache: Cache, key: string, hash: string): string[] | undefined {
  const entry = cache[key];
  return entry?.hash === hash ? entry.translations : undefined;
}

// Answers a new cache with the entry stored, keeping the newest entries that fit in the budget.
export function store(cache: Cache, key: string, entry: CacheEntry): Cache {
  const entries = Object.entries({ ...cache, [key]: entry });
  entries.sort(([, a], [, b]) => b.savedAt - a.savedAt);
  const encoder = new TextEncoder();
  const kept: [string, CacheEntry][] = [];
  let bytes = 0;
  for (const pair of entries) {
    bytes += encoder.encode(JSON.stringify(pair)).length;
    if (bytes > MAX_CACHE_BYTES) break;
    kept.push(pair);
  }
  return Object.fromEntries(kept);
}
