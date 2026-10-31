import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE, batch, ingest, login, loginCookie, PASSWORD, uid } from "./helpers";

describe("login", () => {
  it("sets a signed, HttpOnly cookie on success", async () => {
    const res = await login(PASSWORD, uid("ip"));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toMatch(/^s=\d+\.[0-9a-f]{64};/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
  });

  it("rejects a wrong password with 401", async () => {
    const res = await login("nope", uid("ip"));
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("throttles the 6th failed attempt from one IP with 429", async () => {
    const ip = uid("ip");
    for (let i = 0; i < 5; i++) expect((await login("nope", ip)).status).toBe(401);
    expect((await login(PASSWORD, ip)).status).toBe(429);
    // Other IPs are unaffected.
    expect((await login(PASSWORD, uid("ip"))).status).toBe(200);
  });
});

describe("viewer API", () => {
  it("returns 401 without a cookie", async () => {
    expect((await SELF.fetch(`${BASE}/api/v/players`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/v/players`, { headers: { Cookie: "s=99999999999999.abcd" } })).status).toBe(401);
  });

  it("orders run events by session start then seq, even when t rewinds", async () => {
    const player = uid("p");
    const run = uid("r");
    const first = uid("s");
    const second = uid("s");
    // Session 2 reloads an older save, so its t values are lower than session 1's.
    // It is sent first to make sure insertion order does not matter.
    await ingest(
      batch({ player, run, session: second, startedAt: 1_761_900_600_000 }, [
        { seq: 1, t: 50, type: "session_start", data: { resumed: true, gap_s: 10, loaded_t: 50 } },
        { seq: 2, t: 60, type: "turn", data: { turn: 3 } },
      ]),
    );
    await ingest(
      batch({ player, run, session: first, startedAt: 1_761_900_000_000 }, [
        { seq: 1, t: 0, type: "session_start", data: { resumed: false } },
        { seq: 2, t: 120, type: "turn", data: { turn: 5 } },
        { seq: 3, t: 130, type: "session_end", data: { reason: "load" } },
      ]),
    );

    const cookie = await loginCookie();
    const res = await SELF.fetch(`${BASE}/api/v/runs/${run}`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: { id: string }[]; events: { s: string; seq: number; t: number }[] };
    expect(body.sessions.map((s) => s.id)).toEqual([first, second]);
    expect(body.events.map((e) => [e.s, e.seq, e.t])).toEqual([
      [first, 1, 0],
      [first, 2, 120],
      [first, 3, 130],
      [second, 1, 50],
      [second, 2, 60],
    ]);
  });

  it("lists, annotates and deletes a player", async () => {
    const ids = { player: uid("p"), run: uid("r"), session: uid("s") };
    await ingest(batch(ids, [{ seq: 1, t: 1, type: "feedback", data: { text: "hola", shot: false } }]));
    const cookie = await loginCookie();
    const headers = { Cookie: cookie, "Content-Type": "application/json" };

    const list = (await (await SELF.fetch(`${BASE}/api/v/players`, { headers })).json()) as { players: { id: string; has_feedback: boolean; crashes: number }[] };
    const row = list.players.find((p) => p.id === ids.player);
    expect(row).toMatchObject({ has_feedback: true, crashes: 1 });

    const patch = await SELF.fetch(`${BASE}/api/v/players/${ids.player}`, { method: "PATCH", headers, body: JSON.stringify({ note: "primo" }) });
    expect(patch.status).toBe(200);

    const del = await SELF.fetch(`${BASE}/api/v/players/${ids.player}`, { method: "DELETE", headers });
    expect(del.status).toBe(200);
    expect((await SELF.fetch(`${BASE}/api/v/players/${ids.player}`, { headers })).status).toBe(404);
  });
});
