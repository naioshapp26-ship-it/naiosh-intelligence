-- Contact messages: complaints, suggestions and inquiries sent from the public pages (اتصل بنا).
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'new',
  note TEXT,
  ip TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX messages_status ON messages(status);
CREATE INDEX messages_user ON messages(user_id);
