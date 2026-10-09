'use strict';
// Audit trail (DIA-20) and decision ledger (DIA-19).
const db = require('../db');
const audit = require('../audit');
const { requireUser, requirePerm } = require('../auth');
const { can } = require('../roles');
const { send, readJson, clientIp, bad, str } = require('../http');

const KINDS = new Set(['user', 'sys', 'warn']);

function nextRef(prefix, table) {
  const y = new Date().getUTCFullYear();
  const like = `${prefix}-${y}-%`;
  const last = db.get(`SELECT ref FROM ${table} WHERE ref LIKE ? ORDER BY id DESC LIMIT 1`, like);
  const n = last ? parseInt(last.ref.split('-')[2], 10) + 1 : 1;
  return `${prefix}-${y}-${String(n).padStart(3, '0')}`;
}

module.exports = (r) => {
  r.add('GET', '/api/audit', async (req, res) => {
    const me = requireUser(req);
    const limit = Math.min(500, Math.max(1, parseInt(new URL(req.url, 'http://x').searchParams.get('limit') || '200', 10)));
    const rows = can(me, 'audit.view')
      ? db.all('SELECT id, at, actor, action, detail, kind, source FROM audit_log ORDER BY id DESC LIMIT ?', limit)
      : db.all('SELECT id, at, actor, action, detail, kind, source FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ?', me.id, limit);
    send(res, 200, { entries: rows, scope: can(me, 'audit.view') ? 'all' : 'own' });
  });

  // Events produced by the app's own engines (orchestrator, early warning…) on behalf of the signed-in user.
  r.add('POST', '/api/audit', async (req, res) => {
    const me = requireUser(req);
    const b = await readJson(req, 16 * 1024);
    const kind = KINDS.has(b.kind) ? b.kind : 'user';
    const what = str(b.what, 1000);
    if (!what) throw bad('missing_fields', 'what is required');
    // User actions are always attributed to the signed-in user, whatever the client sends.
    const actor = kind === 'user' ? me.name : str(b.who, 120) || 'النظام';
    audit.write({ user: me, actor, action: 'app.event', detail: what, kind, source: 'client', ip: clientIp(req) });
    send(res, 201, { ok: true });
  });

  r.add('GET', '/api/audit/verify', async (req, res) => {
    const me = requirePerm(req, 'audit.verify');
    const result = audit.verify();
    audit.write({ user: me, action: 'audit.verify', detail: result.ok ? `سلسلة التدقيق سليمة (${result.count} سجل)` : `انكسار في السلسلة عند السجل ${result.brokenAt}`, kind: result.ok ? 'sys' : 'security', ip: clientIp(req) });
    send(res, 200, result);
  });

  r.add('GET', '/api/decisions', async (req, res) => {
    const me = requireUser(req);
    const sql = `SELECT d.*, u.name AS decided_by_name FROM decisions d JOIN users u ON u.id = d.decided_by`;
    const rows = can(me, 'decisions.viewAll') ? db.all(sql + ' ORDER BY d.id DESC LIMIT 200') : db.all(sql + ' WHERE d.decided_by = ? ORDER BY d.id DESC LIMIT 200', me.id);
    send(res, 200, { decisions: rows });
  });

  r.add('POST', '/api/decisions', async (req, res) => {
    const me = requirePerm(req, 'decisions.create');
    const b = await readJson(req, 64 * 1024);
    const rationale = str(b.rationale, 4000);
    if (rationale.length < 4) throw bad('validation', 'مبرر القرار مطلوب.');
    const out = db.tx(() => {
      const ref = nextRef('DEC', 'decisions');
      db.run(`INSERT INTO decisions (ref, consultation, choice, choice_label, solution, rationale, decided_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ref, str(b.consultation, 40), str(b.choice, 40), str(b.choiceLabel, 120), str(b.solution, 300), rationale, me.id);
      audit.write({ user: me, action: 'decision.create', detail: `سجّل القرار ${ref} (${str(b.choiceLabel, 120)}): ${str(b.solution, 200)}`, ip: clientIp(req) });
      return ref;
    });
    send(res, 201, { ref: out });
  });
};
module.exports.nextRef = nextRef;
