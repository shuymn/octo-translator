import { originPattern, parseWorkerUrl, storedOrigin, type WorkerAccess } from "./worker-client.ts";

// The Worker section of the options page, as loaded or last saved and as typed.
export type WorkerForm = { url: string; clientId: string; clientSecret: string };
const WORKER_FORM_FIELDS = ["url", "clientId", "clientSecret"] as const satisfies readonly (keyof WorkerForm)[];

export const WORKER_FORM_ERRORS = ["bad-url", "missing-token"] as const;
export type WorkerFormError = (typeof WORKER_FORM_ERRORS)[number];

// What saving the page does with the Worker. Only a page that edited the section writes it: an options page opened
// before another one saved a Worker would otherwise put its old (or empty) configuration back and drop the newer
// origin's permission. Synchronous, so the permission request that follows still runs inside the save click.
export type WorkerPlan =
  | { kind: "keep" }
  | { kind: "invalid"; code: WorkerFormError; fields: (keyof WorkerForm)[] }
  | { kind: "save"; access: WorkerAccess | null };

export function planWorkerSave(loaded: WorkerForm, current: WorkerForm): WorkerPlan {
  if (WORKER_FORM_FIELDS.every((name) => loaded[name] === current[name])) return { kind: "keep" };
  // An empty URL turns the Worker off; its token goes with it.
  if (current.url.trim() === "") return { kind: "save", access: null };
  const url = parseWorkerUrl(current.url);
  if (!url.ok) return { kind: "invalid", code: "bad-url", fields: ["url"] };
  const clientId = current.clientId.trim();
  const clientSecret = current.clientSecret.trim();
  const missing = (["clientId", "clientSecret"] as const).filter((name) => current[name].trim() === "");
  if (missing.length > 0) return { kind: "invalid", code: "missing-token", fields: missing };
  return { kind: "save", access: { origin: url.origin, clientId, clientSecret } };
}

export type WorkerStoreDeps = {
  getStored: () => Promise<unknown>;
  // Writes the whole configuration in one item, so the origin and its token change together.
  setStored: (access: WorkerAccess | null) => Promise<void>;
  removePermission: (origins: string[]) => Promise<unknown>;
};

// Saves a planned configuration, then drops the permission of the origin it replaced. Failing to drop it leaves an
// unused grant, nothing more.
export async function storeWorker(access: WorkerAccess | null, deps: WorkerStoreDeps): Promise<void> {
  const previous = storedOrigin(await deps.getStored());
  await deps.setStored(access);
  if (previous !== undefined && previous !== access?.origin) {
    await deps.removePermission([originPattern(previous)]).catch(() => undefined);
  }
}

// The form's fields for a stored configuration.
export function workerForm(access: WorkerAccess | null): WorkerForm {
  return access === null
    ? { url: "", clientId: "", clientSecret: "" }
    : { url: access.origin, clientId: access.clientId, clientSecret: access.clientSecret };
}
