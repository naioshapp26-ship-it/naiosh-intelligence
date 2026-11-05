-- «تقاريري»: every report a user generates (engines, analysis results, legal final report …) is kept here so it can
-- be found and downloaded again later. Files live in DATA_DIR/uploads with uploads.kind = 'myreport'.
CREATE TABLE my_reports (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  upload_id  TEXT    NOT NULL REFERENCES uploads(id),
  title      TEXT    NOT NULL,
  ref        TEXT,
  source     TEXT,
  format     TEXT    NOT NULL,              -- pdf | xlsx
  created_at TEXT    NOT NULL
);
CREATE INDEX my_reports_user ON my_reports(user_id, id);
