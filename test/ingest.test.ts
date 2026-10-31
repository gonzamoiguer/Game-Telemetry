import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE, batch, ingest, KEY, uid } from "./helpers";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

async function countEvents(sessionId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ?").bind(sessionId).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("POST /api/ingest", () => {
  it("is idempotent: the same batch twice stores the same rows", async () => {
    const ids = { player: uid("p"), run: uid("r"), session: uid("s") };
    const body = batch(ids, [
      { seq: 1, t: 0, type: "session_start", data: { resumed: false } },
      { seq: 2, t: 4.5, type: "turn", data: { turn: 1, hand: 5, res: { Dinero: 30 } } },
      { seq: 3, t: 9, type: "card_played", data: { card: "Kiosco", kind: "building", turn: 1 } },
    ]);

    const first = await ingest(body);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, stored: 3, max_seq: 3 });

    const second = await ingest(body);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, stored: 0, max_seq: 3 });
    expect(await countEvents(ids.session)).toBe(3);
  });

  it("never overwrites good data with worse data", async () => {
    const ids = { player: uid("p"), run: uid("r"), session: uid("s") };
    await ingest(batch(ids, [{ seq: 1, t: 100, ts: 5_000, type: "turn", data: { turn: 3 } }]));
    await ingest(batch(ids, [{ seq: 2, t: 20, ts: 4_000, type: "turn", data: { turn: 2 } }]));

    const run = await env.DB.prepare("SELECT play_time, last_seen_at FROM runs WHERE id = ?").bind(ids.run).first();
    expect(run).toEqual({ play_time: 100, last_seen_at: 1_761_900_000_000 });
  });

  it("marks a session as cleanly ended on session_end", async () => {
    const ids = { player: uid("p"), run: uid("r"), session: uid("s") };
    await ingest(batch(ids, [{ seq: 1, t: 0, ts: 1_761_900_009_000, type: "session_end", data: { reason: "quit" } }]));
    const row = await env.DB.prepare("SELECT ended_at, clean_exit FROM sessions WHERE id = ?").bind(ids.session).first();
    expect(row).toEqual({ ended_at: 1_761_900_009_000, clean_exit: 1 });
  });

  it("rejects a wrong or missing key with 401", async () => {
    const body = batch({ player: uid("p"), run: uid("r"), session: uid("s") }, []);
    expect((await ingest(body, "wrong")).status).toBe(401);
    const noKey = await SELF.fetch(`${BASE}/api/ingest`, { method: "POST", body: JSON.stringify(body) });
    expect(noKey.status).toBe(401);
  });

  it("rejects a body over 1 MB with 413", async () => {
    const res = await ingest("x".repeat(1024 * 1024 + 1));
    expect(res.status).toBe(413);
  });

  it("rejects bad input with 400 and a reason", async () => {
    const ids = { player: uid("p"), run: uid("r"), session: uid("s") };
    const cases: unknown[] = [
      "{not json",
      { ...batch(ids, []), v: 2 },
      batch(ids, [{ seq: 0, t: 0, type: "turn" }]),
      batch(ids, [{ seq: 1, t: 0, type: "Bad-Type" }]),
      batch(ids, [{ seq: 1, t: 0, type: "turn", data: { blob: "x".repeat(9000) } }]),
      { ...batch(ids, []), session: { ...batch(ids, []).session, env: "staging" } },
    ];
    for (const body of cases) {
      const res = await ingest(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBeTruthy();
    }
  });
});

describe("PUT /api/shot", () => {
  function put(sessionId: string, seq: number, body: Uint8Array, key = KEY): Promise<Response> {
    return SELF.fetch(`${BASE}/api/shot/${sessionId}/${seq}`, {
      method: "PUT",
      headers: { "X-Ingest-Key": key, "Content-Type": "image/jpeg" },
      body,
    });
  }

  it("returns 404 for an unknown session", async () => {
    expect((await put(uid("s"), 1, JPEG)).status).toBe(404);
  });

  it("stores the JPEG under runs/<run>/<session>/<seq>.jpg", async () => {
    const ids = { player: uid("p"), run: uid("r"), session: uid("s") };
    await ingest(batch(ids, [{ seq: 7, t: 300, type: "checkpoint", data: { fps_avg: 60, fps_min: 50, shot: true } }]));
    expect((await put(ids.session, 7, JPEG)).status).toBe(200);
    expect(await env.SHOTS.head(`runs/${ids.run}/${ids.session}/7.jpg`)).not.toBeNull();
  });

  it("rejects non-JPEG bodies, oversized bodies and wrong keys", async () => {
    const ids = { player: uid("p"), run: uid("r"), session: uid("s") };
    await ingest(batch(ids, []));
    expect((await put(ids.session, 1, new Uint8Array([1, 2, 3]))).status).toBe(400);
    expect((await put(ids.session, 1, new Uint8Array(600 * 1024 + 1).fill(0xff))).status).toBe(413);
    expect((await put(ids.session, 1, JPEG, "wrong")).status).toBe(401);
  });
});
