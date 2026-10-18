import { describe, expect, test } from "vitest";
import { originPattern, storedAccess, type WorkerAccess } from "./worker-client.ts";
import { planWorkerSave, storeWorker, workerForm, type WorkerForm, type WorkerStoreDeps } from "./worker-edits.ts";

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

// What an options page does on save: plan from what it loaded and shows, then store when the plan says so. The
// permission request runs in Chrome; here a saved origin counts as granted.
async function save(page: { loaded: WorkerForm; current: WorkerForm }, state: ReturnType<typeof browserState>) {
  const plan = planWorkerSave(page.loaded, page.current);
  if (plan.kind !== "save") return plan;
  if (plan.access) state.granted.add(originPattern(plan.access.origin));
  await storeWorker(plan.access, state.deps);
  return plan;
}

describe("KEY-4: the Worker section of a stale options page", () => {
  test("an unrelated save leaves a newer Worker configuration and its permission intact", async () => {
    const state = browserState(null);
    // Both pages open while no Worker is saved.
    const stale = { loaded: workerForm(null), current: workerForm(null) };
    const fresh = { loaded: workerForm(null), current: workerForm(B) };
    await save(fresh, state);
    expect(state.stored()).toEqual(B);
    expect(state.granted).toEqual(new Set([originPattern(B.origin)]));

    // The stale page saves its other settings; its Worker fields are untouched.
    await expect(save(stale, state)).resolves.toEqual({ kind: "keep" });
    expect(state.stored()).toEqual(B);
    expect(state.granted).toEqual(new Set([originPattern(B.origin)]));
  });

  test("a stale page showing Worker A does not put A back over B", async () => {
    const state = browserState(A);
    const stale = { loaded: workerForm(A), current: workerForm(A) };
    await save({ loaded: workerForm(A), current: workerForm(B) }, state);
    await save(stale, state);
    expect(state.stored()).toEqual(B);
    expect(state.granted).toEqual(new Set([originPattern(B.origin)]));
  });
});

describe("planWorkerSave", () => {
  test("saves the whole configuration when any field was edited, trimmed and as one origin", () => {
    const loaded = workerForm(A);
    expect(planWorkerSave(loaded, { ...loaded, clientSecret: " new-secret " })).toEqual({
      kind: "save",
      access: { ...A, clientSecret: "new-secret" },
    });
    expect(planWorkerSave(loaded, { ...loaded, url: "https://B.example.com/" })).toEqual({
      kind: "save",
      access: { ...A, origin: "https://b.example.com" },
    });
  });

  test("turns the Worker off, with its token, when the URL is cleared", () => {
    expect(planWorkerSave(workerForm(A), { ...workerForm(A), url: " " })).toEqual({ kind: "save", access: null });
  });

  test("refuses a URL that is not an https origin, or half a token", () => {
    const loaded = workerForm(null);
    expect(planWorkerSave(loaded, { ...workerForm(A), url: "https://a.example.com/v1" })).toEqual({
      kind: "invalid",
      code: "bad-url",
      fields: ["url"],
    });
    expect(planWorkerSave(loaded, { url: A.origin, clientId: "a-id", clientSecret: " " })).toEqual({
      kind: "invalid",
      code: "missing-token",
      fields: ["clientSecret"],
    });
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
