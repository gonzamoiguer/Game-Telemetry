// npm run seed [-- <url>] — posts a realistic fake playtest through the real ingest API.
// Without a URL it targets local dev (npm run dev). Ids are deterministic, so running it
// twice stores nothing new (the ingest is idempotent).
import { createHash } from "node:crypto";
import { encodeJpeg } from "./lib/jpeg.mjs";
import { fatal, ingestBatch, putShot, target } from "./lib/common.mjs";

const { url, ingestKey } = target(process.argv[2]);
const NOW = Date.now();
const DAY = 86_400_000;

function guid(label) {
  const hex = createHash("sha256").update(`urbes-seed:${label}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// Deterministic pseudo-random numbers (mulberry32).
let seed = 20261031;
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}
const between = (lo, hi) => lo + rand() * (hi - lo);
const pick = (list) => list[Math.floor(rand() * list.length)];

const DESKTOP = {
  os: "Windows 11 (10.0.26200) 64bit",
  cpu: "AMD Ryzen 7 5800X 8-Core Processor x16",
  gpu: "NVIDIA GeForce RTX 3070 (Direct3D11)",
  ram_mb: 32768,
  resolution: "1920x1080",
  language: "es",
};
const LAPTOP = {
  os: "Windows 10 (10.0.19045) 64bit",
  cpu: "Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz x8",
  gpu: "Intel(R) UHD Graphics 620 (Direct3D11)",
  ram_mb: 8192,
  resolution: "1366x768",
  language: "es",
};
const MAC = {
  os: "Mac OS X 14.6.1",
  cpu: "Apple M2 x8",
  gpu: "Apple M2 (Metal)",
  ram_mb: 16384,
  resolution: "2560x1600",
  language: "en",
};

const CARDS = [
  ["Casa Chorizo", "building", { Dinero: -6, Materiales: -3, Vecinos: 2 }],
  ["Kiosco", "building", { Dinero: -4, Materiales: -2 }],
  ["Plaza", "building", { Materiales: -4, Ánimo: 3 }],
  ["Banco de plaza", "furniture", { Materiales: -1, Ánimo: 1 }],
  ["Farol", "furniture", { Dinero: -2, Ánimo: 1 }],
  ["Asamblea barrial", "action", { Ánimo: 2 }],
  ["Colecta", "action", { Dinero: 5, Ánimo: -1 }],
  ["Nely", "character", {}],
  ["Volquete", "other", { Materiales: 4 }],
];

const shots = []; // { session, seq, label }

class Session {
  constructor(game, { label, startedAt, env = "release", machine, build, resumed, gapS = null, loadedT = null }) {
    this.game = game;
    this.id = guid(label);
    this.meta = { id: this.id, started_at: Math.round(startedAt), build, env, ...machine };
    this.events = [];
    this.seq = 0;
    this.ts = startedAt + 1500;
    if (loadedT !== null) game.t = loadedT;
    this.nextCheckpoint = Math.floor(game.t / 300 + 1) * 300;
    this.emit("session_start", { resumed, gap_s: gapS, loaded_t: loadedT });
  }

  /** Emits an event after `dt` seconds of active play. */
  emit(type, data, dt = 0) {
    this.game.t += dt;
    this.ts += dt * 1000;
    this.events.push({ seq: ++this.seq, t: Math.round(this.game.t * 100) / 100, ts: Math.round(this.ts), type, data });
    return this.seq;
  }

  checkpoint() {
    const seq = this.emit("checkpoint", { fps_avg: Math.round(between(120, 150) * 10) / 10, fps_min: Math.round(between(48, 70)), shot: true });
    shots.push({ session: this.id, seq, label: shots.length + 1 });
  }

  idle(seconds) {
    this.ts += seconds * 1000; // idle time is real time, not play time
    this.emit("idle", { seconds });
  }

  /** Plays `count` turns; `extras[turn]` adds scripted events during that turn. */
  play(count, extras = {}) {
    const g = this.game;
    for (let i = 0; i < count; i++) {
      g.turn += 1;
      for (const k of Object.keys(g.res)) g.res[k] += k === "Dinero" ? 4 : k === "Materiales" ? 2 : 0;
      this.emit("turn", { turn: g.turn, hand: Math.max(1, Math.round(between(2, 6))), res: { ...g.res } }, between(4, 8));
      const plays = rand() < 0.5 ? 1 : 2;
      for (let p = 0; p < plays; p++) {
        const [card, kind, cost] = pick(CARDS);
        for (const [k, v] of Object.entries(cost)) g.res[k] = Math.max(0, g.res[k] + v);
        this.emit("card_played", { card, kind, turn: g.turn, res: { ...g.res } }, between(20, 38));
      }
      extras[g.turn]?.(this);
      if (g.t >= this.nextCheckpoint) {
        this.checkpoint();
        this.nextCheckpoint += 300;
      }
    }
  }

  end(reason) {
    this.emit("session_end", { reason }, 2);
  }
}

function newGame(label, player, startedAt) {
  return {
    player: guid(player),
    run: { id: guid(label), started_at: startedAt },
    t: 0,
    turn: 0,
    res: { Dinero: 30, Materiales: 10, Vecinos: 4, Ánimo: 5 },
    sessions: [],
  };
}

function snapshot(game) {
  return { t: game.t, turn: game.turn, res: { ...game.res } };
}

const BUILD_OLD = "2026-10-24 18:40 (a41f0c2)";
const BUILD = "2026-10-31 14:05 (dd1c269)";
const NULL_REF = {
  message: "NullReferenceException: Object reference not set to an instance of an object",
  stack: "CardView.OnPointerEnter (UnityEngine.EventSystems.PointerEventData eventData) (at Assets/Scripts/UI/CardView.cs:88)\nUnityEngine.EventSystems.ExecuteEvents.Execute (IPointerEnterHandler handler, BaseEventData eventData)",
};
const INDEX = {
  message: "IndexOutOfRangeException: Index was outside the bounds of the array.",
  stack: "ProtestController.PickSlogan () (at Assets/Scripts/Events/ProtestController.cs:41)\nProtestController.Update () (at Assets/Scripts/Events/ProtestController.cs:23)",
};

// ---------------------------------------------------------------- player 1, run 1 (the long one)
const run1Start = NOW - 5 * DAY;
const g1 = newGame("run-1", "player-1", run1Start);
let s = new Session(g1, { label: "run-1/s1", startedAt: run1Start, machine: DESKTOP, build: BUILD_OLD, resumed: false });
g1.sessions.push(s);
s.emit("run_start", { scenario: "Tutorial", legacy: false }, 1);
s.play(10, {
  2: (x) => {
    x.emit("character_appeared", { character: "Nely" }, 5);
    x.emit("error", { ...NULL_REF, count: 1 }, 1);
  },
  4: (x) => x.emit("removed", { what: "Kiosco", res: { ...g1.res } }, 8),
  5: (x) => x.emit("influence_level_up", { character: "Nely", level: 1 }, 3),
  6: (x) => {
    const seq = x.emit("feedback", { text: "no entiendo qué hace este botón, el de la casita con la flecha", shot: true }, 14);
    shots.push({ session: x.id, seq, label: shots.length + 1 });
  },
  7: (x) => x.emit("error_repeat", { message: NULL_REF.message, count: 12 }, 1),
});
s.emit("error_repeat", { message: NULL_REF.message, count: 37 }, 1);
s.end("quit");
const s1End = s.ts;

// Session 2: resumed two days later.
const s2Start = s1End + 2 * DAY + 3 * 3600_000;
s = new Session(g1, { label: "run-1/s2", startedAt: s2Start, machine: DESKTOP, build: BUILD, resumed: true, gapS: Math.round((s2Start - s1End) / 1000), loadedT: g1.t });
g1.sessions.push(s);
let save = null;
s.play(7, {
  11: (x) => {
    x.emit("character_appeared", { character: "Tito" }, 4);
    save = snapshot(g1); // the player saves here and will come back to it
  },
  12: (x) => {
    x.emit("situation", { situation: "EmptyHand_Nely", character: "Nely", phase: "offered" }, 3);
    x.emit("situation", { situation: "EmptyHand_Nely", character: "Nely", phase: "chosen", offer: 1 }, 9);
    x.emit("character_gave", { character: "Nely", cards: ["Kiosco", "Plaza"] }, 1);
  },
  13: (x) => x.idle(412),
  14: (x) => {
    x.emit("protest", { active: true }, 6);
    x.emit("influence_level_up", { character: "Tito", level: 1 }, 5);
  },
  15: (x) => {
    x.emit("protest", { active: false }, 10);
    x.emit("character_left", { character: "Tito" }, 3);
  },
  16: (x) => x.emit("influence_level_up", { character: "Nely", level: 2 }, 4),
});
s.end("load");
const s2End = s.ts;

// Session 3: reloads the save from turn 11 (t rewinds), then crashes.
g1.turn = save.turn;
g1.res = save.res;
s = new Session(g1, { label: "run-1/s3", startedAt: s2End + 4000, machine: DESKTOP, build: BUILD, resumed: true, gapS: Math.round((s2End - s2Start) / 1000), loadedT: save.t });
g1.sessions.push(s);
s.play(5, {
  12: (x) => x.emit("situation", { situation: "EmptyHand_Nely", character: "Nely", phase: "chosen", offer: 2 }, 6),
  13: (x) => x.emit("influence_level_up", { character: "Nely", level: 2 }, 3),
  14: (x) => {
    x.emit("protest", { active: true }, 4);
    x.emit("error", { ...INDEX, count: 1 }, 2);
  },
  15: (x) => x.emit("error_repeat", { message: INDEX.message, count: 5 }, 1),
});
s.checkpoint();
// …no session_end: the game crashed.

// ---------------------------------------------------------------- player 1, run 2 (legacy save, laptop)
const run2Start = NOW - DAY - 5 * 3600_000;
const g2 = newGame("run-2", "player-1", run2Start);
s = new Session(g2, { label: "run-2/s1", startedAt: run2Start, machine: LAPTOP, build: BUILD, resumed: false });
g2.sessions.push(s);
s.emit("run_start", { scenario: "Barrio Sur", legacy: true }, 1);
s.play(5, { 3: (x) => x.emit("character_appeared", { character: "Doña Rosa" }, 6) });
s.end("title");

// ---------------------------------------------------------------- player 2, run 3 (dev build, one session)
const run3Start = NOW - 3 * 3600_000;
const g3 = newGame("run-3", "player-2", run3Start);
s = new Session(g3, { label: "run-3/s1", startedAt: run3Start, env: "dev", machine: MAC, build: BUILD, resumed: false });
g3.sessions.push(s);
s.emit("run_start", { scenario: "Tutorial", legacy: false }, 1);
s.play(12, {
  2: (x) => x.emit("character_appeared", { character: "Nely" }, 4),
  4: (x) => x.emit("influence_level_up", { character: "Nely", level: 1 }, 2),
  6: (x) => x.emit("debug_marker", { note: "tester pressed F9", scene: "Main" }, 1),
  8: (x) => x.emit("character_gave", { character: "Nely", cards: ["Farol"] }, 2),
});
s.checkpoint();
s.end("quit");

// ---------------------------------------------------------------- send
const games = [g1, g2, g3];
let total = 0;
let stored = 0;
console.log(`Seeding ${url} …`);
for (const game of games) {
  for (const session of game.sessions) {
    for (let i = 0; i < session.events.length; i += 40) {
      const body = { v: 1, player: game.player, run: game.run, session: session.meta, events: session.events.slice(i, i + 40) };
      const res = await ingestBatch(url, ingestKey, body);
      if (!res.ok) fatal(`ingest failed: HTTP ${res.status} ${await res.text()}`);
      stored += (await res.json()).stored;
    }
    total += session.events.length;
  }
}

function placeholder(label) {
  // 640×360 "city" made of 8×8 blocks, with the screenshot number drawn in big blocks.
  const DIGITS = ["111101101101111", "010110010010111", "111001111100111", "111001111001111", "101101111001001", "111100111001111", "111100111101111", "111001001001001", "111101111101111", "111101111001111"];
  const text = String(label);
  const hue = (label * 47) % 360;
  return encodeJpeg(640, 360, (bx, by) => {
    const cell = (bx * 7 + by * 13 + ((bx >> 2) ^ (by >> 2)) * 5) % 11;
    let rgb = (bx % 6 === 0 || by % 6 === 0)
      ? [70, 70, 76]
      : cell < 3 ? hsl(hue, 45, 42) : cell < 5 ? [64, 120, 72] : [32, 34, 40];
    const gx = bx - 4;
    const gy = by - 4;
    const charIndex = Math.floor(gx / 16);
    const px = Math.floor((gx % 16) / 4);
    const py = Math.floor(gy / 4);
    if (gx >= 0 && gy >= 0 && py < 5 && px < 3 && charIndex < text.length && DIGITS[Number(text[charIndex])][py * 3 + px] === "1") {
      rgb = [245, 240, 225];
    }
    return rgb;
  });
}

function hsl(h, sat, light) {
  const s1 = sat / 100;
  const l = light / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s1 * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

for (const shot of shots) {
  const res = await putShot(url, ingestKey, shot.session, shot.seq, placeholder(shot.label));
  if (!res.ok) fatal(`screenshot upload failed: HTTP ${res.status} ${await res.text()}`);
}

const types = new Set(games.flatMap((g) => g.sessions.flatMap((x) => x.events.map((e) => e.type))));
console.log(`✓ ${games.length} runs, ${games.reduce((n, g) => n + g.sessions.length, 0)} sessions, ${total} events (${stored} new), ${shots.length} screenshots.`);
console.log(`  event types: ${[...types].sort().join(", ")}`);
console.log(`  open ${url}/ and log in to look at it.`);
