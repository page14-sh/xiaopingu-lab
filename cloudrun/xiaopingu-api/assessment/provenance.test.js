const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRequestHandler, signSession } = require('../app');
const { createAssessmentRepository } = require('./repository');
const { createIdentityRepository } = require('./identity-repository');
const { createProvenanceRepository, defaultVersionBundle, contentHash, verifyEventBasis } = require('./provenance');
const { memoryAssessmentStore } = require('./test-support');
const { COLLECTIONS: C, SCALES: S, documentKey } = require('./model');

async function fixture(options) {
  const db = memoryAssessmentStore(options);
  const repo = createAssessmentRepository(db);
  const provenance = createProvenanceRepository(db);
  await repo.createMatch({ match_id: 'a', visitor_id: 'visitor', counselor_id: 'counselor-a', assessment_id: 'intake' });
  await repo.createMatch({ match_id: 'b', visitor_id: 'visitor', counselor_id: 'counselor-b', assessment_id: 'intake' });
  const event = (id, scale = S.state, session = 2, extra = {}) => repo.insertEvent({
    match_id: 'a', event_id: id, scale_code: scale, session_no: session, status: 'started', ...extra
  });
  return { db, repo, provenance, event };
}

test('baseline stores all 13 exact rendered questions, anchors/options, rules and version hashes', async () => {
  const { event } = await fixture();
  const row = await event('baseline', S.baseline, 0);
  assert.equal(row.basis.items.length, 13);
  assert.deepEqual(row.basis.items.map((item) => item.code), ['s1','s2','s3','s4','s5','s6','s7','b1','b2','b3','r1','r2','d1']);
  assert.deepEqual(row.basis.items.find((item) => item.code === 'd1').options.map((option) => option.value), [0,1,2]);
  assert.equal(row.basis.items[0].anchor_low, '很低落');
  assert.equal(row.basis.rules.primary_max[S.baseline], 70);
  assert.equal(row.basis.context.optional_enabled, false);
  assert.equal(row.basis.context.focus_source, 'item_default');
  assert.equal(row.basis.item_version, 'items-v3-2');
  assert.equal(row.basis.rule_version, 'rules-t03-v1');
  assert.deepEqual(verifyEventBasis(row), row.basis);
});

test('publishing new items/rules changes only future events, not existing events or retries', async () => {
  const { event, provenance, repo } = await fixture();
  const original = await event('before');
  const next = defaultVersionBundle();
  next.catalog.items.find((item) => item.code === 's1').text = '新版状态问题';
  next.rules.quality.duration_ms_per_answer = 6000;
  await provenance.publishVersions({ ...next, item_version: 'items-v2', rule_version: 'rules-v2', published_by: 'editor', expected_revision: 1 });
  const after = await event('after', S.state, 3);
  assert.equal(after.basis.items[0].text, '新版状态问题');
  assert.equal(after.basis.rules.quality.duration_ms_per_answer, 6000);
  assert.equal(after.basis.release_revision, 2);
  assert.equal(original.basis.rules.quality.duration_ms_per_answer, 5000);
  assert.deepEqual((await event('before')).basis, original.basis);
  assert.deepEqual((await repo.getEvent('a', 'before')).basis, original.basis);
});

test('a published item or rule version cannot be overwritten and stale release updates fail', async () => {
  const { provenance, db } = await fixture();
  const before = db.snapshot();
  const changedItems = defaultVersionBundle();
  changedItems.catalog.items[0].text = 'changed';
  await assert.rejects(provenance.publishVersions({ ...changedItems, published_by: 'editor', expected_revision: 1 }), { code: 'XG_VERSION_IMMUTABLE' });
  const changedRules = defaultVersionBundle();
  changedRules.rules.thresholds.outcome_drop_abs = 8;
  await assert.rejects(provenance.publishVersions({ ...changedRules, published_by: 'editor', expected_revision: 1 }), { code: 'XG_VERSION_IMMUTABLE' });
  await assert.rejects(provenance.publishVersions({ ...changedItems, item_version: 'new', published_by: 'editor', expected_revision: 0 }), { code: 'XG_VERSION_CONFLICT' });
  assert.deepEqual(db.snapshot(), before);
});

