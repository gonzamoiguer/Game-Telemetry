/** All SQL lives here. */

export const MAX_EVENTS_PER_SESSION = 20_000;

export interface SessionMeta {
  id: string;
  started_at: number;
  build: string;
  env: string;
  os: string | null;
  cpu: string | null;
  gpu: string | null;
  ram_mb: number | null;
  resolution: string | null;
  language: string | null;
}

export interface IngestEvent {
  seq: number;
  t: number;
  ts: number;
  type: string;
  data: string | null;
}

export interface IngestBatch {
  player: string;
  run: { id: string; started_at: number };
  session: SessionMeta;
  events: IngestEvent[];
}

// ---------------------------------------------------------------- ingest

export async function countSessionEvents(db: D1Database, sessionId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ?").bind(sessionId).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Writes one ingest batch atomically. Parents are upserted first (D1 enforces
 * foreign keys), then events are inserted idempotently.
 * Returns the number of new event rows and the highest seq stored for the session.
 */
export async function writeBatch(db: D1Database, b: IngestBatch): Promise<{ stored: number; maxSeq: number }> {
  const s = b.session;
  const lastSeen = Math.max(s.started_at, ...b.events.map((e) => e.ts));
  const playTime = Math.max(0, ...b.events.map((e) => e.t));

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO players (id, created_at, last_seen_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET
           created_at = MIN(players.created_at, excluded.created_at),
           last_seen_at = MAX(players.last_seen_at, excluded.last_seen_at)`,
      )
      .bind(b.player, Math.min(b.run.started_at, s.started_at), lastSeen),
    db
      .prepare(
        `INSERT INTO runs (id, player_id, started_at, last_seen_at, play_time) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
           last_seen_at = MAX(runs.last_seen_at, excluded.last_seen_at),
           play_time = MAX(runs.play_time, excluded.play_time)`,
      )
      .bind(b.run.id, b.player, b.run.started_at, lastSeen, playTime),
    db
      .prepare(
        `INSERT INTO sessions (id, run_id, started_at, build, env, os, cpu, gpu, ram_mb, resolution, language)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(s.id, b.run.id, s.started_at, s.build, s.env, s.os, s.cpu, s.gpu, s.ram_mb, s.resolution, s.language),
  ];

  // The run id comes from the session row, so a session always keeps the run
  // it was first registered with.
  const insertEvent = db.prepare(
    `INSERT INTO events (run_id, session_id, seq, t, ts, type, data)
     SELECT run_id, id, ?2, ?3, ?4, ?5, ?6 FROM sessions WHERE id = ?1
     ON CONFLICT(session_id, seq) DO NOTHING`,
  );
  for (const e of b.events) statements.push(insertEvent.bind(s.id, e.seq, e.t, e.ts, e.type, e.data));

  const ends = b.events.filter((e) => e.type === "session_end");
  if (ends.length > 0) {
    const endedAt = Math.max(...ends.map((e) => e.ts));
    statements.push(
      db
        .prepare("UPDATE sessions SET ended_at = MAX(COALESCE(ended_at, 0), ?2), clean_exit = 1 WHERE id = ?1")
        .bind(s.id, endedAt),
    );
  }
  statements.push(db.prepare("SELECT MAX(seq) AS max_seq FROM events WHERE session_id = ?").bind(s.id));

  const results = await db.batch(statements);
  let stored = 0;
  for (let i = 3; i < 3 + b.events.length; i++) stored += results[i].meta.changes ?? 0;
  const last = results[results.length - 1].results[0] as { max_seq: number | null } | undefined;
  return { stored, maxSeq: last?.max_seq ?? 0 };
}

export async function runIdForSession(db: D1Database, sessionId: string): Promise<string | null> {
  const row = await db.prepare("SELECT run_id FROM sessions WHERE id = ?").bind(sessionId).first<{ run_id: string }>();
  return row?.run_id ?? null;
}

// ---------------------------------------------------------------- login throttle

/** Prunes expired attempts, then counts recent failures for this IP. */
export async function countRecentFailures(db: D1Database, ip: string, since: number): Promise<number> {
  const [, count] = await db.batch([
    db.prepare("DELETE FROM login_attempts WHERE at < ?").bind(since),
    db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ?").bind(ip),
  ]);
  return (count.results[0] as { n: number }).n;
}

export async function recordFailure(db: D1Database, ip: string, at: number): Promise<void> {
  await db.prepare("INSERT INTO login_attempts (ip, at) VALUES (?, ?)").bind(ip, at).run();
}

export async function clearFailures(db: D1Database, ip: string): Promise<void> {
  await db.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run();
}

// ---------------------------------------------------------------- viewer

