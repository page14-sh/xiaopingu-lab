const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createRequestHandler, signSession } = require('../app');
const { createAssessmentRepository } = require('./repository');
const { createIdentityRepository } = require('./identity-repository');
const { createConsentRepository, scopeForCard } = require('./consent');
const { createEventLifecycle } = require('./event-lifecycle');
const { createFollowupRepository } = require('./followups');
const { memoryAssessmentStore } = require('./test-support');
const { COLLECTIONS: C, SCALES: S, documentKey } = require('./model');

const principal = (id = 'v1', role = 'visitor') => ({ subject: id, role, aud: 'xg-assessment', demo: false,
  auth_method: { visitor: 'wechat-cloud', counselor: 'counselor-edit', admin: 'admin-password' }[role], exp: Date.now() + 3600000 });
async function fixture({ publish = true } = {}) {
  const db = memoryAssessmentStore();
  let clock = Date.parse('2026-10-25T10:00:00Z');
  const consent = createConsentRepository(db, { now: () => new Date(clock++).toISOString() });
  await db.transaction(async (tx) => {
    for (const visitor_id of ['v1', 'v2']) await tx.put(C.visitors, visitor_id, { visitor_id, provider: 'wechat-cloud' });
  });
  const policy = (scope = 'assessment', version = 'v1', expected_revision = 0, content = 'TEST ONLY: not approved production consent.') =>
    consent.publishPolicy({ scope, version, expected_revision, title: '仅用于自动化测试', content, published_by: 'test-operator' });
  if (publish) for (const scope of ['assessment', 'followup']) await policy(scope);
  async function decision(scope = 'assessment', agreed = true, who = principal(), extra = {}) {
    const state = await consent.getStatus(who.subject, scope);
    return { scope, agreed, version: agreed ? state.required_version : state.version,
      document_hash: agreed ? state.required_document.content_hash : state.document_hash,
      channel: 'miniprogram', client_event_id: randomUUID(), expected_revision: state.revision, ...extra };
  }
  const decide = async (scope, agreed, who = principal(), extra) => consent.decide(who, await decision(scope, agreed, who, extra));
  return { db, consent, policy, decision, decide };
}

