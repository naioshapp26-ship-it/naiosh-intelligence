'use strict';
// NAIOSH Intelligence — web server and API. Zero external dependencies (Node.js >= 22.13).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const db = require('./db');
const audit = require('./audit');
const auth = require('./auth');
const { HttpError, send, createRouter, clientIp } = require('./http');

const router = createRouter();
require('./routes/auth')(router);
require('./routes/content')(router);
require('./routes/users')(router);
require('./routes/ledger')(router);
const requests = require('./routes/requests');
requests(router);

router.add('GET', '/api/health', async (req, res) => {
  let ok = true; try { db.get('SELECT 1 AS x'); } catch (_) { ok = false; }
  send(res, ok ? 200 : 503, { ok, time: new Date().toISOString() });
});

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'"
].join('; ');

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

// CSRF defence for state-changing API calls: a custom header (impossible cross-site without CORS)
// plus an Origin check when the browser sends one.
function checkCsrf(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  if (req.headers['x-naiosh'] !== '1') throw new HttpError(403, 'csrf', 'Missing request header');
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = config.appOrigin || `${config.cookieSecure ? 'https' : 'http'}://${req.headers.host}`;
  let o; try { o = new URL(origin); } catch (_) { throw new HttpError(403, 'csrf', 'Bad origin'); }
  const a = new URL(allowed);
  if (o.host !== a.host) throw new HttpError(403, 'csrf', 'Cross-origin request blocked');
}

// ---------- static frontend ----------
let INDEX = null;
function indexHtml() {
  if (INDEX && config.isProd) return INDEX;
  const f = path.join(config.publicDir, 'index.html');
  INDEX = fs.existsSync(f) ? fs.readFileSync(f) : Buffer.from('<!doctype html><meta charset="utf-8"><p>Frontend not built. Run: npm run build:frontend</p>');
  return INDEX;
}
const STATIC_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, pathname) {
  if (pathname !== '/' && !pathname.includes('..')) {
    const f = path.join(config.publicDir, pathname);
    const ext = path.extname(f);
    if (STATIC_TYPES[ext] && f.startsWith(config.publicDir) && fs.existsSync(f) && fs.statSync(f).isFile()) {
      res.writeHead(200, { 'Content-Type': STATIC_TYPES[ext], 'Cache-Control': 'public, max-age=86400' });
      return fs.createReadStream(f).pipe(res);
    }
  }
  // Single-page app: every other path gets the app shell.
  const body = indexHtml();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function handler(req, res) {
  securityHeaders(res);
  let pathname;
  try { pathname = new URL(req.url, 'http://local').pathname; } catch (_) { return send(res, 400, { error: 'bad_url' }); }
  try {
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' });
      return serveStatic(req, res, pathname);
    }
    checkCsrf(req);
    const m = router.match(req.method, pathname);
    if (m === 'method') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    if (!m) throw new HttpError(404, 'not_found', 'Not found');
    req.user = auth.currentUser(req);
    for (const h of m.handlers) await h(req, res, m.params);
  } catch (e) {
    if (res.headersSent) { res.destroy(); return; }
    if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message, ...(e.extra || {}) });
    console.error('[error]', req.method, pathname, e);
    send(res, 500, { error: 'server_error', message: 'حدث خطأ غير متوقع في الخادم.' });
  }
}

function seedAdmin() {
  const n = db.get('SELECT COUNT(*) AS n FROM users').n;
  if (n > 0) return;
  const { email, password, name } = config.admin;
  if (!email || !password) {
    console.warn('[setup] No users yet. Set ADMIN_EMAIL and ADMIN_PASSWORD, or run: npm run create-admin');
    return;
  }
  const problem = auth.passwordProblem(password);
  if (problem) { console.error('[setup] ADMIN_PASSWORD rejected:', problem); return; }
  const info = db.run("INSERT INTO users (email, name, role, password_hash, must_change) VALUES (?, ?, 'admin', ?, 0)", email.toLowerCase(), name, auth.hashPassword(password));
  audit.write({ user: { id: Number(info.lastInsertRowid) }, actor: name, action: 'setup', detail: 'أُنشئ حساب مدير النظام الأول', kind: 'sys' });
  console.log('[setup] Created first admin:', email);
}

function start({ port = config.port, host = config.host } = {}) {
  db.open();
  seedAdmin();
  requests.cleanupOrphans();
  const t = setInterval(requests.cleanupOrphans, 6 * 3600e3); t.unref();
  const server = http.createServer(handler);
  server.requestTimeout = 0;          // large video uploads may take a while
  server.headersTimeout = 60e3;
  server.keepAliveTimeout = 65e3;
  return new Promise((resolve) => server.listen(port, host, () => {
    const a = server.address();
    console.log(`[naiosh] listening on http://${host}:${a.port} (${config.isProd ? 'production' : 'development'})`);
    resolve(server);
  }));
}

if (require.main === module) {
  if (config.isProd && !config.appOrigin) console.warn('[setup] APP_ORIGIN is not set — set it to your https domain, e.g. https://app.example.com');
  start().then((server) => {
    const stop = () => { console.log('[naiosh] shutting down'); server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  });
}

module.exports = { start, handler };