test('case configuration is snapshotted and scoped: optional items never change the core denominator', async () => {
  const { provenance, event, repo } = await fixture();
  await provenance.setCaseConfig('a', { optional_enabled: true, focus_text: '和孩子沟通', expected_revision: 0, changed_by: 'counselor-a' });
  const state = await event('state');
  assert.equal(state.basis.items.length, 10);
  assert.deepEqual(state.basis.context.enabled_optional_codes, ['s8','s9','s10']);
  assert.equal(state.basis.context.primary_max, 70);
  assert.equal(state.basis.context.optional_max, 30);
  assert.equal(state.basis.items.find((item) => item.code === 's7').text, '和孩子沟通');
  assert.equal(state.basis.items.find((item) => item.code === 's7').source_text, '我来咨询最想解决的那件事，最近它');
  const other = await repo.insertEvent({ match_id: 'b', event_id: 'other', scale_code: S.state, session_no: 2, status: 'started' });
  assert.equal(other.basis.items.length, 7);
  assert.equal(other.basis.context.focus_text, null);
  const baseline = await event('baseline', S.baseline, 0);
  assert.equal(baseline.basis.items.length, 13);
  assert.deepEqual(baseline.basis.context.enabled_optional_codes, []);
});

test('focus changes retain immutable history; optional toggles do not fake a focus change', async () => {
  const { provenance, event, db } = await fixture();
  await provenance.setCaseConfig('a', { optional_enabled: false, focus_text: '主题甲', expected_revision: 0, changed_by: 'editor' });
  const first = await event('first');
  await provenance.setCaseConfig('a', { optional_enabled: true, focus_text: '主题甲', expected_revision: 1, changed_by: 'editor' });
  const second = await event('second', S.state, 3);
  await provenance.setCaseConfig('a', { optional_enabled: false, focus_text: '主题乙', expected_revision: 2, changed_by: 'editor' });
  const third = await event('third', S.state, 4);
  assert.deepEqual([first,second,third].map((row) => row.basis.context.focus_revision), [1,1,2]);
  assert.equal((await provenance.eventBasis('a', 'first')).basis.context.focus_text, '主题甲');
  assert.equal((await provenance.eventBasis('a', 'third')).basis.context.focus_text, '主题乙');
  assert.equal(db.snapshot()[C.caseAssessmentConfigs].size, 3);
  assert.equal((await db.get(C.caseAssessmentConfigs, documentKey('a', 1))).focus_text, '主题甲');
});

test('first-session p6 is explicitly inapplicable and does not masquerade as a five-point answer', async () => {
  const { event } = await fixture();
  const first = await event('pro-first', S.pro, 1);
  const item = first.basis.items.find((row) => row.code === 'p6');
  assert.equal(item.applicable, false);
  assert.equal(item.required, false);
  assert.equal(item.not_applicable_reason, 'first_session_no_previous');
  assert.equal(first.basis.context.primary_max, null);
  assert.deepEqual(first.basis.rules.first_session.null_metrics, ['total','pct','diff_post']);
  assert.equal(first.raw_answers.p6, undefined);
  const second = await event('pro-second', S.pro, 2);
  assert.equal(second.basis.items.find((row) => row.code === 'p6').applicable, true);
  assert.equal(second.basis.context.primary_max, 60);
});

test('missing published versions prevent new events without partial writes', async () => {
  const { event, db } = await fixture({ withVersions: false });
  const before = db.snapshot();
  await assert.rejects(event('new'), { code: 'XG_BASIS_NOT_CONFIGURED' });
  assert.deepEqual(db.snapshot(), before);
});

test('historical basis reads do not depend on the current or archived catalog being available', async () => {
  const { event, db } = await fixture();
  const original = await event('old');
  const guarded = { ...db, transaction(work) { return db.transaction((tx) => work({ ...tx, get(collection, id) {
    assert.ok(![C.itemVersions, C.ruleVersions, C.assessmentRelease].includes(collection));
    return tx.get(collection, id);
  } })); } };
  const audit = await createProvenanceRepository(guarded).eventBasis('a', 'old');
  assert.deepEqual(audit.basis, original.basis);
});

test('basis content tampering and copying to another event/cycle fail integrity checks', async () => {
  const { event, repo, provenance, db } = await fixture();
  const first = await event('first');
  const other = await repo.insertEvent({ match_id: 'b', event_id: 'other', scale_code: S.state, session_no: 2, status: 'started' });
  const tampered = structuredClone(first);
  tampered.basis.items[0].text = '篡改';
  await db.transaction((tx) => tx.put(C.events, 'first', tampered));
  await assert.rejects(provenance.eventBasis('a', 'first'), { code: 'XG_BASIS_INVALID' });
  await db.transaction((tx) => tx.put(C.events, 'other', { ...other, basis: first.basis }));
  await assert.rejects(provenance.eventBasis('b', 'other'), { code: 'XG_BASIS_INVALID' });
});

test('caller-provided basis/versions/config are rejected instead of trusted or silently stored', async () => {
  const { event, db } = await fixture();
  const before = db.snapshot();
  for (const field of ['basis', 'basis_hash', 'item_version', 'rule_version', 'optional_enabled', 'focus_text']) {
    await assert.rejects(event('injected', S.state, 2, { [field]: 'forged' }), { code: 'XG_BAD_PARAM' });
  }
  assert.deepEqual(db.snapshot(), before);
});

