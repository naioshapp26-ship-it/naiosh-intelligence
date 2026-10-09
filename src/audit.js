'use strict';
// Append-only, hash-chained audit log. Each row stores sha256(prev_hash + row content),
// so any later tampering with the database file breaks the chain and is detected by verify().
const crypto = require('node:crypto');
const db = require('./db');

const GENESIS = '0'.repeat(64);

function rowHash(prev, r) {
  return crypto.createHash('sha256')
    .update([prev, r.at, r.user_id ?? '', r.actor, r.action, r.detail ?? '', r.kind, r.source, r.ip ?? ''].join('␟'))
    .digest('hex');
}

function write({ user, actor, action, detail = '', kind = 'user', source = 'server', ip = '' }) {
  return db.tx(() => {
    const last = db.get('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
    const prev = last ? last.hash : GENESIS;
    const r = {
      at: db.nowIso(),
      user_id: user ? user.id : null,
      actor: String(actor || (user ? user.name : 'النظام')).slice(0, 120),
      action: String(action).slice(0, 80),
      detail: String(detail || '').slice(0, 1000),
      kind, source, ip: String(ip || '').slice(0, 64)
    };
    const hash = rowHash(prev, r);
    db.run(`INSERT INTO audit_log (at, user_id, actor, action, detail, kind, source, ip, prev_hash, hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, r.at, r.user_id, r.actor, r.action, r.detail, r.kind, r.source, r.ip, prev, hash);
    return hash;
  });
}

function verify() {
  let prev = GENESIS, count = 0;
  for (const r of db.db.prepare('SELECT * FROM audit_log ORDER BY id ASC').iterate()) {
    if (r.prev_hash !== prev || rowHash(prev, r) !== r.hash) return { ok: false, count, brokenAt: r.id };
    prev = r.hash; count++;
  }
  return { ok: true, count, head: prev };
}

module.exports = { write, verify };
