-- Self sign-up with verified email + phone, points wallet, and sealed analysis reports.
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD COLUMN org TEXT;
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
ALTER TABLE users ADD COLUMN phone_verified_at TEXT;
CREATE UNIQUE INDEX users_phone ON users(phone) WHERE phone IS NOT NULL;

-- Pending sign-ups: the account is created only after both codes are confirmed.
CREATE TABLE signups (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL COLLATE NOCASE,
  phone         TEXT NOT NULL,
  org           TEXT,
  password_hash TEXT NOT NULL,
  email_code    TEXT NOT NULL,          -- sha256(id:code)
  sms_code      TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  resends       INTEGER NOT NULL DEFAULT 0,
  sent_at       TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  ip            TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE wallets (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance    INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at TEXT NOT NULL
);
CREATE TABLE wallet_tx (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta         INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  ref           TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX wallet_tx_user ON wallet_tx(user_id);

-- One sealed report per request. The stored PDF and its fingerprint can never be changed or deleted.
CREATE TABLE reports (
  id         INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL UNIQUE REFERENCES analysis_requests(id),
  upload_id  TEXT NOT NULL REFERENCES uploads(id),
  code       TEXT NOT NULL UNIQUE,
  sha256     TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TRIGGER reports_no_update BEFORE UPDATE ON reports BEGIN SELECT RAISE(ABORT, 'reports are immutable'); END;
CREATE TRIGGER reports_no_delete BEFORE DELETE ON reports BEGIN SELECT RAISE(ABORT, 'reports are immutable'); END;
