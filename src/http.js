'use strict';
// Minimal HTTP toolkit: router, JSON helpers, cookies, errors.
const config = require('./config');

class HttpError extends Error {
  constructor(status, code, message, extra) { super(message || code); this.status = status; this.code = code; this.extra = extra; }
}
const bad = (code, msg, extra) => new HttpError(400, code, msg, extra);

function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

function readJson(req, limit = config.limits.jsonBytes) {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/i.test(ct)) return reject(new HttpError(415, 'json_required', 'Content-Type must be application/json'));
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'too_large', 'Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > limit) return;
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(bad('invalid_json', 'Malformed JSON')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('='); if (i < 0) return;
    const k = p.slice(0, i).trim(); if (!k) return;
    try { out[k] = decodeURIComponent(p.slice(i + 1).trim()); } catch (_) { out[k] = p.slice(i + 1).trim(); }
  });
  return out;
}

function cookie(name, value, { maxAge, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (config.cookieSecure) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  return parts.join('; ');
}

function clientIp(req) {
  if (config.trustProxy) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress || '';
}

// Tiny router: add('GET', '/api/requests/:id', handler)
function createRouter() {
  const routes = [];
  function add(method, pattern, ...handlers) {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    routes.push({ method, rx, keys, handlers });
  }
  function match(method, pathname) {
    let allowed = false;
    for (const r of routes) {
      const m = r.rx.exec(pathname);
      if (!m) continue;
      if (r.method !== method) { allowed = true; continue; }
      const params = {};
      r.keys.forEach((k, i) => { try { params[k] = decodeURIComponent(m[i + 1]); } catch (_) { params[k] = m[i + 1]; } });
      return { handlers: r.handlers, params };
    }
    return allowed ? 'method' : null;
  }
  return { add, match };
}

// String helpers for validating input
function str(v, max = 500) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
function arr(v, max = 50, itemMax = 200) { return Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, max).map(x => x.slice(0, itemMax)) : []; }

module.exports = { HttpError, bad, send, readJson, parseCookies, cookie, clientIp, createRouter, str, arr };
