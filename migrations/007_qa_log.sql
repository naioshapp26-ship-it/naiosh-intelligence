-- Every question asked to «اسأل نايوش», with how it was answered — the admin can review and download it.
CREATE TABLE qa_log (
  id        INTEGER PRIMARY KEY,
  at        TEXT    NOT NULL,
  user_id   INTEGER REFERENCES users(id),
  question  TEXT    NOT NULL,
  source    TEXT    NOT NULL,      -- trained | ai | none
  entry_id  INTEGER,
  score     INTEGER,
  answer    TEXT
);
CREATE INDEX qa_log_at ON qa_log(at);