export async function listPlayers(db: D1Database, envs: string[]) {
  const marks = envs.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT p.id, p.note, p.created_at, p.last_seen_at,
         (SELECT COUNT(*) FROM runs r WHERE r.player_id = p.id) AS runs,
         (SELECT COALESCE(SUM(r.play_time), 0) FROM runs r WHERE r.player_id = p.id) AS play_time,
         (SELECT s.build FROM sessions s JOIN runs r ON r.id = s.run_id
            WHERE r.player_id = p.id ORDER BY s.started_at DESC LIMIT 1) AS last_build,
         EXISTS (SELECT 1 FROM events e WHERE e.type = 'feedback'
            AND e.run_id IN (SELECT id FROM runs WHERE player_id = p.id)) AS has_feedback,
         (SELECT COUNT(*) FROM sessions s JOIN runs r ON r.id = s.run_id
            WHERE r.player_id = p.id AND s.clean_exit = 0) AS crashes
       FROM players p
       WHERE EXISTS (SELECT 1 FROM sessions s JOIN runs r ON r.id = s.run_id
                     WHERE r.player_id = p.id AND s.env IN (${marks}))
       ORDER BY p.last_seen_at DESC`,
    )
    .bind(...envs)
    .all();
  return results.map((row) => ({ ...row, has_feedback: row.has_feedback === 1 }));
}

export async function getPlayer(db: D1Database, id: string) {
  const player = await db.prepare("SELECT id, note, created_at, last_seen_at FROM players WHERE id = ?").bind(id).first();
  if (!player) return null;
  const [runs, sessions] = await db.batch([
    db
      .prepare(
        `SELECT r.id, r.started_at, r.last_seen_at, r.play_time,
           (SELECT MAX(json_extract(e.data, '$.turn')) FROM events e WHERE e.type = 'turn' AND e.run_id = r.id) AS last_turn,
           (SELECT COUNT(*) FROM sessions s WHERE s.run_id = r.id) AS sessions,
           (SELECT COUNT(*) FROM sessions s WHERE s.run_id = r.id AND s.clean_exit = 0) AS crashes,
           (SELECT COUNT(*) FROM events e WHERE e.type = 'feedback' AND e.run_id = r.id) AS feedback
         FROM runs r WHERE r.player_id = ? ORDER BY r.started_at DESC`,
      )
      .bind(id),
    db
      .prepare(
        `SELECT s.id, s.run_id, s.started_at, s.ended_at, s.clean_exit, s.build, s.env,
           s.os, s.cpu, s.gpu, s.ram_mb, s.resolution, s.language
         FROM sessions s JOIN runs r ON r.id = s.run_id
         WHERE r.player_id = ? ORDER BY s.started_at`,
      )
      .bind(id),
  ]);
  return { player, runs: runs.results, sessions: sessions.results };
}

export async function setNote(db: D1Database, id: string, note: string): Promise<boolean> {
  const res = await db.prepare("UPDATE players SET note = ? WHERE id = ?").bind(note, id).run();
  return (res.meta.changes ?? 0) > 0;
}

export async function runIdsForPlayer(db: D1Database, playerId: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT id FROM runs WHERE player_id = ?").bind(playerId).all<{ id: string }>();
  return results.map((r) => r.id);
}

export async function deletePlayer(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare("DELETE FROM players WHERE id = ?").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

export async function deleteRun(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare("DELETE FROM runs WHERE id = ?").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

export async function runExists(db: D1Database, id: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 FROM runs WHERE id = ?").bind(id).first()) !== null;
}

/**
 * A run with its sessions and events. Events are ordered by session start,
 * then seq, never by t (t rewinds when a save is reloaded). Event data stays
 * a JSON string; the viewer parses it, which keeps Worker CPU time low.
 */
export async function getRun(db: D1Database, id: string) {
  const run = await db
    .prepare(
      `SELECT r.id, r.player_id, p.note AS player_note, r.started_at, r.last_seen_at, r.play_time
       FROM runs r JOIN players p ON p.id = r.player_id WHERE r.id = ?`,
    )
    .bind(id)
    .first();
  if (!run) return null;
  const [sessions, events] = await db.batch([
    db
      .prepare(
        `SELECT id, started_at, ended_at, clean_exit, build, env, os, cpu, gpu, ram_mb, resolution, language
         FROM sessions WHERE run_id = ? ORDER BY started_at, id`,
      )
      .bind(id),
    db
      .prepare(
        `SELECT e.session_id AS s, e.seq, e.t, e.ts, e.type, e.data
         FROM events e JOIN sessions s ON s.id = e.session_id
         WHERE e.run_id = ? ORDER BY s.started_at, s.id, e.seq`,
      )
      .bind(id),
  ]);
  return { run, sessions: sessions.results, events: events.results };
}
