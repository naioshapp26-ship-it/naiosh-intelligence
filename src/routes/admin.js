'use strict';
// «حالة النظام» (admin): storage, backups, verification/payment modes and the AI switch.
const fs = require('node:fs');
const config = require('../config');
const audit = require('../audit');
const system = require('../system');
const ai = require('../ai');
const { requirePerm } = require('../auth');
const { send, readJson, clientIp, HttpError } = require('../http');

module.exports = (r) => {
  r.add('GET', '/api/admin/system', async (req, res) => {
    requirePerm(req, 'config.edit');
    send(res, 200, { storage: system.storage(), backups: system.listBackups(), backupEveryHours: config.backupEveryHours, backupKeep: config.backupKeep,
      verifyMode: config.verifyMode, paymentMode: config.paymentMode, appOrigin: config.appOrigin || null, ai: ai.status(), node: process.version, uptimeSec: Math.round(process.uptime()) });
  });
  r.add('POST', '/api/admin/backup', async (req, res) => {
    const me = requirePerm(req, 'config.edit'); const b = system.runBackup();
    audit.write({ user: me, action: 'backup.create', detail: 'نسخة احتياطية يدوية ' + b.name, ip: clientIp(req) });
    send(res, 201, { backup: b });
  });
  r.add('GET', '/api/admin/backup/:name', async (req, res, p) => {
    const me = requirePerm(req, 'config.edit'); const f = system.backupPath(p.name);
    if (!f) throw new HttpError(404, 'not_found', 'Backup not found');
    audit.write({ user: me, action: 'backup.download', detail: 'نزّل النسخة الاحتياطية ' + p.name, ip: clientIp(req) });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(f).size, 'Content-Disposition': `attachment; filename="${p.name}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  r.add('PATCH', '/api/admin/ai', async (req, res) => {
    const me = requirePerm(req, 'config.edit'), b = await readJson(req, 4096);
    if (typeof b.paused === 'boolean') { ai.setSetting('ai_paused', b.paused ? '1' : '0', me.id); audit.write({ user: me, action: b.paused ? 'ai.pause' : 'ai.resume', detail: b.paused ? 'أوقف الذكاء الاصطناعي مؤقتًا' : 'أعاد تشغيل الذكاء الاصطناعي', ip: clientIp(req) }); }
    send(res, 200, { ai: ai.status() });
  });
  r.add('POST', '/api/admin/ai/test', async (req, res) => {
    const me = requirePerm(req, 'config.edit');
    try { const t = await ai.test(me.id); send(res, 200, { ok: true, ...t }); }
    catch (e) { send(res, 200, { ok: false, reason: e.reason || null, message: e.reason === 'no_key' ? 'لم يُضف المفتاح ANTHROPIC_API_KEY في متغيرات الخادم.' : e.reason === 'cap' ? 'وصل إنفاق هذا الشهر إلى السقف.' : (e.status === 401 ? 'المفتاح غير صحيح (401).' : 'تعذّر الاتصال: ' + String(e.message || e).slice(0, 200)) }); }
  });
};
