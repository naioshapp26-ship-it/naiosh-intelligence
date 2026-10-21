'use strict';
// Self sign-up (real name, email and mobile — both verified with a code), the points wallet,
// and demo top-ups. Accounts created here get the 'client' role.
const crypto = require('node:crypto');
const db = require('../db');
const audit = require('../audit');
const A = require('../auth');
const config = require('../config');
const commerce = require('../commerce');
const notify = require('../notify');
const { can } = require('../roles');
const { send, readJson, cookie, clientIp, bad, HttpError, str } = require('../http');
const { publicUser } = require('./auth');

const CODE_MIN = 15, MAX_ATTEMPTS = 5, MAX_RESENDS = 5, RESEND_GAP = 60e3;
const HITS = new Map(); // ip → sign-up timestamps (max 5 per hour)
setInterval(() => { const now = Date.now(); for (const [k, a] of HITS) if (!a.some(t => now - t < 3600e3)) HITS.delete(k); }, 10 * 60e3).unref();
setInterval(() => { try { db.run('DELETE FROM signups WHERE expires_at < ?', new Date(Date.now() - 24 * 3600e3).toISOString()); } catch (_) {} }, 60 * 60e3).unref();

const h = (id, code) => crypto.createHash('sha256').update(id + ':' + code).digest('hex');
const newCode = () => String(crypto.randomInt(100000, 1000000));
const normPhone = (p) => { const d = String(p || '').replace(/[\s\-()]/g, ''); return /^\+?\d{8,15}$/.test(d) ? (d.startsWith('+') ? d : '+' + d.replace(/^00/, '')) : ''; };
const eqHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function deliver(su, emailCode, smsCode) {
  const text = (c) => `رمز التحقق في نايوش: ${c} — صالح ${CODE_MIN} دقيقة. لا تشاركه مع أحد.`;
  try {
    await notify.sendEmail(su.email, 'رمز التحقق — نايوش', text(emailCode));
    await notify.sendSms(su.phone, text(smsCode));
  } catch (e) {
    if (e instanceof notify.NotConfigured) throw new HttpError(503, 'verify_not_configured', 'خدمة إرسال رموز التحقق غير مُعدّة بعد. تواصل مع مدير النظام.');
    throw new HttpError(502, 'verify_send_failed', 'تعذّر إرسال رمز التحقق — حاول بعد قليل.');
  }
  return config.verifyMode === 'demo' ? { email: emailCode, sms: smsCode } : undefined;
}

