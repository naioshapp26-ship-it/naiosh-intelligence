-- تغذية البيانات: knowledge written or pasted by the admin for the analysis axes, the information centre and the
-- NAIOSH Hub systems. «اسأل نايوش» (and the AI phases) use it as reference; files attach like trained answers.
CREATE TABLE kb_feeds (
  id           INTEGER PRIMARY KEY,
  scope        TEXT    NOT NULL,             -- axis | info | hub
  target       TEXT    NOT NULL,             -- 'all' or the axis / section / system key
  target_label TEXT    NOT NULL,
  body         TEXT    NOT NULL,
  keywords     TEXT,
  link         TEXT,
  attachments  TEXT    NOT NULL DEFAULT '[]',
  active       INTEGER NOT NULL DEFAULT 1,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);
CREATE INDEX kb_feeds_scope ON kb_feeds(scope, target);
