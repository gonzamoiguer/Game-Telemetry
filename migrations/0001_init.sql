-- Urbes en Urgencia playtest telemetry: initial schema.

CREATE TABLE players (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT ''          -- editable label in the viewer ("cousin, first time")
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  play_time REAL NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  clean_exit INTEGER NOT NULL DEFAULT 0,
  build TEXT NOT NULL,
  env TEXT NOT NULL,
  os TEXT, cpu TEXT, gpu TEXT, ram_mb INTEGER, resolution TEXT, language TEXT
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  t REAL NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT,
  UNIQUE (session_id, seq)
);
CREATE INDEX events_run ON events (run_id, session_id, seq);
-- Feedback flags and "last turn" lookups filter by type, then run.
CREATE INDEX events_type ON events (type, run_id);
CREATE INDEX runs_player ON runs (player_id);
CREATE INDEX sessions_run ON sessions (run_id);

CREATE TABLE login_attempts (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX login_attempts_ip ON login_attempts (ip, at);
