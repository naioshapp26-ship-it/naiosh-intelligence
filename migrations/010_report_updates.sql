-- A request whose first report was issued without data (or with incomplete data) gets an updated sealed report once
-- the client attaches data. The first report stays as it was (immutable); every update is a new sealed report with
-- its own verification code. The newest one is what the client downloads; every code stays verifiable.
CREATE TABLE report_updates (
  id         INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES analysis_requests(id),
  rev        INTEGER NOT NULL,
  upload_id  TEXT    NOT NULL REFERENCES uploads(id),
  code       TEXT    NOT NULL UNIQUE,
  sha256     TEXT    NOT NULL,
  size       INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT    NOT NULL,
  UNIQUE (request_id, rev)
);
CREATE TRIGGER report_updates_no_update BEFORE UPDATE ON report_updates BEGIN SELECT RAISE(ABORT, 'reports are immutable'); END;
CREATE TRIGGER report_updates_no_delete BEFORE DELETE ON report_updates BEGIN SELECT RAISE(ABORT, 'reports are immutable'); END;
CREATE VIEW all_reports AS
  SELECT request_id, upload_id, code, sha256, size, created_by, created_at, 0 AS rev FROM reports
  UNION ALL SELECT request_id, upload_id, code, sha256, size, created_by, created_at, rev FROM report_updates;
