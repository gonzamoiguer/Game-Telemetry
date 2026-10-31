/** Viewer login (shared password + signed cookie), throttling and key checks. */
import { fail, json, isObject, readJson, type Env } from "./http";
import { countRecentFailures, clearFailures, recordFailure } from "./db";

const COOKIE = "s";
const SESSION_DAYS = 30;
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

const encoder = new TextEncoder();

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/**
 * Constant-time string comparison. Both sides are hashed first so the
 * comparison never leaks the length of the secret.
 */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** True when the request carries the correct X-Ingest-Key. */
export async function hasIngestKey(request: Request, env: Env): Promise<boolean> {
  const given = request.headers.get("X-Ingest-Key");
  if (!env.INGEST_KEY || !given) return false;
  return safeEqual(given, env.INGEST_KEY);
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** True when the request carries a valid, unexpired session cookie. */
export async function isLoggedIn(request: Request, env: Env): Promise<boolean> {
  const value = readCookie(request, COOKIE);
  if (!value || !env.SESSION_SECRET) return false;
  const [expiry, signature] = value.split(".");
  const sig = fromHex(signature ?? "");
  if (!/^\d+$/.test(expiry ?? "") || !sig || Number(expiry) < Date.now()) return false;
  // crypto.subtle.verify compares the MAC in constant time.
  const key = await hmacKey(env.SESSION_SECRET, "verify");
  return crypto.subtle.verify("HMAC", key, sig, encoder.encode(expiry));
}

async function sessionCookie(secret: string): Promise<string> {
  const expiry = String(Date.now() + SESSION_DAYS * 86400 * 1000);
  const key = await hmacKey(secret, "sign");
  const mac = toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(expiry)));
  return `${COOKIE}=${expiry}.${mac}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
}

/** POST /api/login { "password": "…" } */
export async function login(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const now = Date.now();
  const failures = await countRecentFailures(env.DB, ip, now - THROTTLE_WINDOW_MS);
  if (failures >= MAX_FAILURES) return fail(429, "too many attempts, try again in 15 minutes");

  const body = await readJson(request);
  const password = isObject(body) && typeof body.password === "string" ? body.password : "";
  const ok =
    !!env.VIEWER_PASSWORD && !!env.SESSION_SECRET && password !== "" && (await safeEqual(password, env.VIEWER_PASSWORD));

  if (!ok) {
    await recordFailure(env.DB, ip, now);
    return fail(401, "wrong password");
  }
  await clearFailures(env.DB, ip);
  return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env.SESSION_SECRET!) });
}

/** POST /api/logout */
export function logout(): Response {
  return json({ ok: true }, 200, {
    "Set-Cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
  });
}
