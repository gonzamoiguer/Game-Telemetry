// npm run smoke -- <url> — end-to-end check of a deployed Worker.
// Posts one tiny batch twice (must be idempotent), uploads one screenshot,
// reads both back through the viewer API, then deletes the test player.
import { randomUUID } from "node:crypto";
import { encodeJpeg } from "./lib/jpeg.mjs";
import { fatal, ingestBatch, putShot, target, viewerClient } from "./lib/common.mjs";

if (!process.argv[2]) fatal("Usage: npm run smoke -- https://urbes-telemetry.<you>.workers.dev");
const { url, ingestKey, password } = target(process.argv[2]);

function check(condition, message) {
  if (!condition) fatal(`smoke failed: ${message}`);
  console.log(`  ✓ ${message}`);
}

const now = Date.now();
const ids = { player: `smoke-${randomUUID()}`, run: randomUUID(), session: randomUUID() };
const batch = {
  v: 1,
  player: ids.player,
  run: { id: ids.run, started_at: now },
  session: { id: ids.session, started_at: now, build: "smoke", env: "dev", os: "smoke test", resolution: "640x360" },
  events: [
    { seq: 1, t: 0, ts: now, type: "session_start", data: { resumed: false, gap_s: null, loaded_t: null } },
    { seq: 2, t: 1.5, ts: now + 1500, type: "checkpoint", data: { fps_avg: 60, fps_min: 58, shot: true } },
    { seq: 3, t: 2, ts: now + 2000, type: "session_end", data: { reason: "quit" } },
  ],
};

console.log(`Smoke test against ${url}`);
const first = await ingestBatch(url, ingestKey, batch);
const firstBody = await first.json().catch(() => ({}));
check(first.ok && firstBody.stored === 3 && firstBody.max_seq === 3, `ingest accepted the batch (HTTP ${first.status}, stored ${firstBody.stored})`);

const again = await ingestBatch(url, ingestKey, batch);
const againBody = await again.json().catch(() => ({}));
check(again.ok && againBody.stored === 0, `resending the same batch stores nothing (stored ${againBody.stored})`);

const wrongKey = await ingestBatch(url, "wrong-key", batch);
check(wrongKey.status === 401, "a wrong ingest key is rejected with 401");

const jpeg = encodeJpeg(64, 40, (x, y) => [40 + x * 20, 80, 120 + y * 20]);
const shot = await putShot(url, ingestKey, ids.session, 2, jpeg);
check(shot.ok, `screenshot upload accepted (HTTP ${shot.status})`);

const viewer = await viewerClient(url, password);
const run = await (await viewer(`runs/${ids.run}`)).json();
check(run.events?.length === 3, `the run has exactly 3 events after two posts (got ${run.events?.length})`);
const image = await viewer(`shot/${ids.session}/2`);
const bytes = new Uint8Array(await image.arrayBuffer());
check(image.ok && bytes.length === jpeg.length, "the screenshot reads back through the viewer API");

const unauthenticated = await fetch(`${url}/api/v/players`);
check(unauthenticated.status === 401, "the viewer API refuses requests without login");

const removed = await viewer(`players/${ids.player}`, { method: "DELETE" });
check(removed.ok, "the test player was deleted");
const gone = await viewer(`shot/${ids.session}/2`);
check(gone.status === 404, "its screenshot is gone too");

console.log("\n✓ Smoke test passed.");
