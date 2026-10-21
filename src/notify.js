'use strict';
// Verification messages. In demo mode nothing is sent (the code is returned to the screen).
// In live mode: email through Resend, SMS through Twilio — set the environment variables listed in README.
const config = require('./config');
const env = process.env;

class NotConfigured extends Error {}

async function sendEmail(to, subject, text) {
  if (config.verifyMode !== 'live') return { demo: true };
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) throw new NotConfigured('email');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text })
  });
  if (!r.ok) throw new Error('email send failed: ' + r.status);
  return { sent: true };
}

async function sendSms(to, text) {
  if (config.verifyMode !== 'live') return { demo: true };
  if (!env.TWILIO_SID || !env.TWILIO_TOKEN || !env.TWILIO_FROM) throw new NotConfigured('sms');
  const body = new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: text });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_SID)}/Messages.json`, {
    method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(env.TWILIO_SID + ':' + env.TWILIO_TOKEN).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  if (!r.ok) throw new Error('sms send failed: ' + r.status);
  return { sent: true };
}

module.exports = { sendEmail, sendSms, NotConfigured };
