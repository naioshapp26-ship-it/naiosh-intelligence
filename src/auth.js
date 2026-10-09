'use strict';
// Password hashing (scrypt), server-side sessions in SQLite, login throttling.
const crypto = require('node:crypto');
const db = require('./db');
const config = require('./config');
const { HttpError, parseCookies } = require('./http');
const { can } = require('./roles');

const COOKIE = 'naiosh_sid';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, salt, key] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const want = Buffer.from(key, 'base64');
    const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(want, got);
  } catch (_) { return false; }
}

// A dummy hash so failed logins for unknown emails take the same time as wrong passwords.
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'كلمة المرور يجب أن تكون 10 أحرف على الأقل.';
  if (pw.length > 200) return 'كلمة المرور طويلة جدًا.';
  if (!/[A-Za-z؀-ۿ]/.test(pw) || !/\d/.test(pw)) return 'كلمة المرور يجب أن تحتوي على حروف وأرقام.';
  return null;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(userId, ip, ua) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionHours * 3600e3).toISOString();
  db.run('INSERT INTO sessions (id, user_id, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?)', sha(token), userId, expires, ip, String(ua || '').slice(0, 200));
  return { token, maxAge: config.sessionHours * 3600 };
}

function destroySession(req) {
  const t = parseCookies(req)[COOKIE];
  if (t) db.run('DELETE FROM sessions WHERE id = ?', sha(t));
}

function destroyUserSessions(userId, exceptReq) {
  const keep = exceptReq ? parseCookies(exceptReq)[COOKIE] : null;
  if (keep) db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', userId, sha(keep));
  else db.run('DELETE FROM sessions WHERE user_id = ?', userId);
}

// Resolve the session cookie → user. Sliding expiry: each request extends the session.
function currentUser(req) {
  const t = parseCookies(req)[COOKIE];
  if (!t) return null;
  const row = db.get(`SELECT s.id sid, s.expires_at, u.id, u.email, u.name, u.role, u.active, u.must_change
                      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`, sha(t));
  if (!row) return null;
  if (row.expires_at < db.nowIso() || !row.active) { db.run('DELETE FROM sessions WHERE id = ?', row.sid); return null; }
  const next = new Date(Date.now() + config.sessionHours * 3600e3).toISOString();
  db.run('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?', db.nowIso(), next, row.sid);
  return { id: row.id, email: row.email, name: row.name, role: row.role, mustChange: !!row.must_change };
}

function requireUser(req) {
  if (!req.user) throw new HttpError(401, 'unauthenticated', 'Sign in required');
  return req.user;
}
function requirePerm(req, perm) {
  requireUser(req);
  if (!can(req.user, perm)) throw new HttpError(403, 'forbidden', 'Not allowed');
  return req.user;
}

// Login throttling: max 8 failures per (ip+email) and 30 per ip in 15 minutes.
const FAILS = new Map();
const WINDOW = 15 * 60e3;
function throttleKeyCheck(key, max) {
  const now = Date.now();
  const a = (FAILS.get(key) || []).filter(t => now - t < WINDOW);
  FAILS.set(key, a);
  return a.length >= max;
}
function isThrottled(ip, email) { return throttleKeyCheck('ip:' + ip, 30) || throttleKeyCheck('ie:' + ip + ':' + email, 8); }
function noteFailure(ip, email) {
  const now = Date.now();
  for (const k of ['ip:' + ip, 'ie:' + ip + ':' + email]) { const a = FAILS.get(k) || []; a.push(now); FAILS.set(k, a); }
}
function clearFailures(ip, email) { FAILS.delete('ie:' + ip + ':' + email); }
setInterval(() => { const now = Date.now(); for (const [k, a] of FAILS) if (!a.some(t => now - t < WINDOW)) FAILS.delete(k); }, 5 * 60e3).unref();
setInterval(() => { try { db.run('DELETE FROM sessions WHERE expires_at < ?', db.nowIso()); } catch (_) {} }, 60 * 60e3).unref();

module.exports = {
  COOKIE, hashPassword, verifyPassword, DUMMY_HASH, passwordProblem, createSession, destroySession,
  destroyUserSessions, currentUser, requireUser, requirePerm, isThrottled, noteFailure, clearFailures
};
