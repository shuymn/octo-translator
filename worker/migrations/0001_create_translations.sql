-- Translations made by the Worker, one per pull request, text version and model choice (RES-2), as the extension's
-- cache keys them. The table keeps the text version requested last per pull request and choice: storing one deletes
-- those requested earlier, and one requested earlier than a stored version is dropped (worker/src/translations-db.ts).
CREATE TABLE translations (
  -- `owner/repo#number`, lowercased as the extension makes it.
  pr_key TEXT NOT NULL,
  -- SHA-256 of the segments, hex (`hashSegments` in src/lib/cache.ts).
  segments_hash TEXT NOT NULL,
  -- `provider/model/thinking` (`choiceKey` in src/lib/providers.ts).
  choice_key TEXT NOT NULL,
  -- The translations, a JSON array of strings in the order of the segments.
  translations TEXT NOT NULL,
  -- When the request that made it started, in milliseconds since the Unix epoch; orders the text versions.
  requested_at INTEGER NOT NULL,
  -- When it was stored, in milliseconds since the Unix epoch.
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pr_key, segments_hash, choice_key)
) STRICT;
