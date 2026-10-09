'use strict';
// "طلب تحليل بيانات" — uploads (streamed straight to disk) and analysis requests.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const db = require('../db');
const audit = require('../audit');
const config = require('../config');
const { requireUser, requirePerm } = require('../auth');
const { can } = require('../roles');
const { send, readJson, clientIp, bad, HttpError, str, arr } = require('../http');
const { nextRef } = require('./ledger');

const STATUSES = {
  new: 'جديد', collecting: 'جمع البيانات', ready: 'جاهز للتحليل', analyzing: 'قيد التحليل',
  review: 'قيد المراجعة', done: 'مكتمل', rejected: 'مرفوض'
};
const FILE_EXT = new Set(['xlsx', 'xls', 'csv', 'pdf', 'png', 'jpg', 'jpeg', 'docx']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv']);
const INLINE_VIDEO = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const MIME_BY_EXT = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', csv: 'text/csv', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4', avi: 'video/x-msvideo', mkv: 'video/x-matroska' };

const uploadDir = () => path.join(config.dataDir, 'uploads');
const extOf = (n) => (String(n).toLowerCase().match(/\.([a-z0-9]{1,5})$/) || [])[1] || '';

function safeName(n) {
  return String(n || 'file').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_').replace(/^\.+/, '').slice(0, 180) || 'file';
}

function reqView(row, me) {
  const s = JSON.parse(row.summary);
  return {
    id: row.id, ref: row.ref, title: row.title, status: row.status, statusLabel: STATUSES[row.status] || row.status,
    priority: row.priority, createdAt: row.created_at, updatedAt: row.updated_at,
    owner: row.owner_name, ownerId: row.created_by, mine: row.created_by === me.id,
    typesLabel: s.typesLabel || '', domainLabel: s.domainLabel || '', suff: s.suff ?? null, missing: s.missing || '—',
    output: s.output || '', files: row.n_files || 0, videos: row.n_videos || 0
  };
}

function canSee(me, row) { return row.created_by === me.id || can(me, 'requests.viewAll'); }

const LIST_SQL = `SELECT r.*, u.name AS owner_name,
  (SELECT COUNT(*) FROM uploads x WHERE x.request_id = r.id AND x.kind = 'file')  AS n_files,
  (SELECT COUNT(*) FROM uploads x WHERE x.request_id = r.id AND x.kind = 'video') AS n_videos
  FROM analysis_requests r JOIN users u ON u.id = r.created_by`;

