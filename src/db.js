'use strict';
// SQLite through Node's built-in driver (node:sqlite) — no external dependencies.
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

// Silence only the "SQLite is experimental" notice; keep every other warning.
const origEmit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  const msg = typeof w === 'string' ? w : (w && w.message) || '';
  if (/SQLite is an experimental feature/.test(msg)) return;
  return origEmit.call(process, w, ...rest);
};
const { DatabaseSync } = require('node:sqlite');

let db = null;

function nowIso() { return new Date().toISOString(); }

function open(file) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  db = new DatabaseSync(file || path.join(config.dataDir, 'naiosh.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  migrate();
  return db;
}

function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const dir = path.join(config.root, 'migrations');
  const files = fs.readdirSync(dir).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
  const done = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version));
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    tx(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(f, nowIso());
    });
    console.log('[db] applied migration', f);
  }
}

// Transactions are re-entrant: a nested tx() joins the outer one.
let depth = 0;
function tx(fn) {
  if (depth > 0) { depth++; try { return fn(); } finally { depth--; } }
  db.exec('BEGIN IMMEDIATE'); depth = 1;
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
  finally { depth = 0; }
}

const get = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

function close() { if (db) { db.close(); db = null; } }

module.exports = { open, close, tx, get, all, run, nowIso, get db() { return db; } };