test('preexisting events without provenance stay explicitly unavailable; current templates are not backfilled', async () => {
  const { db, provenance } = await fixture();
  await db.transaction((tx) => tx.put(C.events, 'legacy', { event_id: 'legacy', match_id: 'a', visitor_id: 'visitor', counselor_id: 'counselor-a',
    scale_code: S.state, session_no: 2, follow_round: '', status: 'submitted', scores: { total: 42 } }));
  const before = db.snapshot();
  assert.deepEqual(await provenance.eventBasis('a', 'legacy'), { event_id: 'legacy', match_id: 'a', available: false, reason: 'not_captured', basis: null });
  assert.deepEqual(db.snapshot(), before);
});

test('publication and case-config failures roll back version documents and revision pointers together', async () => {
  const { provenance, db } = await fixture();
  const before = db.snapshot();
  db.failNextWriteTo(C.assessmentRelease);
  await assert.rejects(provenance.publishVersions({ ...defaultVersionBundle(), item_version: 'new-items', rule_version: 'new-rules',
    expected_revision: 1, published_by: 'editor' }), /Injected storage failure/);
  assert.deepEqual(db.snapshot(), before);
  db.failNextWriteTo(C.matches);
  await assert.rejects(provenance.setCaseConfig('a', { optional_enabled: true, focus_text: '主题', expected_revision: 0, changed_by: 'editor' }), /Injected storage failure/);
  assert.deepEqual(db.snapshot(), before);
});

test('version content hashes are stable across object-key order but preserve option order', () => {
  const bundle = defaultVersionBundle();
  const reverse = (value) => Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverse(value[key])])) : value;
  assert.equal(contentHash(bundle.catalog), contentHash(reverse(bundle.catalog)));
  const copy = structuredClone(bundle.catalog);
  copy.items.find((item) => item.code === 'd1').options.reverse();
  assert.notEqual(contentHash(copy), contentHash(bundle.catalog));
});

test('professional trend gets only provenance markers; visitor gets none; full audit is admin-only and scoped', async (t) => {
  const { db, repo, provenance, event } = await fixture();
  await db.transaction((tx) => tx.put(C.visitors, 'visitor', { visitor_id: 'visitor', provider: 'wechat-cloud' }));
  await provenance.setCaseConfig('a', { optional_enabled: false, focus_text: 'PRIVATE_FOCUS', expected_revision: 0, changed_by: 'editor' });
  await event('baseline', S.baseline, 0, { status: 'submitted', scores: { total: 49 } });
  await event('state', S.state, 2, { status: 'submitted', scores: { total: 42 } });
  const secret = 'basis-test-session-secret';
  const store = { assessment: repo, provenance, identity: createIdentityRepository(db),
    async findById(_table, id) { return { id, is_active: true, review_status: 'approved' }; }, async list() { return []; } };
  const server = http.createServer(createRequestHandler({ store, sessionSecret: secret }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  async function get(path, role) {
    const subject = { visitor: 'visitor', counselor: 'counselor-a', admin: 'admin' }[role];
    const signed = signSession({ subject, role, aud: 'xg-assessment', demo: false,
      auth_method: { visitor: 'wechat-cloud', counselor: 'counselor-edit', admin: 'admin-password' }[role], exp: Date.now() + 60000 }, secret);
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: { authorization: `Bearer ${signed}` } });
    return { status: res.status, body: await res.json() };
  }
  for (const role of ['visitor', 'counselor']) {
    assert.equal((await get('/v1/xg/admin/event-basis?match_id=a&event_id=state', role)).status, 403);
  }
  const audit = await get('/v1/xg/admin/event-basis?match_id=a&event_id=state', 'admin');
  assert.equal(audit.status, 200);
  assert.equal(audit.body.basis.context.focus_text, 'PRIVATE_FOCUS');
  assert.equal((await get('/v1/xg/admin/event-basis?match_id=b&event_id=state', 'admin')).status, 403);
  const visitor = await get('/v1/xg/events?match_id=a', 'visitor');
  assert.equal(JSON.stringify(visitor.body).includes('PRIVATE_FOCUS'), false);
  assert.equal('basis_ref' in visitor.body.events[0], false);
  const trend = await get('/v1/xg/trend?match_id=a', 'counselor');
  assert.equal(trend.body.points[0].basis_ref.focus_revision, 1);
  assert.equal(JSON.stringify(trend.body).includes('PRIVATE_FOCUS'), false);
  assert.equal('rules' in trend.body.points[0].basis_ref, false);
});
