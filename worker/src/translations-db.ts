/**
 * Translations stored in D1 (`worker/migrations/`). Every statement is a constant with `?` placeholders and every value
 * is bound (RES-3); `src/lib/source-analysis.test.ts` refuses SQL built from strings in `worker/src`.
 * https://developers.cloudflare.com/d1/worker-api/prepared-statements/
 */
import * as v from "valibot";

export type StoredKey = {
  /** `owner/repo#number`. */
  readonly prKey: string;
  /** SHA-256 of the segments (`hashSegments`). */
  readonly hash: string;
  /** The provider, model and thinking level (`choiceKey`). */
  readonly choice: string;
};

export type TranslationStore = {
  /** The stored translations for exactly this key, if there are as many as `expected`. */
  lookup: (key: StoredKey, expected: number) => Promise<string[] | undefined>;
  /**
   * Stores the translations of a request made at `requestedAt`, and deletes the pull request's versions for the same
   * choice requested earlier. A version requested later than this one already stored wins: this one is dropped.
   */
  save: (key: StoredKey, translations: readonly string[], requestedAt: number) => Promise<void>;
};

const SELECT_TRANSLATIONS =
  "SELECT translations FROM translations WHERE pr_key = ? AND segments_hash = ? AND choice_key = ?";

// Retention: one text version per pull request and choice, the one requested last. Versions are ordered by when their
// request started, not when it finished, so a slow translation of the older text cannot replace the newer one. An older
// version is still asked for by a tab that shows the older text; it is then translated again, not stored over the newer.
const DELETE_EARLIER_VERSIONS =
  "DELETE FROM translations WHERE pr_key = ? AND choice_key = ? AND segments_hash <> ? AND requested_at < ?";

// Inserts unless another version of the pull request and choice was requested at the same time or later; replaces the
// same version only with a later request's.
const STORE_UNLESS_SUPERSEDED =
  "INSERT INTO translations (pr_key, segments_hash, choice_key, translations, requested_at, created_at) " +
  "SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM translations " +
  "WHERE pr_key = ? AND choice_key = ? AND segments_hash <> ? AND requested_at >= ?) " +
  "ON CONFLICT (pr_key, segments_hash, choice_key) DO UPDATE SET translations = excluded.translations, " +
  "requested_at = excluded.requested_at, created_at = excluded.created_at " +
  "WHERE excluded.requested_at >= translations.requested_at";

const RowSchema = v.object({ translations: v.string() });
const TranslationsSchema = v.array(v.string());

export function createTranslationStore(db: D1Database, now: () => number): TranslationStore {
  return {
    async lookup({ prKey, hash, choice }, expected) {
      const row = await db.prepare(SELECT_TRANSLATIONS).bind(prKey, hash, choice).first();
      const parsed = v.safeParse(RowSchema, row);
      if (!parsed.success) return undefined;
      let json: unknown;
      try {
        json = JSON.parse(parsed.output.translations);
      } catch {
        return undefined;
      }
      const translations = v.safeParse(TranslationsSchema, json);
      return translations.success && translations.output.length === expected ? translations.output : undefined;
    },
    async save({ prKey, hash, choice }, translations, requestedAt) {
      // One batch is one transaction: the deletion and the conditional insert see the same rows.
      await db.batch([
        db.prepare(DELETE_EARLIER_VERSIONS).bind(prKey, choice, hash, requestedAt),
        db
          .prepare(STORE_UNLESS_SUPERSEDED)
          .bind(
            prKey,
            hash,
            choice,
            JSON.stringify(translations),
            requestedAt,
            now(),
            prKey,
            choice,
            hash,
            requestedAt,
          ),
      ]);
    },
  };
}
