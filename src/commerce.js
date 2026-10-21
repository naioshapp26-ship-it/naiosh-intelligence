'use strict';
// Points and prices come from the published Settings (cfg.commerce, cfg.packs) with safe defaults.
const db = require('./db');

const DEFAULTS = { currency: 'JOD', welcomePoints: 300, requestCost: 50 };
const DEFAULT_PACKS = [
  { id: 'p100', name: 'باقة البداية', pts: 100, price: 9 },
  { id: 'p300', name: 'باقة الأعمال', pts: 300, price: 24 },
  { id: 'p1000', name: 'باقة المؤسسات', pts: 1000, price: 69 },
  { id: 'p3000', name: 'باقة الشركاء', pts: 3000, price: 179 }
];
const int = (v, d, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 && n <= max ? n : d; };

function settings() {
  let cfg = {};
  try { const row = db.get("SELECT value FROM settings WHERE key = 'cfg'"); if (row) cfg = JSON.parse(row.value) || {}; } catch (_) {}
  const c = cfg.commerce || {};
  const packs = (Array.isArray(cfg.packs) && cfg.packs.length ? cfg.packs : DEFAULT_PACKS)
    .map((p, i) => ({ id: String(p.id || 'p' + i).slice(0, 20), name: String(p.name || 'باقة').slice(0, 80), pts: int(p.pts, 0, 1e6), price: Number(p.price) || 0 }))
    .filter(p => p.pts > 0);
  return {
    currency: String(c.currency || DEFAULTS.currency).slice(0, 10),
    welcomePoints: int(c.welcomePoints, DEFAULTS.welcomePoints, 1e5),
    requestCost: int(c.requestCost, DEFAULTS.requestCost, 1e5),
    packs
  };
}

function balance(userId) { const w = db.get('SELECT balance FROM wallets WHERE user_id = ?', userId); return w ? w.balance : 0; }

// Must run inside db.tx(). Throws if the balance would go negative.
function move(userId, delta, reason, ref) {
  const now = db.nowIso();
  db.run('INSERT INTO wallets (user_id, balance, updated_at) VALUES (?, 0, ?) ON CONFLICT(user_id) DO NOTHING', userId, now);
  const cur = balance(userId), next = cur + delta;
  if (next < 0) { const e = new Error('insufficient'); e.insufficient = true; e.balance = cur; throw e; }
  db.run('UPDATE wallets SET balance = ?, updated_at = ? WHERE user_id = ?', next, now, userId);
  db.run('INSERT INTO wallet_tx (user_id, delta, balance_after, reason, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)', userId, delta, next, reason, ref || null, now);
  return next;
}

module.exports = { settings, balance, move };
