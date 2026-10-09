'use strict';
const db = require('../db');
const audit = require('../audit');
const A = require('../auth');
const { send, readJson, clientIp, bad, HttpError, str } = require('../http');
const { ROLES } = require('../roles');

const row = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, roleLabel: (ROLES[u.role] || {}).label || u.role, active: !!u.active, mustChange: !!u.must_change, createdAt: u.created_at, lastLogin: u.last_login });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function activeAdmins(exceptId) {
  return db.get("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?", exceptId || 0).n;
}

module.exports = (r) => {
  r.add('GET', '/api/users', async (req, res) => {
    A.requirePerm(req, 'users.manage');
    send(res, 200, { users: db.all('SELECT * FROM users ORDER BY active DESC, name').map(row), roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, v.label])) });
  });

  r.add('POST', '/api/users', async (req, res) => {
    const me = A.requirePerm(req, 'users.manage');
    const b = await readJson(req, 16 * 1024);
    const name = str(b.name, 120), email = str(b.email, 200).toLowerCase(), role = str(b.role, 30);
    const errors = {};
    if (!name) errors.name = 'أدخل الاسم.';
    if (!EMAIL.test(email)) errors.email = 'البريد الإلكتروني غير صحيح.';
    if (!ROLES[role]) errors.role = 'اختر الدور.';
    const pwProblem = A.passwordProblem(b.password); if (pwProblem) errors.password = pwProblem;
    if (!errors.email && db.get('SELECT id FROM users WHERE email = ?', email)) errors.email = 'هذا البريد مسجّل مسبقًا.';
    if (Object.keys(errors).length) throw bad('validation', 'تحقق من الحقول.', { errors });
    const info = db.run('INSERT INTO users (email, name, role, password_hash, must_change) VALUES (?, ?, ?, ?, 1)', email, name, role, A.hashPassword(b.password));
    audit.write({ user: me, action: 'user.create', detail: `أضاف المستخدم ${name} (${ROLES[role].label})`, ip: clientIp(req) });
    send(res, 201, { user: row(db.get('SELECT * FROM users WHERE id = ?', info.lastInsertRowid)) });
  });

  r.add('PATCH', '/api/users/:id', async (req, res, p) => {
    const me = A.requirePerm(req, 'users.manage');
    const id = +p.id;
    const u = db.get('SELECT * FROM users WHERE id = ?', id);
    if (!u) throw new HttpError(404, 'not_found', 'User not found');
    const b = await readJson(req, 16 * 1024);
    const changes = [];
    if (b.name !== undefined) { const n = str(b.name, 120); if (!n) throw bad('validation', 'الاسم مطلوب.'); db.run('UPDATE users SET name = ? WHERE id = ?', n, id); changes.push('الاسم'); }
    if (b.role !== undefined) {
      if (!ROLES[b.role]) throw bad('validation', 'دور غير معروف.');
      if (u.role === 'admin' && b.role !== 'admin' && activeAdmins(id) === 0) throw bad('last_admin', 'لا يمكن إزالة صلاحية آخر مدير نظام.');
      db.run('UPDATE users SET role = ? WHERE id = ?', b.role, id); changes.push('الدور → ' + ROLES[b.role].label);
    }
    if (b.active !== undefined) {
      const act = b.active ? 1 : 0;
      if (!act && id === me.id) throw bad('self_deactivate', 'لا يمكنك إيقاف حسابك.');
      if (!act && u.role === 'admin' && activeAdmins(id) === 0) throw bad('last_admin', 'لا يمكن إيقاف آخر مدير نظام.');
      db.run('UPDATE users SET active = ? WHERE id = ?', act, id); changes.push(act ? 'تفعيل' : 'إيقاف');
      if (!act) A.destroyUserSessions(id);
    }
    if (b.password !== undefined) {
      const pr = A.passwordProblem(b.password); if (pr) throw bad('weak_password', pr);
      db.run('UPDATE users SET password_hash = ?, must_change = 1 WHERE id = ?', A.hashPassword(b.password), id);
      A.destroyUserSessions(id); changes.push('إعادة تعيين كلمة المرور');
    }
    if (changes.length) audit.write({ user: me, action: 'user.update', detail: `${u.name}: ${changes.join('، ')}`, ip: clientIp(req) });
    send(res, 200, { user: row(db.get('SELECT * FROM users WHERE id = ?', id)) });
  });
};
