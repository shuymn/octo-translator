-- The scheduled ahead-of-time translation of the owner's own pull requests (worker/src/scheduled.ts).

-- Each text version the schedule has worked on, keyed as the translations are (RES-2), so a version is translated once:
-- a run claims it before calling the provider, and another run skips it while the claim holds (RES-3).
CREATE TABLE scheduled_versions (
  -- `owner/repo#number`, lowercased as the extension makes it.
  pr_key TEXT NOT NULL,
  -- SHA-256 of the segments, hex (`hashSegments` in src/lib/cache.ts).
  segments_hash TEXT NOT NULL,
  -- `provider/model/thinking` (`choiceKey` in src/lib/providers.ts).
  choice_key TEXT NOT NULL,
  -- `pending` (not translated yet, or failed and retried by a later run), `claimed` (a run is translating it) or `done`
  -- (stored, or dropped because a version requested later was stored). A `done` version missing from the translations
  -- may be claimed again while it has attempts left.
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'done')),
  -- Provider calls made for this version; a version stops being retried at the cap (`MAX_ATTEMPTS`).
  attempts INTEGER NOT NULL,
  -- Until when, in milliseconds since the Unix epoch, a claim holds; a run that died leaves it to expire.
  claimed_until INTEGER NOT NULL,
  -- When the row last changed, in milliseconds since the Unix epoch; the retention sweep reads it.
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (pr_key, segments_hash, choice_key)
) STRICT;

-- Provider calls made by the schedule per UTC day, counted before each call against the daily cap (RES-3).
CREATE TABLE scheduled_budget (
  -- `YYYY-MM-DD`, in UTC.
  day TEXT PRIMARY KEY,
  provider_calls INTEGER NOT NULL
) STRICT;

-- Where the next search starts, one row. `updated_since`: the `updated:>=` bound, in milliseconds since the Unix epoch;
-- it moves only past pull requests a run finished with. `created_since`: -1, or, while more pull requests than a page
-- share the update time `updated_since`, the `created:>=` bound of a search over that second ordered by creation, so
-- they are read across runs by a key their updates do not change. The position only moves forward
-- (worker/src/scheduled-db.ts).
CREATE TABLE scheduled_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  updated_since INTEGER NOT NULL,
  created_since INTEGER NOT NULL CHECK (created_since >= -1)
) STRICT;

-- The retention sweep deletes by age (worker/src/scheduled-db.ts).
CREATE INDEX translations_created_at ON translations (created_at);
CREATE INDEX scheduled_versions_updated_at ON scheduled_versions (updated_at);
