'use strict';
// Integration tests: node --test test/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'naiosh-test-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'AdminPass2026';
process.env.ADMIN_NAME = 'د. عدنان';
process.env.MAX_FILE_MB = '1';

const { start } = require('../src/server');
const db = require('../src/db');
let server, base;

before(async () => { server = await start({ port: 0, host: '127.0.0.1' }); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function client() {
  let jar = '';
  return async function call(method, url, body, headers = {}) {
    const h = { 'X-Naiosh': '1', ...headers };
    if (jar) h.Cookie = jar;
    let payload = body;
    if (body !== undefined && !(body instanceof Buffer)) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers: h, body: payload });
    const sc = res.headers.get('set-cookie'); if (sc) jar = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  };
}
const admin = client(), analyst = client(), clientA = client(), clientB = client(), anon = client();

test('serves the app shell and security headers', async () => {
  const r = await anon('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
});

test('auth: rejects bad credentials, accepts admin', async () => {
  assert.equal((await anon('GET', '/api/auth/me')).status, 401);
  assert.equal((await admin('POST', '/api/auth/login', { email: 'admin@test.local', password: 'wrong-pass-1' })).status, 401);
  const ok = await admin('POST', '/api/auth/login', { email: 'ADMIN@test.local', password: 'AdminPass2026' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, 'admin');
  const me = await admin('GET', '/api/auth/me');
  assert.equal(me.body.user.name, 'د. عدنان');
});

test('csrf: mutating calls need the X-Naiosh header and same origin', async () => {
  const r1 = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r1.status, 403);
  const r2 = await admin('PUT', '/api/state', { state: {} }, { Origin: 'https://evil.example' });
  assert.equal(r2.status, 403);
});

test('users: admin creates users; validation; non-admin forbidden', async () => {
  const bad = await admin('POST', '/api/users', { name: '', email: 'x', role: 'nope', password: 'short' });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.email && bad.body.errors.role && bad.body.errors.password && bad.body.errors.name);
  for (const [email, role, name] of [['analyst@test.local', 'analyst', 'محللة'], ['a@test.local', 'client', 'عميل أ'], ['b@test.local', 'client', 'عميل ب']]) {
    const r = await admin('POST', '/api/users', { name, email, role, password: 'Password2026' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.user.mustChange, true);
  }
  assert.equal((await admin('POST', '/api/users', { name: 'dup', email: 'A@test.local', role: 'client', password: 'Password2026' })).status, 400);
  await analyst('POST', '/api/auth/login', { email: 'analyst@test.local', password: 'Password2026' });
  await clientA('POST', '/api/auth/login', { email: 'a@test.local', password: 'Password2026' });
  await clientB('POST', '/api/auth/login', { email: 'b@test.local', password: 'Password2026' });
  assert.equal((await clientA('GET', '/api/users')).status, 403);
});

test('config: admin publishes, everyone reads, client cannot publish', async () => {
  const cfg = { identity: { brandAr: 'نايوش', user: 'د. عدنان' }, kpis: [{ label: 'x', value: '1' }] };
  assert.equal((await admin('PUT', '/api/config', { cfg })).status, 200);
  const r = await clientA('GET', '/api/config');
  assert.deepEqual(r.body.cfg, cfg);
  assert.equal((await clientA('PUT', '/api/config', { cfg: {} })).status, 403);
  const v = await admin('GET', '/api/config/versions');
  assert.equal(v.body.versions.length, 1);
  const pub = await anon('GET', '/api/public/identity');
  assert.equal(pub.body.brandAr, 'نايوش');
});

test('state: saved per user', async () => {
  await clientA('PUT', '/api/state', { state: { route: 'risks', decided: true } });
  assert.equal((await clientA('GET', '/api/state')).body.state.route, 'risks');
  assert.equal((await clientB('GET', '/api/state')).body.state, null);
});

let reqId, fileId, videoId;
test('uploads: type and size limits, then a request with attachments', async () => {
  const up = (who, name, kind, buf) => who('POST', '/api/uploads', buf, { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), 'X-Upload-Kind': kind });
  assert.equal((await up(clientA, 'evil.html', 'file', Buffer.from('<script>'))).status, 400);
  assert.equal((await up(clientA, 'big.csv', 'file', Buffer.alloc(1.5 * 1024 * 1024, 65))).status, 413);
  const f = await up(clientA, 'بيانات الفرع.xlsx', 'file', Buffer.from('PK fake excel'));
  assert.equal(f.status, 201); fileId = f.body.id;
  const v = await up(clientA, 'جولة.mp4', 'video', Buffer.alloc(4096, 1));
  assert.equal(v.status, 201); videoId = v.body.id;
  const other = await up(clientB, 'b.csv', 'file', Buffer.from('a,b'));

  const payload = { name: 'عميل أ', email: 'a@test.local', domain: 'D05', types: ['diag'], title: 'انخفاض أداء الفرع', question: 'لماذا؟', consent: true };
  const invalid = await clientA('POST', '/api/requests', { payload: { ...payload, title: '' }, summary: {} });
  assert.equal(invalid.status, 400); assert.ok(invalid.body.errors.title);
  assert.equal((await clientA('POST', '/api/requests', { payload, summary: { suff: 60 }, uploads: [other.body.id] })).status, 400, 'cannot attach someone else\'s upload');
  const r = await clientA('POST', '/api/requests', { payload, summary: { suff: 85, typesLabel: 'تحليل تشخيصي' }, uploads: [fileId, videoId] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.request.ref, /^DAR-\d{4}-001$/);
  assert.equal(r.body.request.status, 'ready');
  assert.equal(r.body.request.files, 1); assert.equal(r.body.request.videos, 1);
  reqId = r.body.request.id;
  assert.equal((await clientA('POST', '/api/requests', { payload, summary: {}, uploads: [fileId] })).status, 400, 'upload reuse blocked');
});

test('requests: scoping, files, status changes', async () => {
  assert.equal((await clientA('GET', '/api/requests')).body.requests.length, 1);
  assert.equal((await clientB('GET', '/api/requests')).body.requests.length, 0);
  assert.equal((await analyst('GET', '/api/requests')).body.requests.length, 1);
  assert.equal((await clientB('GET', `/api/requests/${reqId}`)).status, 404);
  const d = await analyst('GET', `/api/requests/${reqId}`);
  assert.equal(d.body.request.files.length, 2);
  assert.equal(d.body.request.payload.question, 'لماذا؟');
  assert.equal((await clientB('GET', `/api/files/${fileId}`)).status, 404);
  const dl = await analyst('GET', `/api/files/${fileId}`);
  assert.equal(dl.status, 200); assert.match(dl.headers.get('content-disposition'), /attachment/);
  const part = await fetch(`${base}/api/files/${videoId}?inline=1`, { headers: { Cookie: '', Range: 'bytes=0-99' } });
  assert.equal(part.status, 401);
  assert.equal((await clientA('PATCH', `/api/requests/${reqId}`, { status: 'done' })).status, 403);
  assert.equal((await analyst('PATCH', `/api/requests/${reqId}`, { status: 'analyzing', note: 'بدأ التحليل' })).status, 200);
  const after = await clientA('GET', `/api/requests/${reqId}`);
  assert.equal(after.body.request.statusLabel, 'قيد التحليل');
  assert.equal(after.body.request.events.length, 2);
});

test('decisions: require decision authority', async () => {
  assert.equal((await clientA('POST', '/api/decisions', { rationale: 'مبرر كافٍ', choiceLabel: 'اعتماد' })).status, 403);
  const r = await admin('POST', '/api/decisions', { consultation: 'CNS-001', choice: 'approve', choiceLabel: 'اعتماد', solution: 'إعادة توزيع الموارد', rationale: 'الأدلة كافية' });
  assert.equal(r.status, 201); assert.match(r.body.ref, /^DEC-\d{4}-001$/);
});

test('audit: client events attributed to the signed-in user; chain verifies; rows immutable', async () => {
  await clientA('POST', '/api/audit', { who: 'شخص آخر', what: 'طرح سؤالًا', kind: 'user' });
  const own = await clientA('GET', '/api/audit');
  assert.equal(own.body.scope, 'own');
  assert.equal(own.body.entries.find(e => e.detail === 'طرح سؤالًا').actor, 'عميل أ');
  assert.equal((await clientA('GET', '/api/audit/verify')).status, 403);
  const v = await admin('GET', '/api/audit/verify');
  assert.equal(v.body.ok, true); assert.ok(v.body.count > 10);
  assert.throws(() => db.run('UPDATE audit_log SET detail = ? WHERE id = 1', 'x'), /append-only/);
  assert.throws(() => db.run('DELETE FROM audit_log WHERE id = 1'), /append-only/);
});

test('admin safety: cannot deactivate self or the last admin; deactivation ends sessions', async () => {
  const me = (await admin('GET', '/api/auth/me')).body.user;
  assert.equal((await admin('PATCH', `/api/users/${me.id}`, { active: false })).status, 400);
  assert.equal((await admin('PATCH', `/api/users/${me.id}`, { role: 'client' })).status, 400);
  const users = (await admin('GET', '/api/users')).body.users;
  const b = users.find(u => u.email === 'b@test.local');
  assert.equal((await admin('PATCH', `/api/users/${b.id}`, { active: false })).status, 200);
  assert.equal((await clientB('GET', '/api/auth/me')).status, 401);
});

test('contact messages: visitors send, validation, honeypot, staff manage, others blocked', async () => {
  const v = client();
  let r = await v('POST', '/api/public/messages', { kind: 'complaint', name: 'س', body: 'قصير' });
  assert.equal(r.status, 400); assert.ok(r.body.errors.name && r.body.errors.email && r.body.errors.body);
  r = await v('POST', '/api/public/messages', { kind: 'suggestion', name: 'زائر', email: 'v@example.com', body: 'أقترح إضافة تقرير شهري تلقائي.' });
  assert.equal(r.status, 201); assert.match(r.body.ref, /^MSG-\d{4}-001$/);
  r = await v('POST', '/api/public/messages', { kind: 'inquiry', name: 'bot', email: 'b@x.co', body: 'spam spam spam spam', website: 'http://spam' });
  assert.equal(r.status, 201); assert.equal(r.body.ref, 'MSG-0');
  assert.equal((await v('GET', '/api/messages')).status, 401);
  const list = await admin('GET', '/api/messages');
  assert.equal(list.status, 200); assert.equal(list.body.scope, 'all'); assert.equal(list.body.messages.length, 1);
  const id = list.body.messages[0].id;
  r = await admin('PATCH', '/api/messages/' + id, { status: 'closed', note: 'شكرًا، أُضيف للخطة' });
  assert.equal(r.status, 200); assert.equal(r.body.message.status, 'closed');
  for (let i = 0; i < 8; i++) await v('POST', '/api/public/messages', { kind: 'inquiry', name: 'زائر', email: 'v@example.com', body: 'رسالة اختبار رقم ' + i });
  r = await v('POST', '/api/public/messages', { kind: 'inquiry', name: 'زائر', email: 'v@example.com', body: 'رسالة بعد تجاوز الحد' });
  assert.equal(r.status, 429);
});

test('sign-up: real name, unique email and phone, both codes verified, welcome points, costs and sealed report', async () => {
  const v = client();
  let r = await v('POST', '/api/public/register', { name: 'سعد', email: 'bad', phone: '12', password: 'short', accept: false });
  assert.equal(r.status, 400); assert.ok(r.body.errors.name && r.body.errors.email && r.body.errors.phone && r.body.errors.password && r.body.errors.accept);
  r = await v('POST', '/api/public/register', { name: 'سعد الخطيب', email: 'saad@example.com', phone: '+962 79 555 1234', password: 'SaadPass2026', accept: true });
  assert.equal(r.status, 201); assert.equal(r.body.phone, '+962795551234'); assert.match(r.body.demo.email, /^\d{6}$/);
  const { id, demo } = r.body;
  r = await v('POST', '/api/public/register/verify', { id, emailCode: demo.email, smsCode: '000000' });
  assert.equal(r.status, 400); assert.ok(r.body.errors.smsCode && !r.body.errors.emailCode);
  r = await v('POST', '/api/public/register/resend', { id }); assert.equal(r.status, 429);
  r = await v('POST', '/api/public/register/verify', { id, emailCode: demo.email, smsCode: demo.sms });
  assert.equal(r.status, 201); assert.equal(r.body.user.role, 'client'); assert.equal(r.body.welcomePoints, 300);
  assert.equal((await v('GET', '/api/auth/me')).status, 200);
  r = await v('GET', '/api/wallet'); assert.equal(r.body.balance, 300); assert.equal(r.body.requestCost, 50);
  // the same email or phone cannot open a second account
  r = await anon('POST', '/api/public/register', { name: 'شخص آخر', email: 'SAAD@example.com', phone: '+962795551234', password: 'OtherPass2026', accept: true });
  assert.equal(r.status, 400); assert.ok(r.body.errors.email && r.body.errors.phone);
  // a request costs points
  const payload = { name: 'سعد الخطيب', email: 'saad@example.com', domain: 'D03', types: ['desc'], title: 'تحليل المشاريع', question: 'هل نسير حسب الخطة؟', consent: true, axis: 'pmo', axisLabel: 'مكتب إدارة المشاريع' };
  r = await v('POST', '/api/requests', { payload, summary: { suff: 50 }, uploads: [] });
  assert.equal(r.status, 201); assert.equal(r.body.request.cost, 50); assert.equal(r.body.request.axisLabel, 'مكتب إدارة المشاريع');
  const rid = r.body.request.id;
  assert.equal((await v('GET', '/api/wallet')).body.balance, 250);
  // demo top-up
  r = await v('POST', '/api/wallet/topup', { pack: 'p100' }); assert.equal(r.status, 200); assert.equal(r.body.balance, 350);
  // sealed report: once, verifiable, immutable
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(400, 65)]);
  r = await v('POST', `/api/requests/${rid}/report`, pdf, { 'Content-Type': 'application/pdf', 'X-Report-Code': 'bad' }); assert.equal(r.status, 400);
  r = await v('POST', `/api/requests/${rid}/report`, pdf, { 'Content-Type': 'application/pdf', 'X-Report-Code': 'ABCDE-23456' });
  assert.equal(r.status, 201); const sha = require('node:crypto').createHash('sha256').update(pdf).digest('hex'); assert.equal(r.body.sha256, sha);
  r = await v('POST', `/api/requests/${rid}/report`, pdf, { 'Content-Type': 'application/pdf', 'X-Report-Code': 'ABCDE-23457' }); assert.equal(r.status, 409);
  r = await v('GET', `/api/requests/${rid}/report`); assert.equal(r.status, 200);
  r = await anon('GET', '/api/public/reports/ABCDE-23456'); assert.equal(r.status, 200); assert.equal(r.body.sha256, sha);
  assert.equal((await anon('GET', '/api/public/reports/ZZZZZ-ZZZZZ')).status, 404);
  assert.ok([401, 404].includes((await clientB('GET', `/api/requests/${rid}/report`)).status));
  assert.equal((await analyst('GET', `/api/requests/${rid}/report`)).status, 200);
  assert.throws(() => db.run('UPDATE reports SET sha256 = ? WHERE code = ?', 'x', 'ABCDE-23456'), /immutable/);
  // rejection refunds once
  await admin('PATCH', '/api/requests/' + rid, { status: 'rejected' });
  await admin('PATCH', '/api/requests/' + rid, { status: 'review' });
  await admin('PATCH', '/api/requests/' + rid, { status: 'rejected' });
  assert.equal((await v('GET', '/api/wallet')).body.balance, 400);
  // not enough points
  for (let i = 0; i < 8; i++) await v('POST', '/api/requests', { payload, summary: { suff: 50 }, uploads: [] });
  r = await v('POST', '/api/requests', { payload, summary: { suff: 50 }, uploads: [] }); assert.equal(r.status, 402);
});

