/**
 * Reads a request's JSON body within a byte limit (RES-1). A declared length over the limit is refused before reading,
 * and the stream is read only up to the limit, so a body without a length, or with a false one, is cut off too.
 */

export type BodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: "too-large" | "bad-request" };

export async function readJsonBody(request: Request, maxBytes: number): Promise<BodyResult> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) return { ok: false, code: "bad-request" };
    if (Number(declared) > maxBytes) return { ok: false, code: "too-large" };
  }
  if (request.body === null) return { ok: false, code: "bad-request" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      return { ok: false, code: "too-large" };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) };
  } catch {
    return { ok: false, code: "bad-request" };
  }
}
