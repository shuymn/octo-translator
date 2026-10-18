import { originPattern, parseWorkerUrl, storedOrigin, type WorkerAccess } from "./worker-client.ts";

// The Worker section of the options page, as typed or as a stored configuration shows in it.
export type WorkerForm = { url: string; clientId: string; clientSecret: string };

export const WORKER_FORM_ERRORS = ["bad-url", "missing-token"] as const;
export type WorkerFormError = (typeof WORKER_FORM_ERRORS)[number];

export type ParsedWorkerForm =
  | { ok: true; access: WorkerAccess | null }
  | { ok: false; code: WorkerFormError; fields: (keyof WorkerForm)[] };

// The configuration the section asks for: none (an empty URL turns the Worker off, and its token goes with it), or an
// https origin with both halves of the token. Synchronous, so the permission request that follows still runs inside
// the save click.
export function parseWorkerForm(form: WorkerForm): ParsedWorkerForm {
  if (form.url.trim() === "") return { ok: true, access: null };
  const url = parseWorkerUrl(form.url);
  if (!url.ok) return { ok: false, code: "bad-url", fields: ["url"] };
  const missing = (["clientId", "clientSecret"] as const).filter((name) => form[name].trim() === "");
  if (missing.length > 0) return { ok: false, code: "missing-token", fields: missing };
  return {
    ok: true,
    access: { origin: url.origin, clientId: form.clientId.trim(), clientSecret: form.clientSecret.trim() },
  };
}

// The section as it would be stored, so the options page compares it with the stored one (`trackEdits`): a valid form
// becomes the form of its configuration, and an invalid one stays as typed, which differs and is refused on save.
export function normalizeWorkerForm(form: WorkerForm): WorkerForm {
  const parsed = parseWorkerForm(form);
  return parsed.ok ? workerForm(parsed.access) : form;
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
