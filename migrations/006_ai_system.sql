-- Claude (Anthropic API): every call is logged with its tokens and cost, for the monthly cap and the admin panel.
CREATE TABLE ai_usage (
  id         INTEGER PRIMARY KEY,
  at         TEXT    NOT NULL,
  user_id    INTEGER REFERENCES users(id),
  feature    TEXT    NOT NULL,              -- ask | test | …
  model      TEXT    NOT NULL,
  in_tokens  INTEGER NOT NULL DEFAULT 0,
  out_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd   REAL    NOT NULL DEFAULT 0,
  ok         INTEGER NOT NULL DEFAULT 1,
  error      TEXT
);
CREATE INDEX ai_usage_at ON ai_usage(at);
CREATE INDEX ai_usage_user ON ai_usage(user_id, at);
-- the AI's suggested answer to a question that had no trained answer, waiting for the admin's review
ALTER TABLE qa_unanswered ADD COLUMN ai_answer TEXT;
