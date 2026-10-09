'use strict';
const db = require('../db');
const audit = require('../audit');
const A = require('../auth');
const { send, readJson, cookie, clientIp, bad, HttpError, str } = require('../http');
const { ROLES, permsOf } = require('../roles');

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, roleLabel: (ROLES[u.role] || {}).label || u.role, perms: permsOf(u.role), mustChange: !!u.mustChange };
}

module.exports = (r) => {
  r.add('POST', '/api/auth/login', async (req, res) => {
    const body = await readJson(req, 16 * 1024);
    const email = str(body.email, 200).toLowerCase();
    const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
    const ip = clientIp(req);
    if (!email || !password) throw bad('missing_fields', 'أدخل البريد الإلكتروني وكلمة المرور.');
    if (A.isThrottled(ip, email)) {
      audit.write({ actor: email, action: 'login.throttled', detail: 'محاولات دخول كثيرة', kind: 'security', ip });
      throw new HttpError(429, 'too_many_attempts', 'محاولات كثيرة. انتظر 15 دقيقة ثم أعد المحاولة.');
    }
    const u = db.get('SELECT * FROM users WHERE email = ?', email);
    const ok = A.verifyPassword(password, u ? u.password_hash : A.DUMMY_HASH) && u && u.active;
    if (!ok) {
      A.noteFailure(ip, email);
      audit.write({ user: u && { id: u.id }, actor: email, action: 'login.failed', detail: u && !u.active ? 'حساب موقوف' : 'بيانات غير صحيحة', kind: 'security', ip });
      throw new HttpError(401, 'invalid_credentials', 'البريد الإلكتروني أو كلمة المرور غير صحيحة.');
    }
    A.clearFailures(ip, email);
    const s = A.createSession(u.id, ip, req.headers['user-agent']);
    db.run('UPDATE users SET last_login = ? WHERE id = ?', db.nowIso(), u.id);
    audit.write({ user: u, action: 'login', detail: 'تسجيل دخول', kind: 'security', ip });
    send(res, 200, { user: publicUser({ ...u, mustChange: u.must_change }) }, { 'Set-Cookie': cookie(A.COOKIE, s.token, { maxAge: s.maxAge }) });
  });

  r.add('POST', '/api/auth/logout', async (req, res) => {
    if (req.user) audit.write({ user: req.user, action: 'logout', detail: 'تسجيل خروج', kind: 'security', ip: clientIp(req) });
    A.destroySession(req);
    send(res, 200, { ok: true }, { 'Set-Cookie': cookie(A.COOKIE, '', { maxAge: 0 }) });
  });

  r.add('GET', '/api/auth/me', async (req, res) => {
    A.requireUser(req);
    send(res, 200, { user: publicUser(req.user), roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, v.label])) });
  });

  r.add('POST', '/api/auth/password', async (req, res) => {
    const me = A.requireUser(req);
    const body = await readJson(req, 16 * 1024);
    const u = db.get('SELECT * FROM users WHERE id = ?', me.id);
    if (!A.verifyPassword(String(body.current || ''), u.password_hash)) throw bad('wrong_password', 'كلمة المرور الحالية غير صحيحة.');
    const problem = A.passwordProblem(body.next);
    if (problem) throw bad('weak_password', problem);
    db.run('UPDATE users SET password_hash = ?, must_change = 0 WHERE id = ?', A.hashPassword(body.next), me.id);
    A.destroyUserSessions(me.id, req);
    audit.write({ user: me, action: 'password.change', detail: 'غيّر كلمة المرور', kind: 'security', ip: clientIp(req) });
    send(res, 200, { ok: true });
  });
};
module.exports.publicUser = publicUser;