async function apiFixture(t, options) {
  const f = await fixture(options);
  const secret = 'consent-test-session-secret-with-enough-entropy';
  const repository = createAssessmentRepository(f.db);
  await repository.createMatch({ match_id: 'case', visitor_id: 'v1', counselor_id: 'c1', assessment_id: 'intake' });
  const store = { consent: f.consent, assessment: repository, identity: createIdentityRepository(f.db),
    lifecycle: createEventLifecycle(f.db, f.consent),
    followups: createFollowupRepository(f.db),
    async findById(_table, id) { return id === 'c1' ? { id, is_active: true, review_status: 'approved' } : null; },
    async list() { return []; } };
  const server = http.createServer(createRequestHandler({ store, sessionSecret: secret }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  async function request(path, method = 'GET', body, who = principal()) {
    if (method === 'POST' && ['/v1/xg/events', '/v1/xg/events/abandon'].includes(path)) body = { request_id: require('node:crypto').randomUUID(), ...body };
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${signSession(who, secret)}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  return { ...f, request, repository };
}

test('no production policy is seeded; reads show unconfigured and writes fail closed', async () => {
  const { db, consent } = await fixture({ publish: false });
  const before = db.snapshot();
  const status = await consent.getStatus('v1', 'assessment');
  assert.equal(status.configured, false);
  assert.equal(status.required_version, null);
  assert.equal(status.required_document, null);
  assert.equal(status.agreed, false);
  await assert.rejects(consent.decide(principal(), { scope: 'assessment', version: 'v1', document_hash: 'a'.repeat(64),
    agreed: true, channel: 'web', client_event_id: 'new', expected_revision: 0 }), { code: 'XG_CONSENT_NOT_CONFIGURED' });
  assert.deepEqual(db.snapshot(), before);
});

test('signing stores exact immutable version/hash with server time and history', async () => {
  const { consent, decision, db } = await fixture();
  const input = await decision();
  const result = await consent.decide(principal(), input);
  assert.equal(result.agreed, true);
  assert.equal(result.version, 'v1');
  assert.equal(result.document_hash, input.document_hash);
  assert.equal(result.revision, 1);
  assert.match(result.agreed_at, /^2026-10-25T/);
  const history = await consent.history('v1', 'assessment');
  assert.equal(history.length, 1);
  assert.equal(history[0].action, 'agreed');
  assert.equal(history[0].document_hash, input.document_hash);
  assert.equal(db.snapshot()[C.consentDocuments].size, 2);
});

test('version upgrade invalidates old consent and same-version text replacement/rollback is rejected', async () => {
  const { consent, policy, decide, decision, db } = await fixture();
  await decide();
  const stale = await decision('assessment', true);
  const original = await db.get(C.consentDocuments, documentKey('assessment', 'v1'));
  await assert.rejects(policy('assessment', 'v1', 1, 'changed text'), { code: 'XG_CONSENT_VERSION_IMMUTABLE' });
  await policy('assessment', 'v2', 1, 'TEST ONLY second version');
  assert.equal((await consent.getStatus('v1', 'assessment')).agreed, false);
  await assert.rejects(consent.decide(principal(), stale), { code: 'XG_CONSENT_VERSION_MISMATCH' });
  await assert.rejects(policy('assessment', 'v1', 2), { code: 'XG_CONSENT_VERSION_REUSED' });
  assert.deepEqual(await db.get(C.consentDocuments, documentKey('assessment', 'v1')), original);
  await decide();
  assert.equal((await consent.getStatus('v1', 'assessment')).version, 'v2');
  assert.equal((await consent.history('v1', 'assessment')).length, 2);
});

test('grant, revoke and re-grant append history without rewriting the first signature', async () => {
  const { consent, decide } = await fixture();
  await decide();
  const first = (await consent.history('v1', 'assessment'))[0];
  const revoked = await decide('assessment', false);
  assert.equal(revoked.agreed, false);
  assert.ok(revoked.revoked_at > first.occurred_at);
  const again = await decide('assessment', true);
  assert.equal(again.agreed, true);
  assert.equal(again.revoked_at, null);
  assert.ok(again.agreed_at > revoked.revoked_at);
  const history = await consent.history('v1', 'assessment');
  assert.deepEqual(history.map((row) => row.action), ['agreed', 'revoked', 'agreed']);
  assert.deepEqual(history[0], first);
  assert.deepEqual(history.map((row) => row.revision), [1, 2, 3]);
});

test('withdrawal of a previously signed version still works after a policy upgrade or missing policy', async () => {
  const { consent, policy, decide, decision, db } = await fixture();
  await decide();
  const withdrawal = await decision('assessment', false);
  await policy('assessment', 'v2', 1, 'TEST ONLY second');
  await consent.decide(principal(), withdrawal);
  assert.equal((await consent.history('v1', 'assessment')).at(-1).version, 'v1');
  await decide('assessment', true);
  const state = await db.get(C.consentStates, documentKey('v1', 'assessment'));
  const noPolicyStore = { ...db, transaction: (work) => db.transaction((tx) => work({ ...tx,
    get: (collection, id) => collection === C.consentPolicies ? Promise.resolve(null) : tx.get(collection, id) })) };
  const offlineConsent = createConsentRepository(noPolicyStore);
  await offlineConsent.decide(principal(), { scope: 'assessment', version: state.version, document_hash: state.document_hash,
    agreed: false, channel: 'web', client_event_id: 'withdraw-without-policy', expected_revision: state.revision });
  assert.equal((await consent.getStatus('v1', 'assessment')).agreed, false);
});

test('scope consent is independent and revoking assessment does not revoke followup', async () => {
  const { consent, decide } = await fixture();
  await decide('assessment', true);
  assert.equal((await consent.getStatus('v1', 'followup')).agreed, false);
  await decide('followup', true);
  await decide('assessment', false);
  assert.equal((await consent.getStatus('v1', 'followup')).agreed, true);
  assert.deepEqual([S.baseline, S.state, S.feel, S.pro].map(scopeForCard), Array(4).fill('assessment'));
  assert.deepEqual([S.end, S.evaluation, S.follow].map(scopeForCard), Array(3).fill('followup'));
});

test('old grant replay after withdrawal returns current revoked state, never reactivates it', async () => {
  const { consent, decision, decide, db } = await fixture();
  const input = await decision();
  await consent.decide(principal(), input);
  await decide('assessment', false);
  const before = db.snapshot();
  const retry = await consent.decide(principal(), input);
  assert.equal(retry.duplicated, true);
  assert.equal(retry.agreed, false);
  assert.equal(retry.revision, 2);
  assert.deepEqual(db.snapshot(), before);
  await assert.rejects(consent.decide(principal(), { ...input, client_event_id: randomUUID() }), { code: 'XG_CONSENT_CONFLICT' });
  await assert.rejects(consent.decide(principal(), { ...input, agreed: false }), { code: 'XG_IDEMPOTENCY_CONFLICT' });
});

test('simultaneous duplicate requests create one history row; distinct stale requests conflict', async () => {
  const { consent, decision } = await fixture();
  const input = await decision();
  const both = await Promise.all([consent.decide(principal(), input), consent.decide(principal(), input)]);
  assert.deepEqual(both.map((row) => row.duplicated).sort(), [false, true]);
  assert.equal((await consent.history('v1', 'assessment')).length, 1);
  const other = await decision('followup');
  const competing = await Promise.allSettled([consent.decide(principal(), other), consent.decide(principal(), { ...other, client_event_id: randomUUID() })]);
  assert.equal(competing.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(competing.find((row) => row.status === 'rejected').reason.code, 'XG_CONSENT_CONFLICT');
});

test('history and current state commit atomically and a storage failure leaves no partial grant', async () => {
  const { consent, decision, db } = await fixture();
  const input = await decision();
  const before = db.snapshot();
  db.failNextWriteTo(C.consentStates);
  await assert.rejects(consent.decide(principal(), input), /Injected storage failure/);
  assert.deepEqual(db.snapshot(), before);
  assert.equal((await consent.decide(principal(), input)).agreed, true);
});

test('guarded business write uses consent reference and rolls back on callback failure', async () => {
  const { consent, decide, db } = await fixture();
  await decide();
  const before = db.snapshot();
  await assert.rejects(consent.runWithConsent('v1', 'assessment', async (tx) => {
    await tx.put(C.submissions, 'business', { test: true });
    throw new Error('business failure');
  }), /business failure/);
  assert.deepEqual(db.snapshot(), before);
  await consent.runWithConsent('v1', 'assessment', async (tx, reference) => tx.put(C.submissions, 'business', { reference }));
  assert.equal((await db.get(C.submissions, 'business')).reference.version, 'v1');
  assert.equal((await consent.getStatus('v1', 'assessment')).revision, 1);
});

test('withdrawal or policy upgrade prevents the next guarded business callback', async () => {
  const { consent, decide, policy } = await fixture();
  await decide();
  await decide('assessment', false);
  let calls = 0;
  await assert.rejects(consent.runWithConsent('v1', 'assessment', () => { calls++; }), { code: 'XG_CONSENT_REQUIRED' });
  await decide();
  await policy('assessment', 'v2', 1, 'TEST ONLY replacement');
  await assert.rejects(consent.runWithConsent('v1', 'assessment', () => { calls++; }), { code: 'XG_CONSENT_REQUIRED' });
  assert.equal(calls, 0);
});

test('self APIs reject impersonation, admin cannot sign and counselors cannot inspect consent', async (t) => {
  const { request, decision, decide } = await apiFixture(t);
  const input = await decision();
  for (const who of [principal('c1', 'counselor'), principal('admin', 'admin')]) {
    assert.equal((await request('/v1/xg/me/consent', 'GET', undefined, who)).status, 403);
    assert.equal((await request('/v1/xg/me/consent', 'POST', input, who)).status, 403);
  }
  assert.equal((await request('/v1/xg/me/consent?visitor_id=v2')).status, 400);
  assert.equal((await request('/v1/xg/me/consent', 'POST', { ...input, visitor_id: 'v2' })).status, 400);
  assert.equal((await request('/v1/xg/me/consent', 'POST', { ...input, agreed_at: '2000-01-01' })).status, 400);
  await decide();
  const admin = principal('admin', 'admin');
  assert.equal((await request('/v1/xg/admin/consents?visitor_id=v1&scope=assessment', 'GET', undefined, admin)).body.history.length, 1);
  assert.equal((await request('/v1/xg/admin/consents?visitor_id=v1', 'POST', {}, admin)).status, 405);
  assert.equal((await request('/v1/xg/admin/consents?visitor_id=v1', 'GET', undefined, principal('c1', 'counselor'))).status, 403);
});

test('history pagination filters visitor and scope before paging and never exposes request internals', async () => {
  const { consent, decide } = await fixture();
  await decide(); await decide('assessment', false); await decide();
  await decide('followup', true);
  await decide('assessment', true, principal('v2'));
  const page = await consent.history('v1', 'assessment', { limit: 1, offset: 1 });
  assert.equal(page.length, 1);
  assert.equal(page[0].action, 'revoked');
  assert.equal(page[0].revision, 2);
  assert.equal('request' in page[0], false);
  assert.equal('visitor_id' in page[0], false);
});

test('start and submit require current visitor consent and revocation prevents answer writes', async (t) => {
  const { request, decide, db } = await apiFixture(t);
  const card = { match_id: 'case', scale_code: S.state, session_no: 2, client_event_id: 'consent-attempt' };
  assert.equal((await request('/v1/xg/events/start', 'POST', card)).status, 409);
  await decide();
  const started = await request('/v1/xg/events/start', 'POST', card);
  assert.equal(started.status, 201);
  await decide('assessment', false);
  const before = db.snapshot();
  assert.equal((await request('/v1/xg/events', 'POST', { ...card, event_id: started.body.event_id, answers: { s1: 8 } })).body.error.code, 'XG_CONSENT_REQUIRED');
  assert.deepEqual(db.snapshot(), before);
  assert.equal(db.snapshot()[C.events].size, 1);
});

test('M3 checks the visitor’s assessment scope; M4 cards require separate followup consent', async (t) => {
  const { request, decide } = await apiFixture(t);
  const pro = { match_id: 'case', scale_code: S.pro, session_no: 2, client_event_id: 'scope-attempt' };
  assert.equal((await request('/v1/xg/events/start', 'POST', pro, principal('c1', 'counselor'))).status, 409);
  await decide('assessment', true);
  assert.equal((await request('/v1/xg/events/start', 'POST', pro, principal('c1', 'counselor'))).status, 201);
  for (const scale_code of [S.end, S.evaluation]) {
    assert.equal((await request('/v1/xg/events/start', 'POST', { ...pro, scale_code })).status, 409);
  }
  await decide('followup', true);
  await decide('assessment', false);
  assert.equal((await request('/v1/xg/events/start', 'POST', { ...pro, scale_code: S.end })).status, 201);
});

test('withdrawal does not block abandon cleanup or delete existing records', async (t) => {
  const { request, decide, repository, db } = await apiFixture(t);
  await decide();
  await repository.insertEvent({ match_id: 'case', event_id: 'started', scale_code: S.state, session_no: 2, status: 'started' });
  await decide('assessment', false);
  assert.equal((await request('/v1/xg/events/abandon', 'POST', { match_id: 'case', event_id: 'started' })).status, 200);
  assert.equal((await request('/v1/xg/events?match_id=case')).status, 200);
  assert.equal(db.snapshot()[C.events].size, 1);
});

test('prompts return no cards without consent and use followup scope after closure', async (t) => {
  const { request, decide, repository } = await apiFixture(t);
  assert.deepEqual((await request('/v1/xg/prompts/next?match_id=case')).body, { prompts: [] });
  await decide();
  assert.equal((await request('/v1/xg/prompts/next?match_id=case')).body.prompts[0].scale_code, S.baseline);
  await repository.closeMatch('case', 2);
  assert.deepEqual((await request('/v1/xg/prompts/next?match_id=case')).body, { prompts: [] });
  await decide('followup', true);
  assert.deepEqual((await request('/v1/xg/prompts/next?match_id=case')).body.prompts.map((p) => p.scale_code), [S.end, S.evaluation]);
  await decide('followup', false);
  assert.deepEqual((await request('/v1/xg/prompts/next?match_id=case')).body, { prompts: [] });
});

test('invalid consent fields, counterfeit document hash and unsafe history queries are rejected', async (t) => {
  const { request, decision } = await apiFixture(t);
  const input = await decision();
  for (const patch of [{ agreed: 'true' }, { expected_revision: -1 }, { channel: 'paper' }, { client_event_id: '' }, { scope: 'unknown' }]) {
    assert.equal((await request('/v1/xg/me/consent', 'POST', { ...input, ...patch })).status, 400);
  }
  assert.equal((await request('/v1/xg/me/consent', 'POST', { ...input, document_hash: 'a'.repeat(64) })).status, 409);
  assert.equal((await request('/v1/xg/me/consent/history?scope=assessment&scope=followup')).status, 400);
  assert.equal((await request('/v1/xg/me/consent/history?limit=201')).status, 400);
  const status = await request('/v1/xg/me/consent');
  assert.equal(status.headers.get('cache-control'), 'no-store');
});

test('stored document tampering fails closed for reads, guards and grant retries, while withdrawal remains possible', async () => {
  const { consent, decision, db } = await fixture();
  const grant = await decision();
  const signed = await consent.decide(principal(), grant);
  await db.transaction(async (tx) => {
    const id = documentKey('assessment', 'v1');
    const document = await tx.get(C.consentDocuments, id);
    await tx.put(C.consentDocuments, id, { ...document, content: 'Tampered text without a new version/hash' });
  });
  await assert.rejects(consent.getStatus('v1', 'assessment'), { code: 'XG_CONSENT_POLICY_INVALID' });
  await assert.rejects(consent.assertCurrent('v1', 'assessment'), { code: 'XG_CONSENT_POLICY_INVALID' });
  await assert.rejects(consent.decide(principal(), grant), { code: 'XG_CONSENT_POLICY_INVALID' });
  const withdrawn = await consent.decide(principal(), { ...grant, agreed: false, client_event_id: 'withdraw-tampered', expected_revision: signed.revision });
  assert.equal(withdrawn.agreed, false);
});