module.exports = (r) => {
  // Raw upload: body is the file itself. Headers: X-File-Name (URI-encoded), X-Upload-Kind: video|file
  r.add('POST', '/api/uploads', async (req, res) => {
    const me = requireUser(req);
    const kind = req.headers['x-upload-kind'] === 'video' ? 'video' : 'file';
    let name; try { name = safeName(decodeURIComponent(String(req.headers['x-file-name'] || ''))); } catch (_) { name = 'file'; }
    const ext = extOf(name);
    if (kind === 'video' ? !VIDEO_EXT.has(ext) : !FILE_EXT.has(ext)) throw bad('file_type', kind === 'video' ? 'صيغة الفيديو غير مدعومة (MP4, MOV, WEBM, M4V, AVI, MKV).' : 'صيغة الملف غير مدعومة (Excel, CSV, PDF, Word, صور).');
    const max = kind === 'video' ? config.limits.videoBytes : config.limits.fileBytes;
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > max) throw new HttpError(413, 'too_large', `الحجم الأقصى ${Math.round(max / 1048576)} MB.`);

    fs.mkdirSync(uploadDir(), { recursive: true });
    const id = crypto.randomUUID();
    const stored = id + '.' + ext;
    const target = path.join(uploadDir(), stored);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > max) return cb(new HttpError(413, 'too_large', `الحجم الأقصى ${Math.round(max / 1048576)} MB.`));
        hash.update(chunk); cb(null, chunk);
      }
    });
    try { await pipeline(req, counter, fs.createWriteStream(target, { flags: 'wx' })); }
    catch (e) { fs.rm(target, { force: true }, () => {}); throw e instanceof HttpError ? e : bad('aborted', 'انقطع الرفع — أعد المحاولة.'); }
    if (size === 0) { fs.rm(target, { force: true }, () => {}); throw bad('empty_file', 'الملف فارغ.'); }
    const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
    db.run(`INSERT INTO uploads (id, owner_id, kind, original_name, mime, size, sha256, stored_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, me.id, kind, name, mime, size, hash.digest('hex'), stored);
    send(res, 201, { id, name, size, kind });
  });

  r.add('POST', '/api/requests', async (req, res) => {
    const me = requireUser(req);
    const b = await readJson(req, 256 * 1024);
    const p = b.payload || {}, s = b.summary || {};
    const errors = {};
    const payload = {
      name: str(p.name, 120), phone: str(p.phone, 40), email: str(p.email, 200), org: str(p.org, 200), branch: str(p.branch, 200), role: str(p.role, 60),
      systems: arr(p.systems), domain: str(p.domain, 10), types: arr(p.types, 20, 20), title: str(p.title, 200), question: str(p.question, 4000),
      since: str(p.since, 300), where: str(p.where, 300), who: str(p.who, 300), tried: str(p.tried, 2000), decision: str(p.decision, 2000), kpi: str(p.kpi, 300),
      from: str(p.from, 20), to: str(p.to, 20), have: arr(p.have), link: str(p.link, 500),
      capex: str(p.capex, 60), currency: str(p.currency, 10), horizon: str(p.horizon, 10), ptype: str(p.ptype, 20),
      riskCats: arr(p.riskCats), riskAppetite: str(p.riskAppetite, 20),
      cls: str(p.cls, 20), priority: str(p.priority, 20), level: str(p.level, 10), due: str(p.due, 20), outputs: arr(p.outputs), contact: str(p.contact, 40), consent: !!p.consent
    };
    if (!payload.name) errors.name = 'أدخل الاسم الكامل.';
    if (!payload.phone && !payload.email) errors.email = 'أدخل رقم الجوال أو البريد الإلكتروني للتواصل.';
    if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) errors.email = 'البريد الإلكتروني غير صحيح.';
    if (!payload.domain) errors.domain = 'اختر المجال الرئيسي للطلب.';
    if (!payload.types.length) errors.types = 'اختر نوع تحليل واحدًا على الأقل.';
    if (!payload.title) errors.title = 'أضف عنوانًا قصيرًا للطلب.';
    if (!payload.question) errors.question = 'اكتب السؤال الذي تريد إجابته.';
    if (!payload.consent) errors.consent = 'الموافقة على استخدام البيانات مطلوبة.';
    if (Object.keys(errors).length) throw bad('validation', 'تحقق من الحقول.', { errors });

    const ids = arr(b.uploads, config.limits.filesPerRequest + config.limits.videosPerRequest, 64);
    const ups = ids.map(id => db.get('SELECT * FROM uploads WHERE id = ?', id));
    if (ups.some(u => !u || u.owner_id !== me.id || u.request_id)) throw bad('invalid_upload', 'أحد المرفقات غير صالح أو مستخدم مسبقًا.');
    if (ups.filter(u => u.kind === 'video').length > config.limits.videosPerRequest) throw bad('too_many_videos', `الحد الأقصى ${config.limits.videosPerRequest} فيديوهات.`);
    if (ups.filter(u => u.kind === 'file').length > config.limits.filesPerRequest) throw bad('too_many_files', `الحد الأقصى ${config.limits.filesPerRequest} ملفًا.`);

    const suff = Math.max(0, Math.min(100, parseInt(s.suff, 10) || 0));
    const summary = { typesLabel: str(s.typesLabel, 400), domainLabel: str(s.domainLabel, 120), suff, missing: str(s.missing, 600) || '—', output: str(s.output, 120) };
    const status = suff >= 80 ? 'ready' : 'collecting';

    const out = db.tx(() => {
      const ref = nextRef('DAR', 'analysis_requests');
      const info = db.run(`INSERT INTO analysis_requests (ref, title, status, priority, payload, summary, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ref, payload.title, status, payload.priority, JSON.stringify(payload), JSON.stringify(summary), me.id);
      const rid = Number(info.lastInsertRowid);
      for (const u of ups) db.run('UPDATE uploads SET request_id = ? WHERE id = ?', rid, u.id);
      db.run('INSERT INTO request_events (request_id, user_id, status_to, note) VALUES (?, ?, ?, ?)', rid, me.id, status, 'أُنشئ الطلب');
      audit.write({ user: me, action: 'request.create', detail: `أرسل طلب تحليل بيانات ${ref}: ${payload.title} — ${ups.length} مرفق`, ip: clientIp(req) });
      audit.write({ user: me, actor: 'المنسّق', action: 'request.contract', detail: `أنشأ عقد بيانات لـ ${ref} — الكفاية ${suff}%`, kind: 'sys' });
      return rid;
    });
    send(res, 201, { request: reqView(db.get(LIST_SQL + ' WHERE r.id = ?', out), me) });
  });

  r.add('GET', '/api/requests', async (req, res) => {
    const me = requireUser(req);
    const rows = can(me, 'requests.viewAll') ? db.all(LIST_SQL + ' ORDER BY r.id DESC LIMIT 500') : db.all(LIST_SQL + ' WHERE r.created_by = ? ORDER BY r.id DESC LIMIT 500', me.id);
    send(res, 200, { requests: rows.map(x => reqView(x, me)), statuses: STATUSES, canManage: can(me, 'requests.manage') });
  });

  r.add('GET', '/api/requests/:id', async (req, res, p) => {
    const me = requireUser(req);
    const row = db.get(LIST_SQL + ' WHERE r.id = ?', +p.id);
    if (!row || !canSee(me, row)) throw new HttpError(404, 'not_found', 'Request not found');
    const files = db.all('SELECT id, kind, original_name AS name, mime, size, created_at FROM uploads WHERE request_id = ? ORDER BY created_at', row.id);
    const events = db.all(`SELECT e.*, u.name AS by_name FROM request_events e LEFT JOIN users u ON u.id = e.user_id WHERE request_id = ? ORDER BY e.id`, row.id)
      .map(e => ({ at: e.created_at, by: e.by_name, from: e.status_from && (STATUSES[e.status_from] || e.status_from), to: e.status_to && (STATUSES[e.status_to] || e.status_to), note: e.note }));
    send(res, 200, { request: { ...reqView(row, me), payload: JSON.parse(row.payload), files, events } });
  });

  r.add('PATCH', '/api/requests/:id', async (req, res, p) => {
    const me = requirePerm(req, 'requests.manage');
    const row = db.get('SELECT * FROM analysis_requests WHERE id = ?', +p.id);
    if (!row) throw new HttpError(404, 'not_found', 'Request not found');
    const b = await readJson(req, 16 * 1024);
    const status = str(b.status, 20), note = str(b.note, 2000);
    if (status && !STATUSES[status]) throw bad('invalid_status', 'حالة غير معروفة.');
    if (!status && !note) throw bad('missing_fields', 'لا يوجد تغيير.');
    db.tx(() => {
      if (status && status !== row.status) db.run('UPDATE analysis_requests SET status = ?, updated_at = ? WHERE id = ?', status, db.nowIso(), row.id);
      db.run('INSERT INTO request_events (request_id, user_id, status_from, status_to, note) VALUES (?, ?, ?, ?, ?)', row.id, me.id, status ? row.status : null, status || null, note || null);
      audit.write({ user: me, action: 'request.update', detail: `${row.ref}: ${status ? (STATUSES[row.status] + ' ← ' + STATUSES[status]) : 'ملاحظة'}${note ? ' — ' + note.slice(0, 120) : ''}`, ip: clientIp(req) });
    });
    send(res, 200, { ok: true });
  });

  // Download / stream an attachment (owner of the request or anyone allowed to view all requests).
  r.add('GET', '/api/files/:id', async (req, res, p) => {
    const me = requireUser(req);
    const u = db.get(`SELECT x.*, r.created_by FROM uploads x LEFT JOIN analysis_requests r ON r.id = x.request_id WHERE x.id = ?`, p.id);
    if (!u) throw new HttpError(404, 'not_found', 'File not found');
    const allowed = u.owner_id === me.id || (u.request_id && (u.created_by === me.id || can(me, 'requests.viewAll')));
    if (!allowed) throw new HttpError(404, 'not_found', 'File not found');
    const file = path.join(uploadDir(), u.stored_name);
    let stat; try { stat = fs.statSync(file); } catch (_) { throw new HttpError(404, 'not_found', 'File missing'); }
    const inline = INLINE_VIDEO.has(u.mime) && new URL(req.url, 'http://x').searchParams.get('inline') === '1';
    const headers = {
      'Content-Type': u.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(u.original_name)}`
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? parseInt(range[1], 10) : stat.size - parseInt(range[2], 10);
      let end = range[1] && range[2] ? parseInt(range[2], 10) : stat.size - 1;
      if (isNaN(start) || start < 0 || start >= stat.size || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    fs.createReadStream(file).pipe(res);
  });
};

// Remove uploads that were never attached to a request (abandoned forms) after 24 hours.
function cleanupOrphans() {
  const cutoff = new Date(Date.now() - 24 * 3600e3).toISOString();
  const rows = db.all('SELECT id, stored_name FROM uploads WHERE request_id IS NULL AND created_at < ?', cutoff);
  for (const r of rows) { fs.rm(path.join(uploadDir(), r.stored_name), { force: true }, () => {}); db.run('DELETE FROM uploads WHERE id = ?', r.id); }
  if (rows.length) console.log('[uploads] removed', rows.length, 'orphan uploads');
}
module.exports.cleanupOrphans = cleanupOrphans;
module.exports.STATUSES = STATUSES;
