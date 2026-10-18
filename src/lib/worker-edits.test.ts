import { describe, expect, test } from "vitest";
import { originPattern, storedAccess, type WorkerAccess } from "./worker-client.ts";
import { normalizeWorkerForm, parseWorkerForm, storeWorker, workerForm, type WorkerStoreDeps } from "./worker-edits.ts";

const A: WorkerAccess = { origin: "https://a.example.com", clientId: "a-id", clientSecret: "a-secret" };
const B: WorkerAccess = { origin: "https://b.example.com", clientId: "b-id", clientSecret: "b-secret" };

// One browser: the stored item and the granted origins, shared by every options page.
function browserState(initial: WorkerAccess | null) {
  let stored: unknown = initial;
  const granted = new Set(initial ? [originPattern(initial.origin)] : []);
  const deps: WorkerStoreDeps = {
    getStored: async () => stored,
    setStored: async (access) => {
      stored = access;
    },
    removePermission: async (origins) => {
      for (const origin of origins) granted.delete(origin);
    },
  };
  return { deps, granted, stored: () => stored };
}

describe("parseWorkerForm", () => {
  test("reads the whole configuration, trimmed and as one origin", () => {
    expect(parseWorkerForm({ url: " https://B.example.com/ ", clientId: " b-id ", clientSecret: "b-secret " })).toEqual(
      {
        ok: true,
        access: B,
      },
    );
  });

  test("turns the Worker off, with its token, when the URL is cleared", () => {
    expect(parseWorkerForm({ ...workerForm(A), url: " " })).toEqual({ ok: true, access: null });
  });

  test("refuses a URL that is not an https origin, or half a token", () => {
    expect(parseWorkerForm({ ...workerForm(A), url: "https://a.example.com/v1" })).toEqual({
      ok: false,
      code: "bad-url",
      fields: ["url"],
    });
    expect(parseWorkerForm({ url: A.origin, clientId: "a-id", clientSecret: " " })).toEqual({
      ok: false,
      code: "missing-token",
      fields: ["clientSecret"],
    });
  });
});

describe("normalizeWorkerForm", () => {
  test("shows a valid form as its stored configuration would, so retyping it is not an edit", () => {
    expect(
      normalizeWorkerForm({ url: "https://A.example.com/", clientId: " a-id", clientSecret: "a-secret " }),
    ).toEqual(workerForm(A));
    expect(normalizeWorkerForm({ url: "", clientId: "left-over", clientSecret: "" })).toEqual(workerForm(null));
  });

  test("keeps an invalid form as typed, so it differs from any stored one and is refused on save", () => {
    const typed = { url: "http://a.example.com", clientId: "a-id", clientSecret: "a-secret" };
    expect(normalizeWorkerForm(typed)).toEqual(typed);
  });
});

describe("KEY-4: storeWorker", () => {
  test("writes one item and drops the replaced origin's permission", async () => {
    const state = browserState(A);
    state.granted.add(originPattern(B.origin));
    await storeWorker(B, state.deps);
    expect(storedAccess(state.stored())).toEqual(B);
    expect(state.granted).toEqual(new Set([originPattern(B.origin)]));
  });

  test("drops the permission when the Worker is turned off, and keeps it when the origin stays", async () => {
    const off = browserState(A);
    await storeWorker(null, off.deps);
    expect(off.stored()).toBeNull();
    expect(off.granted).toEqual(new Set());

    const same = browserState(A);
    await storeWorker({ ...A, clientSecret: "rotated" }, same.deps);
    expect(same.granted).toEqual(new Set([originPattern(A.origin)]));
  });

  test("still saves when the old permission cannot be dropped", async () => {
    const state = browserState(A);
    await storeWorker(B, {
      ...state.deps,
      removePermission: async () => {
        throw new Error("required permission");
      },
    });
    expect(state.stored()).toEqual(B);
  });
});
