const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createRequestHandler, signSession } = require('../app');
const { createIdentityHandler } = require('../../../cloudfunctions/xg-identity/handler');
const { createAssessmentRepository } = require('./repository');
const { createIdentityRepository } = require('./identity-repository');
const { createConsentRepository } = require('./consent');
const { createEventLifecycle } = require('./event-lifecycle');
const { memoryAssessmentStore } = require('./test-support');
const { COLLECTIONS: C, SCALES: S } = require('./model');
const { AUDIENCE, verifyAssertion } = require('./authorization');

const secret = 'test-session-secret-with-enough-entropy';
const bridge = { secret: 'test-identity-bridge-secret-32-bytes-minimum', appId: 'wx-test-app', audience: 'xpg-api:test' };
async function assertion(openid = 'openid-a', options = {}) {
  const wx = { SOURCE: 'wx_client', APPID: bridge.appId, OPENID: openid };
  return (await createIdentityHandler({ getWXContext: () => wx,
    parseContext: (ctx) => ctx, ...bridge, ...options })({}, {
    environment: { WX_APPID: wx.APPID, WX_OPENID: wx.OPENID }
  })).assertion;
}
function token(role, subject, extra = {}) {
  return signSession({ role, subject, aud: AUDIENCE, demo: false,
    auth_method: { admin: 'admin-password', counselor: 'counselor-edit', visitor: 'wechat-cloud' }[role],
    exp: Date.now() + 60000, ...extra }, secret);
}
async function fixture(t) {
  const db = memoryAssessmentStore();
  const counselors = [
    { id: 'ca', edit_token: 'edit-a', is_active: true, review_status: 'approved' },
    { id: 'cb', edit_token: 'edit-b', is_active: true, review_status: 'approved' },
    { id: 'missing-edit-code', is_active: true, review_status: 'approved' }
  ];
  const store = {
    assessment: createAssessmentRepository(db), identity: createIdentityRepository(db),
    consent: createConsentRepository(db),
    async findById(table, id) { return counselors.find((row) => row.id === id) || null; },
    async list(table) { return table === 'counselors' ? counselors : table === 'assessments' ? [...db.snapshot().assessments.values()] : []; },
    async insert() { throw new Error('Unexpected legacy write'); },
    async update() { throw new Error('Unexpected legacy write'); },
    async remove() { throw new Error('Unexpected legacy write'); }
  };
  store.lifecycle = createEventLifecycle(db, store.consent);
  for (const scope of ['assessment', 'followup']) {
    await store.consent.publishPolicy({ scope, version: 'test-v1', title: '仅供自动化测试', content: '测试文案，不可用于正式签署。',
      published_by: 'test', expected_revision: 0 });
  }
  const server = http.createServer(createRequestHandler({ store, sessionSecret: secret, adminPassword: 'admin-pass', identityBridge: bridge }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, method = 'GET', data, bearer) {
    if (method === 'POST' && ['/v1/xg/events', '/v1/xg/events/abandon'].includes(path)) data = { request_id: require('node:crypto').randomUUID(), ...data };
    const res = await fetch(base + path, { method,
      headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: res.status, data: await res.json() };
  }
  async function login(openid) {
    const result = await request('/auth/visitor', 'POST', { assertion: await assertion(openid) });
    assert.equal(result.status, 200);
    return result.data;
  }
  async function cycle(visitor, counselor = 'ca') {
    const intake = await request('/v1/xg/intakes', 'POST', { answers: { concerns: 'test' } }, visitor.token);
    assert.equal(intake.status, 201);
    const submitted = await request('/v1/xg/match-requests', 'POST', { assessment_id: intake.data.assessment_id, counselor_id: counselor }, visitor.token);
    assert.equal(submitted.status, 201);
    const id = submitted.data.request_id;
    assert.equal((await request(`/v1/xg/match-requests/${id}/approve`, 'POST', {}, token('counselor', counselor))).status, 200);
    const created = await request('/v1/xg/matches', 'POST', { request_id: id }, token('counselor', counselor));
    assert.equal(created.status, 200);
    for (const scope of ['assessment', 'followup']) {
      const current = await store.consent.getStatus(visitor.visitor.id, scope);
      if (!current.agreed) {
        const result = await request('/v1/xg/me/consent', 'POST', { scope, version: current.required_version,
          document_hash: current.required_document.content_hash, agreed: true, channel: 'miniprogram',
          client_event_id: randomUUID(), expected_revision: current.revision }, visitor.token);
        assert.equal(result.status, 201);
      }
    }
    return { ...created.data, request_id: id, assessment_id: intake.data.assessment_id };
  }
  return { db, store, request, login, cycle };
}

test('native assertion ignores event identity and requires current invocation identity', async () => {
  const wx = { SOURCE: 'wx_client', APPID: bridge.appId, OPENID: 'real-openid' };
  const main = createIdentityHandler({ ...bridge, getWXContext: () => wx, parseContext: (ctx) => ctx });
  const result = await main({ OPENID: 'forged', APPID: 'wrong' }, { environment: { WX_APPID: wx.APPID, WX_OPENID: wx.OPENID } });
  assert.equal(verifyAssertion(result.assertion, bridge).openid, 'real-openid');
  await assert.rejects(main({}, { environment: {} }), /Verified Mini Program/);
  await assert.rejects(main({}, { environment: { WX_OPENID: 'previous-user', WX_APPID: wx.APPID } }), /Verified Mini Program/);
  assert.equal(Object.hasOwn(result, 'openid'), false);
});

test('assertion signature, audience, app and finite short lifetime are enforced', async () => {
  const valid = await assertion();
  assert.equal(verifyAssertion(valid, bridge).appid, bridge.appId);
  for (const [candidate, settings] of [
    [valid + 'x', bridge], [valid, { ...bridge, appId: 'other' }],
    [valid, { ...bridge, audience: 'other' }], ['malformed', bridge]
  ]) assert.throws(() => verifyAssertion(candidate, settings), { code: 'XG_UNAUTHORIZED' });
  assert.throws(() => verifyAssertion(valid, bridge, Date.now() + 61000), { code: 'XG_UNAUTHORIZED' });
  assert.throws(() => verifyAssertion(valid, {}), { code: 'XG_AUTH_NOT_CONFIGURED' });
});

test('identity exchange is single-use, stable per user, distinct across users and does not expose openid', async (t) => {
  const { request, login } = await fixture(t);
  const proof = await assertion();
  const results = await Promise.all([1, 2].map(() => request('/auth/visitor', 'POST', { assertion: proof })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
  const a = results.find((r) => r.status === 200).data;
  assert.equal((await login('openid-a')).visitor.id, a.visitor.id);
  assert.notEqual((await login('openid-b')).visitor.id, a.visitor.id);
  assert.equal(JSON.stringify(a).includes('openid-a'), false);
  assert.equal((await request('/auth/visitor', 'POST', { assertion: await assertion(), openid: 'fake', role: 'admin' })).status, 400);
});

test('expired, malformed, wrong audience and demo sessions cannot enter xg', async (t) => {
  const { request } = await fixture(t);
  for (const bearer of [undefined, 'broken', token('admin', 'admin', { exp: 0 }), token('admin', 'admin', { exp: 'Infinity' }), token('admin', 'admin', { aud: 'other' })]) {
    assert.equal((await request('/v1/xg/me', 'GET', undefined, bearer)).status, 401);
  }
  assert.equal((await request('/v1/xg/me', 'GET', undefined, token('visitor', 'demo-visitor', { demo: true }))).status, 403);
  assert.equal((await request('/v1/xg/me', 'GET', undefined, token('visitor', 'fake-visitor'))).status, 403);
});

test('empty counselor credential cannot authenticate a record with a missing edit token', async (t) => {
  const { request } = await fixture(t);
  for (const body of [{}, { credential: '' }]) assert.equal((await request('/auth/counselor', 'POST', body)).status, 401);
  const login = await request('/auth/counselor', 'POST', { credential: 'edit-a' });
  assert.equal(login.status, 200);
  assert.equal((await request('/v1/xg/me', 'GET', undefined, login.data.token)).status, 200);
});

test('trusted intake ownership and counselor approval are required to create a cycle', async (t) => {
  const { request, login } = await fixture(t);
  const a = await login('a'); const b = await login('b');
  const intake = await request('/v1/xg/intakes', 'POST', { answers: {} }, a.token);
  assert.equal(intake.status, 201);
  const input = { assessment_id: intake.data.assessment_id, counselor_id: 'ca' };
  assert.equal((await request('/v1/xg/match-requests', 'POST', input, b.token)).status, 403);
  assert.equal((await request('/v1/xg/match-requests', 'POST', { ...input, assessment_id: 'legacy-forged-approved' }, a.token)).status, 403);
  const pending = await request('/v1/xg/match-requests', 'POST', input, a.token);
  const id = pending.data.request_id;
  assert.equal((await request('/v1/xg/matches', 'POST', { request_id: id }, token('counselor', 'ca'))).status, 409);
  assert.equal((await request(`/v1/xg/match-requests/${id}/approve`, 'POST', {}, a.token)).status, 403);
  assert.equal((await request(`/v1/xg/match-requests/${id}/approve`, 'POST', {}, token('counselor', 'cb'))).status, 403);
  assert.equal((await request(`/v1/xg/match-requests/${id}/approve`, 'POST', {}, token('counselor', 'ca'))).status, 200);
  assert.equal((await request('/v1/xg/matches', 'POST', { request_id: id, visitor_id: b.visitor.id }, token('counselor', 'ca'))).status, 400);
  const first = await request('/v1/xg/matches', 'POST', { request_id: id }, token('counselor', 'ca'));
  const second = await request('/v1/xg/matches', 'POST', { request_id: id }, token('counselor', 'ca'));
  assert.equal(first.data.visitor_id, a.visitor.id);
  assert.deepEqual(second.data, first.data);
});

test('match access and case switches use the immutable cycle counselor', async (t) => {
  const { request, login, cycle } = await fixture(t);
  const a = await login('a'); const b = await login('b'); const match = await cycle(a);
  for (const bearer of [b.token, token('counselor', 'cb')]) {
    assert.equal((await request(`/v1/xg/matches/${match.match_id}`, 'GET', undefined, bearer)).status, 403);
    assert.equal((await request('/v1/xg/case-switch', 'POST', { match_id: match.match_id, enable_reminder: true }, bearer)).status, 403);
  }
  assert.equal((await request('/v1/xg/case-switch', 'POST', { match_id: match.match_id, enable_reminder: true }, a.token)).status, 403);
  assert.equal((await request('/v1/xg/case-switch', 'POST', { match_id: match.match_id, enable_reminder: true, counselor_id: 'ca' }, token('counselor', 'cb'))).status, 400);
  const changed = await request('/v1/xg/case-switch', 'POST', { match_id: match.match_id, enable_reminder: true }, token('counselor', 'ca'));
  assert.equal(changed.status, 200);
  assert.equal(changed.data.enable_reminder, true);
});

test('visitors cannot fill M3; counselors/admin cannot fill visitor cards or mutate another actor event', async (t) => {
  const { request, login, cycle, store, db } = await fixture(t);
  const a = await login('a'); const b = await login('b'); const match = await cycle(a);
  const card = { match_id: match.match_id, scale_code: S.state, session_no: 2, client_event_id: 'start-auth-test' };
  for (const [body, bearer] of [[card, token('counselor', 'ca')], [card, token('admin', 'admin')], [card, b.token], [{ ...card, scale_code: S.pro }, a.token]]) {
    assert.equal((await request('/v1/xg/events/start', 'POST', body, bearer)).status, 403);
  }
  assert.equal((await request('/v1/xg/events/start', 'POST', card, a.token)).status, 201);
  assert.equal((await request('/v1/xg/events/start', 'POST', { ...card, scale_code: S.pro }, token('counselor', 'ca'))).status, 201);
  assert.equal((await request('/v1/xg/events', 'POST', { ...card, actor_id: a.visitor.id, scores: { total: 70 } }, a.token)).status, 400);
  const id = randomUUID();
  await store.assessment.insertEvent({ ...card, event_id: id, scale_code: S.pro, status: 'started' });
  assert.equal((await request('/v1/xg/events/abandon', 'POST', { match_id: match.match_id, event_id: id }, a.token)).status, 403);
  assert.equal(db.snapshot()[C.events].size, 3);
});

test('event id cannot be moved between cycles even when both belong to the same visitor', async (t) => {
  const { request, login, cycle, store } = await fixture(t);
  const a = await login('a'); const first = await cycle(a, 'ca'); const second = await cycle(a, 'cb');
  await store.assessment.insertEvent({ match_id: first.match_id, event_id: 'event-a', scale_code: S.state, session_no: 2, status: 'started' });
  assert.equal((await request('/v1/xg/events/abandon', 'POST', { match_id: second.match_id, event_id: 'event-a' }, a.token)).status, 403);
});

test('xg intake cannot be read, reassigned or deleted via legacy generic REST', async (t) => {
  const { request, login } = await fixture(t);
  const visitor = await login('a');
  const intake = await request('/v1/xg/intakes', 'POST', { answers: { note: 'private' } }, visitor.token);
  const path = `/rest/v1/assessments?id=eq.${intake.data.assessment_id}`;
  assert.deepEqual((await request(path, 'GET', undefined, token('admin', 'admin'))).data, []);
  assert.equal((await request(path, 'PATCH', { xg_managed: false, visitor_user_id: 'fake' }, token('admin', 'admin'))).status, 403);
  assert.equal((await request(path, 'DELETE', undefined, token('admin', 'admin'))).status, 403);
});

test('a valid token does not bypass a disabled visitor or an inactive counselor', async (t) => {
  const { request, login, db, store } = await fixture(t);
  const visitor = await login('a');
  await db.transaction(async (tx) => {
    const row = await tx.get(C.visitors, visitor.visitor.id);
    await tx.put(C.visitors, visitor.visitor.id, { ...row, disabled: true });
  });
  assert.equal((await request('/v1/xg/me', 'GET', undefined, visitor.token)).status, 403);
  assert.equal((await request('/auth/visitor', 'POST', { assertion: await assertion('a') })).status, 403);
  const counselor = await store.findById('counselors', 'ca');
  counselor.is_active = false;
  assert.equal((await request('/v1/xg/me', 'GET', undefined, token('counselor', 'ca'))).status, 403);
});
