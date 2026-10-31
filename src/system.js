'use strict';
// Storage health and automatic database backups (VACUUM INTO — consistent while the server runs).
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const db = require('./db');

const backupDir = () => path.join(config.dataDir, 'backups');
const NAME = /^naiosh-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d{3})?Z\.db$/;

function listBackups() {
  try { return fs.readdirSync(backupDir()).filter(f => NAME.test(f)).sort().reverse().map(f => { const st = fs.statSync(path.join(backupDir(), f)); return { name: f, size: st.size, at: st.mtime.toISOString() }; }); }
  catch (_) { return []; }
}
function runBackup() {
  fs.mkdirSync(backupDir(), { recursive: true });
  const name = `naiosh-${new Date().toISOString().replace(/[:.]/g, '-')}.db`, out = path.join(backupDir(), name);
  db.db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  prune();
  return { name, size: fs.statSync(out).size, at: new Date().toISOString() };
}
function prune() { listBackups().slice(Math.max(1, config.backupKeep)).forEach(b => fs.rm(path.join(backupDir(), b.name), { force: true }, () => {})); }
function backupPath(name) { if (!NAME.test(String(name))) return null; const f = path.join(backupDir(), name); return fs.existsSync(f) ? f : null; }

function dirSize(dir) {
  let n = 0, files = 0;
  try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) { const s = dirSize(f); n += s.bytes; files += s.files; } else { n += fs.statSync(f).size; files++; } } } catch (_) {}
  return { bytes: n, files };
}
function storage() {
  const dbFile = path.join(config.dataDir, 'naiosh.db'); let dbBytes = 0;
  for (const f of [dbFile, dbFile + '-wal']) { try { dbBytes += fs.statSync(f).size; } catch (_) {} }
  let free = null; try { const s = fs.statfsSync(config.dataDir); free = s.bavail * s.bsize; } catch (_) {}
  return { dataDir: config.dataDir, persistent: config.dataPersistent, onRailway: config.onRailway, volume: process.env.RAILWAY_VOLUME_NAME || null, dbBytes, uploads: dirSize(path.join(config.dataDir, 'uploads')), freeBytes: free };
}

// Daily backup: runs after start (if the newest one is older than the interval) and then on a timer.
function scheduleBackups() {
  const every = config.backupEveryHours * 3600e3; if (!(every > 0)) return;
  const tick = () => { try { const last = listBackups()[0]; if (!last || Date.now() - Date.parse(last.at) > every - 60e3) { const b = runBackup(); console.log('[backup] written', b.name); } } catch (e) { console.error('[backup] failed', e.message); } };
  const t0 = setTimeout(tick, 30e3); t0.unref();
  const t = setInterval(tick, Math.min(every, 6 * 3600e3)); t.unref();
}
function startupWarnings() {
  if (config.dataPersistent === false) console.warn('\n[storage] ⚠ No Railway volume is attached — the database and uploaded files will be LOST on the next deploy.\n[storage]   Attach a volume mounted at /data (and set RAILWAY_RUN_UID=0). See README «التخزين الدائم».\n');
}
module.exports = { listBackups, runBackup, backupPath, storage, scheduleBackups, startupWarnings };
