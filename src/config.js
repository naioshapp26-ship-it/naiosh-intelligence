'use strict';
const path = require('node:path');

const env = process.env;
const ROOT = path.resolve(__dirname, '..');
const isProd = env.NODE_ENV === 'production';

const config = {
  isProd,
  root: ROOT,
  port: parseInt(env.PORT || '3000', 10),
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR || path.join(ROOT, 'data')),
  publicDir: path.join(ROOT, 'public'),
  // Behind Caddy/Nginx the real client IP arrives in X-Forwarded-For.
  trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  // Public origin, e.g. https://app.naiosh.com — used for the Origin check and secure cookies.
  appOrigin: (env.APP_ORIGIN || '').replace(/\/+$/, ''),
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === '1' || env.COOKIE_SECURE === 'true' : isProd,
  sessionHours: parseInt(env.SESSION_HOURS || '12', 10),
  limits: {
    jsonBytes: 2 * 1024 * 1024,
    videoBytes: parseInt(env.MAX_VIDEO_MB || '500', 10) * 1024 * 1024,
    fileBytes: parseInt(env.MAX_FILE_MB || '50', 10) * 1024 * 1024,
    filesPerRequest: 20,
    videosPerRequest: 5
  },
  admin: {
    email: env.ADMIN_EMAIL || '',
    password: env.ADMIN_PASSWORD || '',
    name: env.ADMIN_NAME || 'مدير النظام'
  }
};

module.exports = config;
