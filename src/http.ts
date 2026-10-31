/** Small HTTP helpers shared by every route. */

export interface Env {
  DB: D1Database;
  SHOTS: R2Bucket;
  ASSETS: Fetcher;
  INGEST_KEY?: string;
  SESSION_SECRET?: string;
  VIEWER_PASSWORD?: string;
}

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json; charset=utf-8");
  if (!h.has("Cache-Control")) h.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function fail(status: number, error: string): Response {
  return json({ ok: false, error }, status);
}

/** Thrown by validators; the router turns it into a 4xx JSON response. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Reads a request body, giving up as soon as it grows past `max` bytes.
 * Returns null when the body is too large.
 */
export async function readBody(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Parses a small JSON body (viewer API, login). Throws HttpError on bad input. */
export async function readJson(request: Request, max = 16 * 1024): Promise<unknown> {
  const bytes = await readBody(request, max);
  if (!bytes) throw new HttpError(413, "body too large");
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

/** Ids end up in R2 keys and URLs, so keep them to a safe alphabet. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
