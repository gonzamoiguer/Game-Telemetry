import { SELF } from "cloudflare:test";

export const BASE = "https://telemetry.test";
export const KEY = "test-ingest-key";
export const PASSWORD = "correct horse";

let counter = 0;
/** A unique id per call so tests never share rows. */
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export interface TestEvent {
  seq: number;
  t: number;
  ts?: number;
  type: string;
  data?: Record<string, unknown>;
}

export function batch(ids: { player: string; run: string; session: string; startedAt?: number }, events: TestEvent[]) {
  const startedAt = ids.startedAt ?? 1_761_900_000_000;
  return {
    v: 1,
    player: ids.player,
    run: { id: ids.run, started_at: 1_761_900_000_000 },
    session: {
      id: ids.session,
      started_at: startedAt,
      build: "2026-10-31 14:05 (dd1c269)",
      env: "release",
      os: "Windows 11 (10.0.26200) 64bit",
      cpu: "AMD Ryzen 7 5800X 8-Core Processor x16",
      gpu: "NVIDIA GeForce RTX 3070 (Direct3D11)",
      ram_mb: 32768,
      resolution: "1920x1080",
      language: "es",
    },
    events: events.map((e) => ({ ts: startedAt + e.seq * 1000, data: {}, ...e })),
  };
}

export function ingest(body: unknown, key = KEY): Promise<Response> {
  return SELF.fetch(`${BASE}/api/ingest`, {
    method: "POST",
    headers: { "X-Ingest-Key": key, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function login(password: string, ip: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ password }),
  });
}

/** Logs in and returns the cookie pair to send back ("s=…"). */
export async function loginCookie(): Promise<string> {
  const res = await login(PASSWORD, uid("ip"));
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  return setCookie.split(";")[0];
}
