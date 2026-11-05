'use strict';
// «تقاريري»: the reports each user generated, kept on the server so they can be opened again from «طلباتي وتقاريري».
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const db = require('../db');
const { requireUser } = require('../auth');
const { can } = require('../roles');
const { send, HttpError, bad } = require('../http');
const { serveUpload, uploadDir } = require('./requests');

const MAX = 40 * 1024 * 1024;
const MIME = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const hdr = (req, k, max) => { try { return decodeURIComponent(String(req.headers[k] || '')).trim().slice(0, max); } catch (_) { return ''; } };
const view = (r) => ({ id: r.id, title: r.title, ref: r.ref || '', source: r.source || '', format: r.format, size: r.size, createdAt: r.created_at });

module.exports = (r) => {
  r.add('GET', '/api/my-reports', async (req, res) => {
    const me = requireUser(req);
    send(res, 200, { reports: db.all('SELECT m.*, u.size FROM my_reports m JOIN uploads u ON u.id = m.upload_id WHERE m.user_id = ? ORDER BY m.id DESC LIMIT 1000', me.id).map(view) });
  });
  // Raw body = the file. Headers: X-Report-Title, X-Report-Ref, X-Report-Source (URI-encoded), X-Report-Format: pdf|xlsx
  r.add('POST', '/api/my-reports', async (req, res) => {
    const me = requireUser(req), format = String(req.headers['x-report-format'] || '').toLowerCase();
    if (!MIME[format]) throw bad('format', 'صيغة غير مدعومة.');
    const title = hdr(req, 'x-report-title', 200) || 'تقرير', ref = hdr(req, 'x-report-ref', 60), source = hdr(req, 'x-report-source', 120);
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > MAX) throw new HttpError(413, 'too_large', 'التقرير أكبر من المسموح.'); chunks.push(c); }
    const buf = Buffer.concat(chunks);
    if (!buf.length) throw bad('empty_file', 'الملف فارغ.');
    const magicOk = format === 'pdf' ? buf.subarray(0, 5).toString() === '%PDF-' : buf[0] === 0x50 && buf[1] === 0x4b;
    if (!magicOk) throw bad('file_type', 'الملف ليس تقريرًا صالحًا.');
    fs.mkdirSync(uploadDir(), { recursive: true });
    const id = crypto.randomUUID(), stored = id + '.' + format, at = db.nowIso();
    fs.writeFileSync(path.join(uploadDir(), stored), buf, { flag: 'wx' });
    const name = `NAIOSH_${ref.replace(/[^A-Za-z0-9_-]+/g, '') || 'report'}_${at.slice(0, 10)}.${format}`;
    db.tx(() => {
      db.run(`INSERT INTO uploads (id, owner_id, kind, original_name, mime, size, sha256, stored_name) VALUES (?, ?, 'myreport', ?, ?, ?, ?, ?)`, id, me.id, name, MIME[format], buf.length, crypto.createHash('sha256').update(buf).digest('hex'), stored);
      db.run('INSERT INTO my_reports (user_id, upload_id, title, ref, source, format, created_at) VALUES (?,?,?,?,?,?,?)', me.id, id, title, ref, source, format, at);
    });
    // keep each user's archive bounded (newest 500)
    const old = db.all('SELECT id, upload_id FROM my_reports WHERE user_id = ? ORDER BY id DESC LIMIT -1 OFFSET 500', me.id);
    for (const o of old) remove(o);
    send(res, 201, { report: view(db.get('SELECT m.*, u.size FROM my_reports m JOIN uploads u ON u.id = m.upload_id WHERE m.upload_id = ?', id)) });
  });
  r.add('GET', '/api/my-reports/:id/file', async (req, res, p) => {
    const me = requireUser(req), m = db.get('SELECT * FROM my_reports WHERE id = ?', +p.id);
    if (!m || (m.user_id !== me.id && !can(me, 'config.edit'))) throw new HttpError(404, 'not_found', 'Report not found');
    const u = db.get('SELECT * FROM uploads WHERE id = ?', m.upload_id); if (!u) throw new HttpError(404, 'not_found', 'Report not found');
    serveUpload(req, res, u, false);
  });
  r.add('DELETE', '/api/my-reports/:id', async (req, res, p) => {
    const me = requireUser(req), m = db.get('SELECT * FROM my_reports WHERE id = ?', +p.id);
    if (!m || m.user_id !== me.id) throw new HttpError(404, 'not_found', 'Report not found');
    remove(m); send(res, 200, { ok: true });
  });
};
function remove(m) {
  const u = db.get('SELECT stored_name FROM uploads WHERE id = ?', m.upload_id);
  db.run('DELETE FROM my_reports WHERE id = ?', m.id);
  if (u) { fs.rm(path.join(uploadDir(), u.stored_name), { force: true }, () => {}); db.run('DELETE FROM uploads WHERE id = ?', m.upload_id); }
}
