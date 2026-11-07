const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { fixture } = require('../../../scripts/fixtures/v2-portal.cjs');
const { createCounselorAccess, normalizePhone, SETUP_AUDIENCE, PROFILE_AUDIENCE } = require('./counselor-access');
const { COLLECTIONS: C } = require('../assessment/model');
const { createRequestHandler, signSession, verifySession } = require('../app');
const admin = { role: 'admin', subject: 'admin', aud: 'xg-assessment', auth_method: 'admin-password', demo: false, exp: Date.now() + 86400000 };
const PHONE = '13800123456', PASSWORD = 'Synthetic-Password-42';
async function setup() {
  const f = await fixture(); let clock = Date.now();
  await f.source.transaction(async tx => {
    const row = await tx.get('counselors', f.cid);
    await tx.put('counselors', f.cid, { ...row, contact_phone: PHONE, login_code: '123321', bio_short: '合成资料' });
  });
  function service() { return createCounselorAccess({ source: f.source,
    directory: async () => [...f.source.snapshot().counselors.values()], now: () => clock }); }
  f.store.portal.access = service();
  return { ...f, access: f.store.portal.access, service, advance: ms => { clock += ms; },
    setupSession: result => ({ role: 'counselor', subject: result.id, aud: SETUP_AUDIENCE, auth_method: 'counselor-phone-initial', demo: false, exp: clock + 600000, account_revision: result.revision }) };
}
async function serve(t) {
  const f = await setup(), secret = 'synthetic-access-test-secret';
  const server = http.createServer(createRequestHandler({ store: f.store, portalEnabled: true, sessionSecret: secret, adminPassword: 'synthetic-admin' }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  async function request(path, body, session, method = body ? 'POST' : 'GET') {
    const token = typeof session === 'string' ? session : session ? signSession(session, secret) : null;
    const r = await fetch('http://127.0.0.1:' + server.address().port + path, { method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json(), headers: r.headers };
  }
  return { ...f, request, secret };
}

test('phone normalization accepts +86 formatting without accepting extensions or partial numbers', () => {
  assert.equal(normalizePhone('+86 138-0012-3456'), PHONE);
  assert.equal(normalizePhone('008613800123456'), PHONE);
  for (const p of [null, '123456', '13800123456转1', '12345678901', '<script>']) assert.equal(normalizePhone(p), null);
});
async function installCustomPassword(f) {
  const initial = await f.access.login(PHONE, PHONE.slice(-6));
  // Model a still-valid setup credential issued by the preceding release.
  await f.source.transaction(async tx => tx.put(C.counselorAccounts, f.cid, {
    ...await tx.get(C.counselorAccounts, f.cid), must_change: true, initial_expires_at: Date.now() + 600000
  }));
  return f.access.setPassword(f.setupSession(initial), PASSWORD);
}
test('default password directly authenticates and does not expire after seven days', async () => {
  const f = await setup(), initial = await f.access.login(PHONE, PHONE.slice(-6));
  assert.equal(initial.must_change, false);
  const row = await f.source.get(C.counselorAccounts, f.cid);
  assert.equal(row.initial_expires_at, undefined); assert.equal(row.password_hash, undefined);
  f.advance(8 * 86400000);
  assert.equal((await f.access.login(PHONE, PHONE.slice(-6))).must_change, false);
});
test('existing custom passwords remain hashed and are never replaced by the default', async () => {
  const f = await setup(); await installCustomPassword(f);
  const row = await f.source.get(C.counselorAccounts, f.cid);
  assert.match(row.password_hash, /^scrypt\$/); assert.ok(!JSON.stringify(row).includes(PASSWORD));
  await assert.rejects(f.access.login(PHONE, PHONE.slice(-6)), { statusCode: 401 });
  assert.equal((await f.access.login(PHONE, PASSWORD)).must_change, false);
});
test('old pending setup accounts, including expired ones, can use the default directly', async () => {
  const f = await setup(); await f.access.login(PHONE, PHONE.slice(-6));
  await f.source.transaction(async tx => tx.put(C.counselorAccounts, f.cid, {
    ...await tx.get(C.counselorAccounts, f.cid), must_change: true, initial_expires_at: 1
  }));
  assert.equal((await f.access.login(PHONE, PHONE.slice(-6))).must_change, false);
  const account = await f.source.get(C.counselorAccounts, f.cid);
  assert.equal(account.must_change, false); assert.equal(account.initial_expires_at, undefined);
});
test('phone failures persist across service instances, lock after five and expire after 15 minutes', async () => {
  const f = await setup();
  for (let i = 0; i < 4; i++) await assert.rejects(f.service().login(PHONE, 'wrong'), { statusCode: 401 });
  await assert.rejects(f.service().login(PHONE, 'wrong'), { statusCode: 429 });
  await assert.rejects(f.service().login(PHONE, PHONE.slice(-6)), { statusCode: 429 });
  f.advance(900001); assert.equal((await f.service().login(PHONE, PHONE.slice(-6))).must_change, false);
});
test('missing or duplicate phone, demo and inactive records never auto-provision an account', async () => {
  const f = await setup();
  await assert.rejects(f.access.login('13999999999', '999999'), { statusCode: 401 });
  const duplicate = randomUUID(); await f.store.portal.createCounselor({ id: duplicate, contact_phone: '+86' + PHONE, review_status: 'approved', is_active: true });
  await assert.rejects(f.access.login(PHONE, PHONE.slice(-6)), { statusCode: 401 });
  assert.equal(await f.source.get(C.counselorAccounts, f.cid), null);
  await f.source.transaction(tx => tx.put('counselors', duplicate, { id: duplicate, contact_phone: '' }));
  for (const patch of [{ is_demo: true }, { is_demo: false, is_active: false }]) {
    await f.source.transaction(async tx => tx.put('counselors', f.cid, { ...await tx.get('counselors', f.cid), ...patch }));
    await assert.rejects(f.access.login(PHONE, PHONE.slice(-6)), { statusCode: 401 });
  }
});
test('admin reset revokes existing phone sessions and restores direct default login', async () => {
  const f = await setup(), login = await f.access.login(PHONE, PHONE.slice(-6));
  const full = { ...admin, role: 'counselor', subject: f.cid, auth_method: 'counselor-phone', account_revision: login.revision };
  await f.access.validatePhone(full);
  const result = await f.access.resetPhone(admin, f.cid); assert.equal(result.must_change_password, false);
  await assert.rejects(f.access.validatePhone(full), { statusCode: 401 });
  assert.equal((await f.access.login(PHONE, PHONE.slice(-6))).must_change, false);
});
test('phone change invalidates phone sessions; administrator must explicitly rebind the account', async () => {
  const f = await setup(), initial = await f.access.login(PHONE, PHONE.slice(-6));
  const changed = await installCustomPassword(f);
  const full = { ...admin, role: 'counselor', subject: f.cid, auth_method: 'counselor-phone', account_revision: changed.revision };
  await f.source.transaction(async tx => tx.put('counselors', f.cid, { ...await tx.get('counselors', f.cid), contact_phone: '13900123456' }));
  await assert.rejects(f.access.validatePhone(full), { statusCode: 401 });
  await assert.rejects(f.access.login('13900123456', '123456'), { statusCode: 401 });
  await f.access.resetPhone(admin, f.cid);
  assert.equal((await f.access.login('13900123456', '123456')).must_change, false);
});
test('invite secret is hashed; replacing, revoking and expiration invalidate links and exchanged sessions', async () => {
  const f = await setup(), issued = await f.access.issueInvite(admin, f.cid);
  assert.ok(!JSON.stringify(await f.source.get(C.counselorInvites, f.cid)).includes(issued.invite.split('.')[1]));
  const grant = await f.access.exchangeInvite(issued.invite);
  const session = { ...admin, role: 'counselor', subject: f.cid, aud: PROFILE_AUDIENCE, auth_method: 'profile-invite', invite_generation: grant.generation };
  await f.access.validateInvite(session);
  const newer = await f.access.issueInvite(admin, f.cid);
  await assert.rejects(f.access.exchangeInvite(issued.invite), { statusCode: 401 });
  await assert.rejects(f.access.validateInvite(session), { statusCode: 401 });
  await f.access.revokeInvite(admin, f.cid); await assert.rejects(f.access.exchangeInvite(newer.invite), { statusCode: 401 });
  const last = await f.access.issueInvite(admin, f.cid); f.advance(8 * 86400000);
  await assert.rejects(f.access.exchangeInvite(last.invite), { statusCode: 401 });
});
test('HTTP default login directly enters workspace without returning setup credentials', async t => {
  const f = await serve(t), first = await f.request('/auth/counselor/phone', { phone: PHONE, password: PHONE.slice(-6) });
  assert.equal(first.status, 200); assert.ok(first.body.token); assert.equal(first.body.setup_token, undefined);
  assert.equal(first.body.must_change_password, false);
  assert.equal(verifySession(first.body.token, f.secret).aud, 'xg-assessment');
  assert.equal((await f.request('/v1/xg/me', null, first.body.token)).status, 200);
  assert.equal((await f.request('/rest/v1/counselors?id=eq.' + f.cid, null, first.body.token)).status, 200);
  const restricted = signSession(f.setupSession({ id: f.cid, revision: 1 }), f.secret);
  assert.equal((await f.request('/v1/xg/me', null, restricted)).status, 403);
  assert.equal((await f.request('/auth/counselor/password', { new_password: PASSWORD }, restricted)).status, 401);
  await f.access.resetPhone(admin, f.cid);
  assert.equal((await f.request('/v1/xg/me', null, first.body.token)).status, 401);
});
test('HTTP share grant reads/writes only its own profile and never reveals long-lived credentials', async t => {
  const f = await serve(t), issued = await f.request('/v1/xg/portal/counselor-access', { action: 'issue', counselor_id: f.cid }, admin);
  assert.equal(issued.status, 200);
  const exchange = await f.request('/auth/counselor/invite', { invite: issued.body.invite });
  assert.equal(exchange.status, 200);
  const token = exchange.body.token;
  const read = await f.request('/v1/xg/portal/shared-profile', null, token);
  assert.equal(read.status, 200); assert.equal(read.body[0].id, f.cid); assert.equal(read.body[0].contact_phone, PHONE);
  assert.equal(read.headers.get('cache-control'), 'no-store');
  for (const key of ['edit_token', 'login_code', 'secret_hash', 'password_hash']) assert.equal(read.body[0][key], undefined);
  const save = await f.request('/v1/xg/portal/shared-profile', { bio_short: '已补齐合成介绍' }, token, 'PATCH');
  assert.equal(save.status, 200); assert.equal((await f.source.get('counselors', f.cid)).bio_short, '已补齐合成介绍');
  for (const path of ['/rest/v1/counselors', '/rest/v1/assessments', '/v1/xg/me', '/v1/xg/portal/cases']) assert.equal((await f.request(path, null, token)).status, 403);
  assert.equal((await f.request('/v1/xg/portal/shared-profile', { review_status: 'approved' }, token, 'PATCH')).status, 403);
  assert.equal((await f.request('/v1/xg/portal/shared-profile', { id: randomUUID() }, token, 'PATCH')).status, 403);
  assert.equal((await f.request('/v1/xg/portal/shared-profile?counselor_id=' + randomUUID(), null, token)).status, 400);
  await f.request('/v1/xg/portal/counselor-access', { action: 'revoke', counselor_id: f.cid }, admin);
  assert.equal((await f.request('/v1/xg/portal/shared-profile', { bio_short: 'revoked' }, token, 'PATCH')).status, 401);
});
test('only admin can issue/reset/revoke and legacy counselor credentials continue to work', async t => {
  const f = await serve(t);
  for (const action of ['issue', 'revoke', 'reset_phone']) {
    const input = { action, counselor_id: f.cid };
    assert.equal((await f.request('/v1/xg/portal/counselor-access', input)).status, 401);
    assert.equal((await f.request('/v1/xg/portal/counselor-access', input, { ...admin, role: 'counselor', subject: f.cid, auth_method: 'counselor-edit' })).status, 403);
  }
  assert.equal((await f.request('/auth/counselor', { credential: 'synthetic-counselor-only' })).status, 200);
  assert.equal((await f.request('/auth/counselor', { credential: '123321' })).status, 200);
});
