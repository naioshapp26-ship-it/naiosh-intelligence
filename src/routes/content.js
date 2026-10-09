'use strict';
// Organization configuration (Settings screen) and each user's own app state.
const db = require('../db');
const audit = require('../audit');
const { requireUser, requirePerm } = require('../auth');
const { send, readJson, clientIp, bad, HttpError } = require('../http');

function readCfg() {
  const row = db.get("SELECT value, updated_at FROM settings WHERE key = 'cfg'");
  return row ? { cfg: JSON.parse(row.value), updatedAt: row.updated_at } : { cfg: {}, updatedAt: null };
}

module.exports = (r) => {
  // Branding only — shown on the sign-in screen before login.
  r.add('GET', '/api/public/identity', async (req, res) => {
    const { cfg } = readCfg();
    const i = cfg.identity || {}, t = cfg.theme || {};
    send(res, 200, { brandAr: i.brandAr || null, brandEn: i.brandEn || null, brandSub: i.brandSub || null, theme: { red: t.red || null, action: t.action || null, yellow: t.yellow || null } });
  });

  r.add('GET', '/api/config', async (req, res) => {
    requireUser(req);
    send(res, 200, readCfg());
  });

  r.add('PUT', '/api/config', async (req, res) => {
    const me = requirePerm(req, 'config.edit');
    const body = await readJson(req);
    const cfg = body && body.cfg;
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw bad('invalid_config', 'Config must be an object');
    const value = JSON.stringify(cfg);
    if (value.length > 1.5 * 1024 * 1024) throw new HttpError(413, 'too_large', 'المحتوى أكبر من المسموح.');
    const at = db.nowIso();
    db.tx(() => {
      db.run(`INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('cfg', ?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`, value, me.id, at);
      db.run('INSERT INTO config_versions (value, user_id, created_at) VALUES (?, ?, ?)', value, me.id, at);
      audit.write({ user: me, action: 'config.publish', detail: 'نشر إعدادات المحتوى للجميع', ip: clientIp(req) });
    });
    send(res, 200, { ok: true, updatedAt: at });
  });

  r.add('GET', '/api/config/versions', async (req, res) => {
    requirePerm(req, 'config.edit');
    const rows = db.all(`SELECT v.id, v.created_at, u.name AS by_name, length(v.value) AS size
                         FROM config_versions v LEFT JOIN users u ON u.id = v.user_id ORDER BY v.id DESC LIMIT 50`);
    send(res, 200, { versions: rows });
  });

  r.add('POST', '/api/config/versions/:id/restore', async (req, res, p) => {
    const me = requirePerm(req, 'config.edit');
    const v = db.get('SELECT value FROM config_versions WHERE id = ?', +p.id);
    if (!v) throw new HttpError(404, 'not_found', 'Version not found');
    const at = db.nowIso();
    db.tx(() => {
      db.run(`UPDATE settings SET value = ?, updated_by = ?, updated_at = ? WHERE key = 'cfg'`, v.value, me.id, at);
      db.run('INSERT INTO config_versions (value, user_id, created_at) VALUES (?, ?, ?)', v.value, me.id, at);
      audit.write({ user: me, action: 'config.restore', detail: 'استعاد نسخة الإعدادات #' + p.id, ip: clientIp(req) });
    });
    send(res, 200, { ok: true });
  });

  r.add('GET', '/api/state', async (req, res) => {
    const me = requireUser(req);
    const row = db.get('SELECT state, updated_at FROM user_state WHERE user_id = ?', me.id);
    send(res, 200, row ? { state: JSON.parse(row.state), updatedAt: row.updated_at } : { state: null });
  });

  r.add('PUT', '/api/state', async (req, res) => {
    const me = requireUser(req);
    const body = await readJson(req);
    if (!body.state || typeof body.state !== 'object') throw bad('invalid_state', 'state must be an object');
    const value = JSON.stringify(body.state);
    if (value.length > 1024 * 1024) throw new HttpError(413, 'too_large', 'State too large');
    db.run(`INSERT INTO user_state (user_id, state, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`, me.id, value, db.nowIso());
    send(res, 200, { ok: true });
  });
};
module.exports.readCfg = readCfg;
