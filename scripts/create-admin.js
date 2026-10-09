'use strict';
// Create or reset a system admin from the command line:
//   node scripts/create-admin.js admin@company.com "Strong Pass 2026" "اسم المدير"
const db = require('../src/db');
const auth = require('../src/auth');
const audit = require('../src/audit');

const [email, password, name = 'مدير النظام'] = process.argv.slice(2);
if (!email || !password) { console.error('Usage: node scripts/create-admin.js <email> <password> [name]'); process.exit(1); }
const problem = auth.passwordProblem(password);
if (problem) { console.error(problem); process.exit(1); }
db.open();
const e = email.toLowerCase();
const u = db.get('SELECT id FROM users WHERE email = ?', e);
if (u) {
  db.run("UPDATE users SET password_hash = ?, role = 'admin', active = 1, must_change = 0 WHERE id = ?", auth.hashPassword(password), u.id);
  audit.write({ user: { id: u.id }, actor: 'CLI', action: 'admin.reset', detail: 'أُعيد تعيين حساب مدير من سطر الأوامر: ' + e, kind: 'security' });
  console.log('Admin reset:', e);
} else {
  const info = db.run("INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, 'admin', ?)", e, name, auth.hashPassword(password));
  audit.write({ user: { id: Number(info.lastInsertRowid) }, actor: 'CLI', action: 'admin.create', detail: 'أُنشئ حساب مدير من سطر الأوامر: ' + e, kind: 'security' });
  console.log('Admin created:', e);
}
db.close();