test('تغذية البيانات: admin trains answers, users ask, unmatched questions are kept', async () => {
  let r = await admin('GET', '/api/qa'); assert.equal(r.status, 200); assert.ok(r.body.entries.length >= 8);
  assert.equal((await analyst('GET', '/api/qa')).status, 403);
  r = await analyst('POST', '/api/qa/ask', { q: 'بدي اشحن رصيدي' }); assert.equal(r.status, 200); assert.equal(r.body.found, true); assert.match(r.body.answer, /اشحن رصيدك/);
  r = await analyst('POST', '/api/qa/ask', { q: 'هل عندكم فرع في عمان؟' }); assert.equal(r.body.found, false);
  r = await admin('GET', '/api/qa'); const u = r.body.unanswered.find(x => x.question.includes('فرع')); assert.ok(u);
  r = await admin('POST', '/api/qa', { question: 'هل عندكم فرع في عمان؟', variants: ['وين مكانكم'], answer: 'مقرنا في عمّان.', category: 'عام' }, { 'X-From-Unanswered': String(u.id) });
  assert.equal(r.status, 201);
  r = await admin('GET', '/api/qa'); assert.ok(!r.body.unanswered.some(x => x.id === u.id));
  r = await analyst('POST', '/api/qa/ask', { q: 'وين مكانكم؟' }); assert.equal(r.body.found, true); assert.equal(r.body.answer, 'مقرنا في عمّان.');
  assert.equal((await analyst('POST', '/api/qa', { question: 'x x x', answer: 'y y y' })).status, 403);
  assert.equal((await anon('POST', '/api/qa/ask', { q: 'سؤال' })).status, 401);
});

test('password change and login throttling', async () => {
  assert.equal((await clientA('POST', '/api/auth/password', { current: 'nope', next: 'NewPassword2026' })).status, 400);
  assert.equal((await clientA('POST', '/api/auth/password', { current: 'Password2026', next: 'short' })).status, 400);
  assert.equal((await clientA('POST', '/api/auth/password', { current: 'Password2026', next: 'NewPassword2026' })).status, 200);
  const t = client();
  let last;
  for (let i = 0; i < 9; i++) last = await t('POST', '/api/auth/login', { email: 'a@test.local', password: 'bad-guess-' + i });
  assert.equal(last.status, 429);
});
