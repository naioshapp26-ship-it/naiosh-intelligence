'use strict';
// اتصل بنا: complaints, suggestions and inquiries. Anyone may send one (visitors too);
// staff with requests.viewAll read and answer them; a signed-in sender sees their own.
const db = require('../db');
const audit = require('../audit');
const { requireUser, requirePerm } = require('../auth');
const { can } = require('../roles');
const { send, readJson, clientIp, bad, str, HttpError } = require('../http');

const KINDS = { complaint: 'شكوى', suggestion: 'مقترح', inquiry: 'استفسار' };
const STATUSES = { new: 'جديدة', open: 'قيد المعالجة', closed: 'مغلقة' };
const SENT = new Map(); // ip → timestamps (max 8 per hour)
setInterval(() => { const now = Date.now(); for (const [k, a] of SENT) if (!a.some(t => now - t < 3600e3)) SENT.delete(k); }, 10 * 60e3).unref();

function nextRef() {
  const y = new Date().getUTCFullYear();
  const last = db.get('SELECT ref FROM messages WHERE ref LIKE ? ORDER BY id DESC LIMIT 1', `MSG-${y}-%`);
  const n = last ? parseInt(last.ref.split('-')[2], 10) + 1 : 1;
  return `MSG-${y}-${String(n).padStart(3, '0')}`;
}
const view = (m) => ({ id: m.id, ref: m.ref, kind: m.kind, kindLabel: KINDS[m.kind] || m.kind, name: m.name, email: m.email, phone: m.phone, subject: m.subject, body: m.body,
  status: m.status, statusLabel: STATUSES[m.status] || m.status, note: m.note, createdAt: m.created_at, updatedAt: m.updated_at });

module.exports = (r) => {
  r.add('POST', '/api/public/messages', async (req, res) => {
    const ip = clientIp(req), now = Date.now();
    const a = (SENT.get(ip) || []).filter(t => now - t < 3600e3);
    if (a.length >= 8) throw new HttpError(429, 'too_many_messages', 'أرسلت رسائل كثيرة. حاول بعد ساعة.');
    const p = await readJson(req);
    if (str(p.website, 200)) { send(res, 201, { ok: true, ref: 'MSG-0' }); return; } // honeypot field: bots fill it, people never see it
    const kind = KINDS[p.kind] ? p.kind : '';
    const m = { kind, name: str(p.name, 120), email: str(p.email, 200), phone: str(p.phone, 40), subject: str(p.subject, 200), body: str(p.body, 4000) };
    const errors = {};
    if (!kind) errors.kind = 'اختر نوع الرسالة';
    if (m.name.length < 2) errors.name = 'اكتب الاسم';
    if (!m.email && !m.phone) errors.email = 'اكتب البريد الإلكتروني أو رقم الجوال للتواصل';
    if (m.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.email)) errors.email = 'البريد الإلكتروني غير صحيح';
    if (m.body.length < 10) errors.body = 'اكتب تفاصيل الرسالة (10 أحرف على الأقل)';
    if (Object.keys(errors).length) throw bad('invalid', 'تحقق من الحقول المطلوبة', { errors });
    a.push(now); SENT.set(ip, a);
    const at = db.nowIso(), user = req.user || null;
    const ref = db.tx(() => {
      const ref = nextRef();
      db.run(`INSERT INTO messages (ref, kind, name, email, phone, subject, body, user_id, ip, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ref, kind, m.name, m.email || null, m.phone || null, m.subject || null, m.body, user ? user.id : null, ip, at, at);
      audit.write({ user, actor: user ? undefined : m.name, action: 'message.create', detail: `${KINDS[kind]} جديدة ${ref}`, ip });
      return ref;
    });
    send(res, 201, { ok: true, ref });
  });

  r.add('GET', '/api/messages', async (req, res) => {
    const me = requireUser(req);
    const all = can(me, 'requests.viewAll');
    const rows = all ? db.all('SELECT * FROM messages ORDER BY id DESC LIMIT 500') : db.all('SELECT * FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 200', me.id);
    send(res, 200, { messages: rows.map(m => ({ ...view(m), mine: m.user_id === me.id })), scope: all ? 'all' : 'own', kinds: KINDS, statuses: STATUSES });
  });

  r.add('PATCH', '/api/messages/:id', async (req, res, p) => {
    const me = requirePerm(req, 'requests.viewAll');
    const m = db.get('SELECT * FROM messages WHERE id = ?', +p.id);
    if (!m) throw new HttpError(404, 'not_found', 'الرسالة غير موجودة');
    const b = await readJson(req);
    const status = STATUSES[b.status] ? b.status : m.status, note = b.note === undefined ? m.note : str(b.note, 2000);
    db.tx(() => {
      db.run('UPDATE messages SET status = ?, note = ?, updated_at = ? WHERE id = ?', status, note, db.nowIso(), m.id);
      audit.write({ user: me, action: 'message.update', detail: `${m.ref} ← ${STATUSES[status]}`, ip: clientIp(req) });
    });
    send(res, 200, { ok: true, message: view(db.get('SELECT * FROM messages WHERE id = ?', m.id)) });
  });
};
