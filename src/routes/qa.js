'use strict';
// تغذية البيانات → «اسأل نايوش»: admins train questions/answers; signed-in users ask; unmatched questions are kept for training.
const db = require('../db');
const audit = require('../audit');
const { requireUser, requirePerm } = require('../auth');
const { send, readJson, clientIp, bad, str, arr, HttpError } = require('../http');
const QA = require('../qa');

const row = (r) => ({ id: r.id, question: r.question, variants: JSON.parse(r.variants || '[]'), answer: r.answer, category: r.category || '', keywords: r.keywords || '', link: r.link || '', active: !!r.active, uses: r.uses, updatedAt: r.updated_at });
function body(b) {
  const e = { question: str(b.question, 300), variants: arr(b.variants, 30, 300).map(v => v.trim()).filter(Boolean), answer: str(b.answer, 4000), category: str(b.category, 80), keywords: str(b.keywords, 300), link: str(b.link, 40), active: b.active !== false };
  const errors = {};
  if (e.question.length < 3) errors.question = 'اكتب السؤال.';
  if (e.answer.length < 3) errors.answer = 'اكتب الإجابة.';
  if (Object.keys(errors).length) throw bad('validation', 'تحقق من الحقول.', { errors });
  return e;
}
const ASK = new Map(); // user → timestamps (60 per 10 min)

module.exports = (r) => {
  r.add('GET', '/api/qa', async (req, res) => {
    requirePerm(req, 'config.edit');
    send(res, 200, { entries: db.all('SELECT * FROM qa_entries ORDER BY id DESC').map(row), unanswered: db.all('SELECT id, question, count, last_at FROM qa_unanswered ORDER BY last_at DESC LIMIT 200') });
  });
  r.add('POST', '/api/qa', async (req, res) => {
    const me = requirePerm(req, 'config.edit'), e = body(await readJson(req, 64 * 1024)), at = db.nowIso();
    const info = db.run('INSERT INTO qa_entries (question, variants, answer, category, keywords, link, active, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', e.question, JSON.stringify(e.variants), e.answer, e.category, e.keywords, e.link, e.active ? 1 : 0, me.id, at, at);
    const fromUn = parseInt(req.headers['x-from-unanswered'] || '0', 10); if (fromUn) db.run('DELETE FROM qa_unanswered WHERE id = ?', fromUn);
    audit.write({ user: me, action: 'qa.create', detail: 'درّب «اسأل نايوش»: ' + e.question.slice(0, 80), ip: clientIp(req) });
    send(res, 201, { entry: row(db.get('SELECT * FROM qa_entries WHERE id = ?', Number(info.lastInsertRowid))) });
  });
  r.add('PATCH', '/api/qa/:id', async (req, res, p) => {
    const me = requirePerm(req, 'config.edit'); const old = db.get('SELECT * FROM qa_entries WHERE id = ?', +p.id);
    if (!old) throw new HttpError(404, 'not_found', 'غير موجود');
    const b = await readJson(req, 64 * 1024), e = body({ ...row(old), ...b });
    db.run('UPDATE qa_entries SET question = ?, variants = ?, answer = ?, category = ?, keywords = ?, link = ?, active = ?, updated_at = ? WHERE id = ?', e.question, JSON.stringify(e.variants), e.answer, e.category, e.keywords, e.link, e.active ? 1 : 0, db.nowIso(), old.id);
    audit.write({ user: me, action: 'qa.update', detail: 'عدّل إجابة: ' + e.question.slice(0, 80), ip: clientIp(req) });
    send(res, 200, { entry: row(db.get('SELECT * FROM qa_entries WHERE id = ?', old.id)) });
  });
  r.add('DELETE', '/api/qa/:id', async (req, res, p) => {
    const me = requirePerm(req, 'config.edit'); const old = db.get('SELECT question FROM qa_entries WHERE id = ?', +p.id);
    if (!old) throw new HttpError(404, 'not_found', 'غير موجود');
    db.run('DELETE FROM qa_entries WHERE id = ?', +p.id);
    audit.write({ user: me, action: 'qa.delete', detail: 'حذف سؤالًا مدرّبًا: ' + old.question.slice(0, 80), ip: clientIp(req) });
    send(res, 200, { ok: true });
  });
  r.add('DELETE', '/api/qa/unanswered/:id', async (req, res, p) => { requirePerm(req, 'config.edit'); db.run('DELETE FROM qa_unanswered WHERE id = ?', +p.id); send(res, 200, { ok: true }); });

  r.add('POST', '/api/qa/ask', async (req, res) => {
    const me = requireUser(req), now = Date.now();
    const a = (ASK.get(me.id) || []).filter(t => now - t < 600e3); if (a.length >= 60) throw new HttpError(429, 'too_many', 'أسئلة كثيرة — انتظر قليلًا.'); a.push(now); ASK.set(me.id, a);
    const b = await readJson(req, 8 * 1024), q = str(b.q, 500);
    if (q.length < 2) throw bad('empty', 'اكتب سؤالك.');
    const entries = db.all('SELECT * FROM qa_entries WHERE active = 1').map(row);
    const { best, top } = QA.match(q, entries);
    if (best && best.s >= QA.THRESHOLD) {
      db.run('UPDATE qa_entries SET uses = uses + 1 WHERE id = ?', best.e.id);
      send(res, 200, { found: true, score: Math.round(best.s * 100), answer: best.e.answer, question: best.e.question, link: best.e.link, category: best.e.category });
      return;
    }
    const n = QA.norm(q), at = db.nowIso();
    db.run(`INSERT INTO qa_unanswered (norm, question, user_id, first_at, last_at) VALUES (?,?,?,?,?) ON CONFLICT(norm) DO UPDATE SET count = count + 1, last_at = excluded.last_at`, n, q, me.id, at, at);
    send(res, 200, { found: false, suggestions: top.filter(x => x.s >= QA.SUGGEST).map(x => ({ id: x.e.id, question: x.e.question })) });
  });
};