module.exports = (r) => {
  r.add('POST', '/api/public/register', async (req, res) => {
    const ip = clientIp(req), now = Date.now();
    const hits = (HITS.get(ip) || []).filter(t => now - t < 3600e3);
    if (hits.length >= 5) throw new HttpError(429, 'too_many_signups', 'محاولات تسجيل كثيرة من هذا الجهاز. حاول بعد ساعة.');
    const b = await readJson(req, 16 * 1024);
    const f = { name: str(b.name, 120).replace(/\s+/g, ' '), email: str(b.email, 200).toLowerCase(), phone: normPhone(b.phone), org: str(b.org, 200) };
    const pw = typeof b.password === 'string' ? b.password : '';
    const errors = {};
    if (f.name.split(' ').filter(w => w.length >= 2).length < 2) errors.name = 'اكتب اسمك الحقيقي الكامل (الاسم الأول واسم العائلة).';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email)) errors.email = 'البريد الإلكتروني غير صحيح.';
    if (!f.phone) errors.phone = 'رقم الجوال غير صحيح — اكتبه مع رمز الدولة، مثل +962791234567.';
    const pp = A.passwordProblem(pw); if (pp) errors.password = pp;
    if (b.accept !== true) errors.accept = 'الموافقة على الشروط وسياسة الخصوصية مطلوبة.';
    if (!errors.email && db.get('SELECT 1 FROM users WHERE email = ?', f.email)) errors.email = 'هذا البريد مسجّل مسبقًا — سجّل الدخول بدل إنشاء حساب جديد.';
    if (!errors.phone && db.get('SELECT 1 FROM users WHERE phone = ?', f.phone)) errors.phone = 'رقم الجوال مسجّل في حساب آخر. لكل رقم حساب واحد.';
    if (Object.keys(errors).length) throw bad('validation', 'تحقق من الحقول.', { errors });
    hits.push(now); HITS.set(ip, hits);
    const id = crypto.randomUUID(), ec = newCode(), sc = newCode(), at = db.nowIso();
    const su = { id, ...f };
    db.run('DELETE FROM signups WHERE email = ? OR phone = ?', f.email, f.phone);
    db.run(`INSERT INTO signups (id, name, email, phone, org, password_hash, email_code, sms_code, sent_at, expires_at, ip, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, f.name, f.email, f.phone, f.org || null, A.hashPassword(pw), h(id, ec), h(id, sc), at, new Date(now + CODE_MIN * 60e3).toISOString(), ip, at);
    const demo = await deliver(su, ec, sc);
    audit.write({ actor: f.email, action: 'signup.start', detail: 'بدء إنشاء حساب — أُرسل رمزا التحقق', kind: 'security', ip });
    send(res, 201, { id, email: f.email, phone: f.phone, mode: config.verifyMode, demo, expiresMin: CODE_MIN });
  });

  r.add('POST', '/api/public/register/resend', async (req, res) => {
    const b = await readJson(req, 4 * 1024);
    const su = db.get('SELECT * FROM signups WHERE id = ?', str(b.id, 60));
    if (!su) throw new HttpError(410, 'expired', 'انتهت صلاحية التسجيل — ابدأ من جديد.');
    if (Date.now() - Date.parse(su.sent_at) < RESEND_GAP) throw new HttpError(429, 'too_soon', 'انتظر دقيقة قبل طلب رمز جديد.');
    if (su.resends >= MAX_RESENDS) throw new HttpError(429, 'too_many_resends', 'طلبت رموزًا كثيرة. ابدأ التسجيل من جديد لاحقًا.');
    const ec = newCode(), sc = newCode(), at = db.nowIso();
    db.run('UPDATE signups SET email_code = ?, sms_code = ?, attempts = 0, resends = resends + 1, sent_at = ?, expires_at = ? WHERE id = ?', h(su.id, ec), h(su.id, sc), at, new Date(Date.now() + CODE_MIN * 60e3).toISOString(), su.id);
    const demo = await deliver(su, ec, sc);
    send(res, 200, { ok: true, demo });
  });

  r.add('POST', '/api/public/register/verify', async (req, res) => {
    const b = await readJson(req, 4 * 1024), ip = clientIp(req);
    const su = db.get('SELECT * FROM signups WHERE id = ?', str(b.id, 60));
    if (!su || su.expires_at < db.nowIso()) throw new HttpError(410, 'expired', 'انتهت صلاحية الرمز — اطلب رمزًا جديدًا.');
    if (su.attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'too_many_attempts', 'محاولات خاطئة كثيرة — اطلب رمزًا جديدًا.');
    const okE = eqHash(h(su.id, str(b.emailCode, 10)), su.email_code), okS = eqHash(h(su.id, str(b.smsCode, 10)), su.sms_code);
    if (!okE || !okS) {
      db.run('UPDATE signups SET attempts = attempts + 1 WHERE id = ?', su.id);
      const errors = {}; if (!okE) errors.emailCode = 'رمز البريد غير صحيح.'; if (!okS) errors.smsCode = 'رمز الجوال غير صحيح.';
      throw bad('wrong_code', 'رمز التحقق غير صحيح.', { errors, left: MAX_ATTEMPTS - su.attempts - 1 });
    }
    const c = commerce.settings();
    const user = db.tx(() => {
      if (db.get('SELECT 1 FROM users WHERE email = ? OR phone = ?', su.email, su.phone)) throw new HttpError(409, 'exists', 'البريد أو الجوال مسجّل مسبقًا.');
      const at = db.nowIso();
      const info = db.run(`INSERT INTO users (email, name, role, password_hash, phone, org, email_verified_at, phone_verified_at) VALUES (?, ?, 'client', ?, ?, ?, ?, ?)`,
        su.email, su.name, su.password_hash, su.phone, su.org, at, at);
      const uid = Number(info.lastInsertRowid);
      if (c.welcomePoints > 0) commerce.move(uid, c.welcomePoints, 'هدية الترحيب', null);
      db.run('DELETE FROM signups WHERE id = ?', su.id);
      const u = db.get('SELECT * FROM users WHERE id = ?', uid);
      audit.write({ user: u, action: 'signup.complete', detail: `حساب جديد موثّق بالبريد والجوال — ${c.welcomePoints} نقطة ترحيب`, kind: 'security', ip });
      return u;
    });
    const s = A.createSession(user.id, ip, req.headers['user-agent']);
    db.run('UPDATE users SET last_login = ? WHERE id = ?', db.nowIso(), user.id);
    send(res, 201, { user: publicUser(user), welcomePoints: c.welcomePoints }, { 'Set-Cookie': cookie(A.COOKIE, s.token, { maxAge: s.maxAge }) });
  });

  // ---- wallet ----
  r.add('GET', '/api/wallet', async (req, res) => {
    const me = A.requireUser(req), c = commerce.settings();
    const tx = db.all('SELECT delta, balance_after, reason, ref, created_at FROM wallet_tx WHERE user_id = ? ORDER BY id DESC LIMIT 100', me.id);
    send(res, 200, { balance: commerce.balance(me.id), exempt: can(me, 'requests.viewAll'), requestCost: c.requestCost, currency: c.currency, paymentMode: config.paymentMode,
      tx: tx.map(t => ({ t: t.reason, pts: t.delta, ref: t.ref, at: t.created_at })) });
  });

  r.add('POST', '/api/wallet/topup', async (req, res) => {
    const me = A.requireUser(req);
    if (config.paymentMode !== 'demo') throw new HttpError(501, 'payment_not_configured', 'الدفع الإلكتروني غير مفعّل بعد.');
    const b = await readJson(req, 4 * 1024), c = commerce.settings();
    const pk = c.packs.find(p => p.id === str(b.pack, 20));
    if (!pk) throw bad('invalid_pack', 'الباقة غير موجودة.');
    const bal = db.tx(() => {
      const n = commerce.move(me.id, pk.pts, 'شحن ' + pk.name + ' (تجريبي — دون دفع)', pk.id);
      audit.write({ user: me, action: 'wallet.topup', detail: `شحن تجريبي ${pk.pts} نقطة`, ip: clientIp(req) });
      return n;
    });
    send(res, 200, { ok: true, balance: bal });
  });
};
