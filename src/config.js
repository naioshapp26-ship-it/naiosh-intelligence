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
  // Where the database and uploads live. On Railway this must be a mounted volume, or data is lost on every deploy:
  // when a volume is attached and DATA_DIR is not inside it, the volume's mount path is used.
  dataDir: path.resolve((() => { const d = path.resolve(env.DATA_DIR || path.join(ROOT, 'data')), m = env.RAILWAY_VOLUME_MOUNT_PATH; return m && !(d + path.sep).startsWith(path.resolve(m) + path.sep) ? m : d; })()),
  // true when the data folder is known to survive redeploys (a Railway volume, or DATA_PERSISTENT=1 on your own server)
  dataPersistent: (() => { const m = env.RAILWAY_VOLUME_MOUNT_PATH; if (env.DATA_PERSISTENT === '1') return true; if (!m) return env.RAILWAY_ENVIRONMENT ? false : null; return true; })(),
  onRailway: !!(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID),
  // Automatic database backups inside the data folder: hours between backups and how many to keep (0 = off).
  backupEveryHours: parseFloat(env.BACKUP_EVERY_HOURS || '24'),
  backupKeep: parseInt(env.BACKUP_KEEP || '14', 10),
  // Claude (Anthropic API). AI_MODE: off | ask (اسأل نايوش يجيب عن الأسئلة الجديدة). Nothing is sent while off.
  ai: {
    key: env.ANTHROPIC_API_KEY || '',
    mode: (env.AI_MODE || 'off').toLowerCase(),
    baseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
    monthlyUsd: parseFloat(env.AI_MONTHLY_USD || '50'),
    userDaily: parseInt(env.AI_USER_DAILY || '30', 10),
    models: { fast: env.AI_MODEL_FAST || 'claude-haiku-5-5', main: env.AI_MODEL_MAIN || 'claude-sonnet-5-5', deep: env.AI_MODEL_DEEP || 'claude-opus-5-5' }
  },
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
  // Sign-up verification codes: 'demo' shows the codes on screen (no email/SMS is sent); 'live' sends them
  // through Resend (RESEND_API_KEY, MAIL_FROM) and Twilio (TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM).
  verifyMode: env.VERIFY_MODE === 'live' ? 'live' : 'demo',
  // Wallet top-ups: 'demo' adds points without any payment. A real gateway is connected later.
  paymentMode: env.PAYMENT_MODE === 'live' ? 'live' : 'demo',
  admin: {
    email: env.ADMIN_EMAIL || '',
    password: env.ADMIN_PASSWORD || '',
    name: env.ADMIN_NAME || 'مدير النظام'
  }
};

module.exports = config;
