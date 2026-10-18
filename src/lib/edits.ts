// The only way the options page writes a setting: a field is written when the owner edited it on this page since it
// loaded or last saved, and never otherwise. An options page opened before another one saved would otherwise write its
// stale values back over the newer ones; that happened to the API keys and then to the Worker configuration.
//
// Each field holds the value as it would be stored (trimmed, parsed), so a change that stores the same value is not an
// edit, and clearing a field is one.

export type Writers<Values> = { readonly [Name in keyof Values]: (value: Values[Name]) => Promise<unknown> };

export type Edits<Values> = {
  // The fields whose value differs from the one loaded or last saved.
  edited: (current: Values) => Partial<Values>;
  // Writes each edited field with its writer (one per field, so a field cannot be left out), then takes the written
  // values as the new baseline. A field whose write fails keeps its old baseline and counts as edited next time.
  save: (changes: Partial<Values>, writers: Writers<Values>) => Promise<void>;
};

export function trackEdits<Values extends Record<string, unknown>>(loaded: Values): Edits<Values> {
  const baseline: Values = { ...loaded };
  const names = Object.keys(loaded) as (keyof Values)[];
  return {
    edited: (current) => {
      const changes: Partial<Values> = {};
      for (const name of names) {
        if (!sameValue(current[name], baseline[name])) changes[name] = current[name];
      }
      return changes;
    },
    save: async (changes, writers) => {
      const write = async (name: keyof Values) => {
        const value = changes[name];
        // A field holds no `undefined` when stored, so an absent field and an undefined one are both unedited.
        if (value === undefined) return;
        await writers[name](value);
        baseline[name] = value;
      };
      const results = await Promise.allSettled(names.map(write));
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    },
  };
}

// Equality of stored values: primitives, arrays and plain objects, whatever the order of an object's keys.
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameValue(item, b[index]))
    );
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((key) => Object.hasOwn(b, key) && sameValue(Reflect.get(a, key), Reflect.get(b, key)))
  );
}
