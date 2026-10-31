/** Ingest API used by the Unity client: event batches and screenshots. */
import { hasIngestKey } from "./auth";
import { countSessionEvents, MAX_EVENTS_PER_SESSION, runIdForSession, writeBatch, type IngestEvent, type SessionMeta } from "./db";
import { fail, HttpError, isId, isObject, json, readBody, type Env } from "./http";

const MAX_BODY = 1024 * 1024;
const MAX_EVENTS = 500;
const MAX_DATA = 8 * 1024;
const MAX_SHOT = 600 * 1024;
const ENVS = new Set(["release", "dev", "editor"]);
const TYPE_RE = /^[a-z_]{1,32}$/;

function bad(reason: string): never {
  throw new HttpError(400, reason);
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}

function id(v: unknown, field: string): string {
  if (!isId(v)) bad(`${field} must be an id (1-64 chars of A-Z a-z 0-9 _ -)`);
  return v;
}

function timestamp(v: unknown, field: string): number {
  if (!isInt(v) || v < 0) bad(`${field} must be a Unix time in milliseconds`);
  return v;
}

function text(v: unknown, field: string, required: boolean): string | null {
  if (v === undefined || v === null) {
    if (required) bad(`${field} is required`);
    return null;
  }
  if (typeof v !== "string" || v.length > 200 || (required && v === "")) bad(`${field} must be a string of up to 200 chars`);
  return v;
}

function session(v: unknown): SessionMeta {
  if (!isObject(v)) bad("session must be an object");
  if (typeof v.env !== "string" || !ENVS.has(v.env)) bad("session.env must be release, dev or editor");
  if (v.ram_mb !== undefined && v.ram_mb !== null && (!isInt(v.ram_mb) || v.ram_mb < 0)) bad("session.ram_mb must be an integer");
  return {
    id: id(v.id, "session.id"),
    started_at: timestamp(v.started_at, "session.started_at"),
    build: text(v.build, "session.build", true)!,
    env: v.env,
    os: text(v.os, "session.os", false),
    cpu: text(v.cpu, "session.cpu", false),
    gpu: text(v.gpu, "session.gpu", false),
    ram_mb: (v.ram_mb as number | undefined) ?? null,
    resolution: text(v.resolution, "session.resolution", false),
    language: text(v.language, "session.language", false),
  };
}

function event(v: unknown, i: number): IngestEvent {
  const at = `events[${i}]`;
  if (!isObject(v)) bad(`${at} must be an object`);
  if (!isInt(v.seq) || v.seq < 1) bad(`${at}.seq must be a positive integer`);
  if (typeof v.t !== "number" || !Number.isFinite(v.t) || v.t < 0) bad(`${at}.t must be a non-negative number`);
  if (typeof v.type !== "string" || !TYPE_RE.test(v.type)) bad(`${at}.type must match [a-z_]{1,32}`);
  let data: string | null = null;
  if (v.data !== undefined && v.data !== null) {
    if (!isObject(v.data)) bad(`${at}.data must be an object`);
    data = JSON.stringify(v.data);
    if (new TextEncoder().encode(data).byteLength > MAX_DATA) bad(`${at}.data is larger than 8 KB`);
  }
  return { seq: v.seq, t: v.t, ts: timestamp(v.ts, `${at}.ts`), type: v.type, data };
}

/** POST /api/ingest */
export async function ingest(request: Request, env: Env): Promise<Response> {
  if (!(await hasIngestKey(request, env))) return fail(401, "missing or wrong X-Ingest-Key");

  const bytes = await readBody(request, MAX_BODY);
  if (!bytes) return fail(413, "body larger than 1 MB");
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    bad("body is not valid JSON");
  }

  if (!isObject(body)) bad("body must be an object");
  if (body.v !== 1) bad("v must be 1");
  if (!isObject(body.run)) bad("run must be an object");
  if (!Array.isArray(body.events)) bad("events must be an array");
  if (body.events.length > MAX_EVENTS) bad(`at most ${MAX_EVENTS} events per request`);

  const batch = {
    player: id(body.player, "player"),
    run: { id: id(body.run.id, "run.id"), started_at: timestamp(body.run.started_at, "run.started_at") },
    session: session(body.session),
    events: body.events.map(event),
  };

  // Cap per session so a runaway client cannot fill the database.
  const room = MAX_EVENTS_PER_SESSION - (await countSessionEvents(env.DB, batch.session.id));
  batch.events = batch.events.slice(0, Math.max(0, room));

  const { stored, maxSeq } = await writeBatch(env.DB, batch);
  return json({ ok: true, stored, max_seq: maxSeq });
}

export function shotKey(runId: string, sessionId: string, seq: number): string {
  return `runs/${runId}/${sessionId}/${seq}.jpg`;
}

/** Parses the ":session_id/:seq" part of a screenshot URL. */
export function shotParams(sessionId: string, seq: string): { sessionId: string; seq: number } | null {
  if (!isId(sessionId) || !/^[1-9]\d{0,15}$/.test(seq)) return null;
  return { sessionId, seq: Number(seq) };
}

/** PUT /api/shot/:session_id/:seq */
export async function putShot(request: Request, env: Env, sessionId: string, seqText: string): Promise<Response> {
  if (!(await hasIngestKey(request, env))) return fail(401, "missing or wrong X-Ingest-Key");
  const params = shotParams(sessionId, seqText);
  if (!params) return fail(400, "bad session id or seq");

  const bytes = await readBody(request, MAX_SHOT);
  if (!bytes) return fail(413, "screenshot larger than 600 KB");
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return fail(400, "body is not a JPEG");

  const runId = await runIdForSession(env.DB, params.sessionId);
  if (!runId) return fail(404, "unknown session (send its events first)");

  await env.SHOTS.put(shotKey(runId, params.sessionId, params.seq), bytes, {
    httpMetadata: { contentType: "image/jpeg" },
  });
  return json({ ok: true });
}
