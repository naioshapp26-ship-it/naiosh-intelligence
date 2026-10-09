-- NAIOSH Intelligence — initial schema (SQLite)
-- All timestamps are ISO-8601 UTC strings.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT    NOT NULL,
  role          TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  must_change   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login    TEXT
);

CREATE TABLE sessions (
  id         TEXT    PRIMARY KEY,              -- sha256 of the cookie token
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT    NOT NULL,
  last_seen  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ip         TEXT,
  ua         TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Organization-wide content managed from the Settings screen (key = 'cfg').
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Every published configuration is kept so it can be restored.
CREATE TABLE config_versions (
  id         INTEGER PRIMARY KEY,
  value      TEXT    NOT NULL,
  user_id    INTEGER REFERENCES users(id),
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Each user's own journey through the app (consultation progress, selections).
CREATE TABLE user_state (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- "طلب تحليل بيانات"
CREATE TABLE analysis_requests (
  id          INTEGER PRIMARY KEY,
  ref         TEXT    NOT NULL UNIQUE,         -- DAR-YYYY-NNN
  title       TEXT    NOT NULL,
  status      TEXT    NOT NULL,
  priority    TEXT,
  payload     TEXT    NOT NULL,                -- full form as JSON
  summary     TEXT    NOT NULL,                -- computed data contract as JSON
  created_by  INTEGER NOT NULL REFERENCES users(id),
  assigned_to INTEGER REFERENCES users(id),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX analysis_requests_owner ON analysis_requests(created_by);

CREATE TABLE request_events (
  id          INTEGER PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES analysis_requests(id),
  user_id     INTEGER REFERENCES users(id),
  status_from TEXT,
  status_to   TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Uploaded files and videos. Stored on disk under DATA_DIR/uploads, never in the web root.
CREATE TABLE uploads (
  id            TEXT    PRIMARY KEY,
  owner_id      INTEGER NOT NULL REFERENCES users(id),
  request_id    INTEGER REFERENCES analysis_requests(id),
  kind          TEXT    NOT NULL,              -- 'video' | 'file'
  original_name TEXT    NOT NULL,
  mime          TEXT    NOT NULL,
  size          INTEGER NOT NULL,
  sha256        TEXT    NOT NULL,
  stored_name   TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX uploads_request ON uploads(request_id);

-- Decision ledger (DIA-19)
CREATE TABLE decisions (
  id           INTEGER PRIMARY KEY,
  ref          TEXT    NOT NULL UNIQUE,        -- DEC-YYYY-NNN
  consultation TEXT,
  choice       TEXT,
  choice_label TEXT,
  solution     TEXT,
  rationale    TEXT,
  decided_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Append-only, hash-chained audit trail. Updates and deletes are rejected by triggers.
CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY,
  at        TEXT    NOT NULL,
  user_id   INTEGER,
  actor     TEXT    NOT NULL,
  action    TEXT    NOT NULL,
  detail    TEXT,
  kind      TEXT    NOT NULL,                  -- user | sys | warn | security
  source    TEXT    NOT NULL,                  -- server | client
  ip        TEXT,
  prev_hash TEXT    NOT NULL,
  hash      TEXT    NOT NULL
);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
