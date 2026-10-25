const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { processAnswers } = require('./answer-processor');
const { replayEventScores } = require('./score-replay');
const { referenceBaseline } = require('./baseline-reference');
const { createAssessmentRepository } = require('./repository');
const { createConsentRepository } = require('./consent');
const { createEventLifecycle } = require('./event-lifecycle');
const { createIdentityRepository } = require('./identity-repository');
const { createProvenanceRepository, defaultVersionBundle, contentHash } = require('./provenance');
const { memoryAssessmentStore } = require('./test-support');
const { createRequestHandler, signSession } = require('../app');
const { COLLECTIONS: C, SCALES: S } = require('./model');
const DAY = 86400000;
const actor = (role = 'visitor', subject = role === 'visitor' ? 'v' : role === 'counselor' ? 'c' : 'admin') => ({
  role, subject, aud: 'xg-assessment', demo: false, exp: Date.now() + 3600000,
  auth_method: role === 'visitor' ? 'wechat-cloud' : role === 'counselor' ? 'counselor-edit' : 'admin-password'
});
function fill(event, value = 6) {
  return Object.fromEntries(event.basis.items.filter((i) => i.applicable).map((i) => [i.code,
    i.item_type === 'text' ? '测试反馈' : i.item_type === 'single_choice' ? i.options[0].value : value]));
}
const numbered = (prefix, values) => Object.fromEntries(values.map((v, i) => [`${prefix}${i + 1}`, v]));
async function fixture() {
  const db = memoryAssessmentStore(); let time = Date.parse('2026-10-01T00:00:00Z'), serial = 0;
  const repo = createAssessmentRepository(db, { now: () => new Date(time).toISOString() });
  const consent = createConsentRepository(db), provenance = createProvenanceRepository(db);
  const flow = createEventLifecycle(db, consent, { now: () => time });
  await db.transaction((tx) => tx.put(C.visitors, 'v', { visitor_id: 'v', provider: 'wechat-cloud' }));
  for (const scope of ['assessment', 'followup']) {
    await consent.publishPolicy({ scope, version: 'test', title: 'TEST', content: 'Synthetic test only.', published_by: 'test', expected_revision: 0 });
    const state = await consent.getStatus('v', scope);
    await consent.decide(actor(), { scope, version: 'test', document_hash: state.required_document.content_hash,
      agreed: true, channel: 'web', client_event_id: `grant-${scope}`, expected_revision: 0 });
  }
  await repo.createMatch({ match_id: 'case', visitor_id: 'v', counselor_id: 'c', assessment_id: 'intake' });
  const start = (scale = S.baseline, session = 0, extra = {}) => flow.start(actor(scale === S.pro ? 'counselor' : 'visitor'), {
    match_id: 'case', scale_code: scale, session_no: session, client_event_id: `attempt-${++serial}`, ...extra
  });
  const submit = (event, answers = fill(event), extra = {}) => flow.submit(actor(event.actor_role), {
    match_id: event.match_id, event_id: event.event_id, request_id: `submit-${++serial}`, answers, ...extra
  });
  const baseline = async (value = 7) => {
    const { event } = await start(); time += 70000;
    return (await submit(event, fill(event, value))).event;
  };
  return { db, repo, consent, provenance, flow, start, submit, baseline,
    advance(ms) { time += ms; }, time: () => time };
}

const vectors = [
  { name: 'M0', scale: S.baseline, session: 0,
    values: { ...numbered('s', [1,2,3,4,5,6,7]), ...numbered('b', [2,6,9]), r1: 4, r2: 9, d1: 2 },
    scores: { total: 28, pct: 40, ors_total: 17, add_total: 7, supp_total: 17, resource_total: 13, dissoc_level: 2 } },
  { name: 'M1-core', scale: S.state, session: 2, values: numbered('s', [1,2,3,4,5,6,7]),
    scores: { total: 28, pct: 40, ors_total: 17, add_total: 7, stability_total: null } },
  { name: 'M1-optional', scale: S.state, session: 2, optional: true, values: numbered('s', [1,2,3,4,5,6,7,8,9,10]),
    scores: { total: 28, pct: 40, ors_total: 17, add_total: 7, stability_total: 27 } },
  { name: 'M2', scale: S.feel, session: 1, values: numbered('f', [1,2,3,4]), scores: { total: 10, pct: 25 } },
  { name: 'M3-first', scale: S.pro, session: 1, values: numbered('p', [1,2,3,4,5]), scores: { total: null, pct: null } },
  { name: 'M3-later', scale: S.pro, session: 2, values: numbered('p', [1,2,3,4,5,10]), scores: { total: 25, pct: 41.67 } },
  { name: 'M4-end', scale: S.end, session: 3, values: numbered('e', [1,2,3,4,5,6]), scores: { total: 21, pct: 35, supp_total: 12 } },
  { name: 'M4-eval', scale: S.evaluation, session: 3, values: { v1: 1, v2: 2, v3: 3, o1: '不入数值分' }, scores: { total: 6, pct: 20 } },
  { name: 'M4-follow-1m', scale: S.follow, session: 3, round: '1m', values: numbered('u', [1,2,3,4,5,6]), scores: { total: 21, pct: 35, supp_total: 9 } },
  { name: 'M4-follow-3m', scale: S.follow, session: 3, round: '3m', values: numbered('u', [1,2,3,4,5,6]), scores: { total: 21, pct: 35, supp_total: 9 } }
];
for (const vector of vectors) {
  test(`T12 ${vector.name}: hand-calculated scores persist and replay exactly`, async () => {
    const f = await fixture();
    if (vector.optional) await f.provenance.setCaseConfig('case', { optional_enabled: true, focus_text: '主题', expected_revision: 0, changed_by: 'c' });
    if (vector.round) { await f.repo.closeMatch('case', 3); f.advance(100 * DAY); }
    const { event } = await f.start(vector.scale, vector.session, { follow_round: vector.round || '' });
    f.advance(100000);
    const saved = (await f.submit(event, vector.values)).event;
    assert.deepEqual(saved.scores, vector.scores);
    const before = f.db.snapshot(), replay = await f.repo.replayScores('case', event.event_id);
    assert.equal(replay.matches, true); assert.deepEqual(replay.differences, []);
    assert.deepEqual(replay.recomputed.scores, vector.scores);
    assert.equal(replay.engine_id, 'xg-core-t03-v1');
    assert.deepEqual(f.db.snapshot(), before);
  });
}

test('T12 M0 zero/max bounds keep resources, supplemental scores and d1 separate', async () => {
  const f = await fixture(), { event } = await f.start();
  assert.deepEqual(processAnswers(event.basis, fill(event, 0), 100000).scores,
    { total: 0, pct: 0, ors_total: 0, add_total: 0, supp_total: 0, resource_total: 0, dissoc_level: 0 });
  const full = { ...fill(event, 10), d1: 2 };
  assert.deepEqual(processAnswers(event.basis, full, 100000).scores,
    { total: 70, pct: 100, ors_total: 40, add_total: 10, supp_total: 30, resource_total: 20, dissoc_level: 2 });
  const alternate = processAnswers(event.basis, { ...full, b1: 0, b2: 0, b3: 0, r1: 0, r2: 0, d1: 0 }, 100000).scores;
  assert.equal(alternate.total, 70); assert.equal(alternate.ors_total, 40);
});

test('T12 optional 0/30 cannot change core total, percent, ORS or added score', async () => {
  const f = await fixture();
  await f.provenance.setCaseConfig('case', { optional_enabled: true, focus_text: null, expected_revision: 0, changed_by: 'c' });
  const { event } = await f.start(S.state, 2);
  const low = processAnswers(event.basis, { ...fill(event, 6), s8: 0, s9: 0, s10: 0 }, 100000).scores;
  const high = processAnswers(event.basis, { ...fill(event, 6), s8: 10, s9: 10, s10: 10 }, 100000).scores;
  assert.deepEqual(low, { total: 42, pct: 60, ors_total: 24, add_total: 6, stability_total: 0 });
  assert.deepEqual(high, { ...low, stability_total: 30 });
});

test('T12 percentages use fixed denominator and ORS rounds the mean only as part of the final sum', async () => {
  const { event } = await (await fixture()).start(S.state, 2);
  for (const [values, total, pct, ors] of [
    [[0,0,1,2,3,4,10], 20, 28.57, 9], [[0,1,1,2,3,4,10], 21, 30, 10],
    [[1,0,0,0,0,0,0], 1, 1.43, 0], [[10,10,10,10,10,10,9], 69, 98.57, 40]
  ]) {
    const result = processAnswers(event.basis, numbered('s', values), 100000);
    assert.equal(result.scores.total, total); assert.equal(result.scores.pct, pct); assert.equal(result.scores.ors_total, ors);
  }
});

test('T12 legal short responses use server duration, including the exact quality threshold', async () => {
  const f = await fixture(), { event } = await f.start();
  const answers = vectors[0].values;
  assert.equal(processAnswers(event.basis, answers, 64999).quality_flag, 'low');
  assert.equal(processAnswers(event.basis, answers, 65000).quality_flag, 'ok');
  f.advance(60000);
  const saved = (await f.submit(event, answers, { duration_ms: 99999999 })).event;
  assert.equal(saved.quality_flag, 'low'); assert.equal(saved.duration_ms, 60000);
  assert.equal(replayEventScores(saved).recomputed.quality_flag, 'low');
});

test('T12 historical replay ignores later configuration, catalog and rule release', async () => {
  const f = await fixture(), saved = await f.baseline();
  const next = defaultVersionBundle(); next.rules.quality.duration_ms_per_answer = 100000;
  next.catalog.items[0].text = '后来改的题干';
  await f.provenance.publishVersions({ ...next, item_version: 'new-items', rule_version: 'new-rules', expected_revision: 1, published_by: 'test' });
  await f.provenance.setCaseConfig('case', { optional_enabled: true, focus_text: '后来的主题', expected_revision: 0, changed_by: 'c' });
  const before = f.db.snapshot(), replay = await f.repo.replayScores('case', saved.event_id);
  assert.equal(replay.matches, true); assert.equal(replay.recomputed.quality_flag, 'ok');
  assert.equal(replay.basis_ref.rule_version, saved.basis.rule_version);
  assert.deepEqual(f.db.snapshot(), before);
});

test('T12 replay detects differing stored scores/quality without repairing any record', async () => {
  const f = await fixture(), saved = await f.baseline();
  await f.db.transaction((tx) => tx.put(C.events, saved.event_id, { ...saved, scores: { ...saved.scores, total: 1 }, quality_flag: 'low' }));
  const before = f.db.snapshot(), replay = await f.repo.replayScores('case', saved.event_id);
  assert.equal(replay.matches, false); assert.deepEqual(replay.differences, ['scores.total', 'quality_flag']);
  assert.equal(replay.stored.scores.total, 1); assert.equal(replay.recomputed.scores.total, 49);
  assert.deepEqual(f.db.snapshot(), before);
});

for (const [name, mutate, code] of [
  ['missing basis', (e) => { delete e.basis; }, 'XG_BASIS_REQUIRED'],
  ['tampered basis', (e) => { e.basis.items[0].text = 'tampered'; }, 'XG_BASIS_INVALID'],
  ['missing server duration', (e) => { delete e.duration_ms; }, 'XG_REPLAY_DURATION_MISSING'],
  ['invalid historical answers', (e) => { delete e.raw_answers.s1; }, 'XG_REPLAY_ANSWERS_INVALID'],
  ['unsubmitted event', (e) => { e.status = 'rejected'; }, 'XG_REPLAY_NOT_SUBMITTED'],
  ['unknown stored score key', (e) => { e.scores.secret = 'never echo'; }, 'XG_REPLAY_SCORES_INVALID'],
  ['unsupported historical engine', (e) => {
    e.basis.rules.engine_id = 'future-engine'; e.basis.rule_hash = contentHash(e.basis.rules);
    const { basis_hash, ...basis } = e.basis; e.basis.basis_hash = contentHash(basis);
  }, 'XG_RULE_ENGINE_UNAVAILABLE']
]) {
  test(`T12 replay fails closed for ${name}`, async () => {
    const f = await fixture(), saved = await f.baseline(); mutate(saved);
    assert.throws(() => replayEventScores(saved), { code });
  });
}

for (const [elapsed, allowed] of [[7 * DAY - 1, false], [7 * DAY, false], [7 * DAY + 1, true]]) {
  test(`T12 recheck start boundary ${elapsed}ms is ${allowed ? 'allowed' : 'blocked'}`, async () => {
    const f = await fixture(); await f.baseline(); f.advance(elapsed);
    const before = f.db.snapshot();
    if (allowed) assert.equal((await f.start(S.state, 1)).event.status, 'started');
    else { await assert.rejects(f.start(S.state, 1), { code: 'XG_RECHECK_NOT_DUE' }); assert.deepEqual(f.db.snapshot(), before); }
  });
}

test('T12 missing baseline and first-session already submitted both block recheck', async () => {
  const f = await fixture();
  await assert.rejects(f.start(S.state, 1), { code: 'XG_RECHECK_NOT_DUE' });
  await f.baseline(); f.advance(8 * DAY);
  const { event } = await f.start(S.feel, 1); await f.submit(event);
  await assert.rejects(f.start(S.state, 1), { code: 'XG_RECHECK_NOT_DUE' });
});

test('T12 submit rechecks eligibility after filling, and failure leaves the baseline unchanged', async () => {
  const f = await fixture(); await f.baseline(); f.advance(8 * DAY);
  const { event: recheck } = await f.start(S.state, 1);
  const { event: feel } = await f.start(S.feel, 1); await f.submit(feel);
  const before = f.db.snapshot();
  await assert.rejects(f.submit(recheck), { code: 'XG_RECHECK_NOT_DUE' });
  assert.deepEqual(f.db.snapshot(), before);
});

test('T12 recheck becomes stable reference, original survives and session 1 is absent from trend points', async () => {
  const f = await fixture(), base = await f.baseline();
  assert.equal((await f.repo.getTrend('case')).reference_baseline.source, 'original');
  f.advance(8 * DAY);
  const { event: recheck } = await f.start(S.state, 1); await f.submit(recheck, fill(recheck, 0));
  const { event: regular } = await f.start(S.state, 2); await f.submit(regular, fill(regular, 10));
  const trend = await f.repo.getTrend('case');
  assert.equal(trend.baseline.original.total, 49); assert.equal(trend.baseline.original.event_id, base.event_id);
  assert.equal(trend.reference_baseline.source, 'late_recheck'); assert.equal(trend.reference_baseline.total, 0);
  assert.equal(trend.reference_baseline.event_id, recheck.event_id);
  assert.deepEqual(trend.points.map((p) => p.session_no), [2]);
  assert.equal(trend.points[0].total, 70);
  await assert.rejects(f.start(S.state, 1), { code: 'XG_ALREADY_SUBMITTED' });
});

test('T12 failed recheck does not replace original; correcting it updates only the reference', async () => {
  const f = await fixture(); await f.baseline(); f.advance(8 * DAY);
  const { event } = await f.start(S.state, 1);
  assert.equal((await f.submit(event, {})).statusCode, 422);
  assert.equal((await f.repo.getTrend('case')).reference_baseline.source, 'original');
  const original = (await f.repo.getProfiles('case')).baseline.original;
  await f.submit(event, fill(event, 5));
  assert.deepEqual((await f.repo.getProfiles('case')).baseline.original, original);
  assert.equal((await f.repo.getTrend('case')).reference_baseline.total, 35);
});

test('T12 timeout and closure cannot replace the original baseline', async () => {
  const f = await fixture(); await f.baseline(); f.advance(8 * DAY);
  const { event } = await f.start(S.state, 1); f.advance(30 * 60000);
  assert.equal((await f.submit(event)).error.code, 'XG_EVENT_EXPIRED');
  assert.equal((await f.repo.getTrend('case')).reference_baseline.source, 'original');
  await f.repo.closeMatch('case', 1);
  await assert.rejects(f.start(S.state, 1), { code: 'XG_RELATION_CLOSED' });
});

test('T12 recheck eligibility uses the frozen rule timing even when current rules change', async () => {
  const f = await fixture(); await f.baseline(); f.advance(8 * DAY);
  const { event } = await f.start(S.state, 1);
  const next = defaultVersionBundle(); next.rules.timing.late_recheck_days = 30;
  await f.provenance.publishVersions({ ...next, rule_version: 'rules-30-days', expected_revision: 1, published_by: 'test' });
  assert.equal((await f.submit(event)).event.status, 'submitted');
});

test('T12 profiles from a new cycle never inherit the old reference; invalid profile is not silently guessed', async () => {
  const f = await fixture(); await f.baseline(); f.advance(8 * DAY);
  const { event } = await f.start(S.state, 1); await f.submit(event, fill(event, 4));
  await f.repo.createMatch({ match_id: 'new', visitor_id: 'v', counselor_id: 'other', assessment_id: 'intake-new' });
  assert.equal((await f.repo.getTrend('new')).reference_baseline, null);
  assert.equal((await f.repo.getTrend('case')).reference_baseline.total, 28);
  assert.throws(() => referenceBaseline({ original: { session_no: 0, total: null } }), { code: 'XG_BASELINE_INVALID' });
});

test('T12 concurrent recheck attempts occupy one slot and roll back profile on write failure', async () => {
  const f = await fixture(); await f.baseline(); f.advance(8 * DAY);
  const a = (await f.start(S.state, 1)).event, b = (await f.start(S.state, 1)).event;
  const before = f.db.snapshot(); f.db.failNextWriteTo(C.requestReceipts);
  await assert.rejects(f.submit(a), /Injected storage failure/); assert.deepEqual(f.db.snapshot(), before);
  const results = await Promise.allSettled([f.submit(a, fill(a, 3)), f.submit(b, fill(b, 9))]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'XG_ALREADY_SUBMITTED');
  assert.equal((await f.repo.getTrend('case')).reference_baseline.total, 21);
});

test('T12 audit HTTP is admin-only, scoped, read-only and trend exposes a safe reference', async (t) => {
  const f = await fixture(), saved = await f.baseline();
  await f.repo.createMatch({ match_id: 'other', visitor_id: 'v', counselor_id: 'other', assessment_id: 'other-intake' });
  const secret = 't12-http-test';
  const store = { assessment: f.repo, provenance: f.provenance, lifecycle: f.flow, consent: f.consent,
    identity: createIdentityRepository(f.db), async list() { return []; },
    async findById(_table, id) { return id === 'c' ? { id, is_active: true, review_status: 'approved' } : null; } };
  const server = http.createServer(createRequestHandler({ store, sessionSecret: secret }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((resolve) => server.close(resolve)));
  async function get(path, role = 'admin', method = 'GET') {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method,
      headers: role ? { authorization: `Bearer ${signSession(actor(role), secret)}` } : {} });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  }
  const path = `/v1/xg/admin/event-score-replay?match_id=case&event_id=${saved.event_id}`;
  const before = f.db.snapshot();
  const replay = await get(path); assert.equal(replay.status, 200); assert.equal(replay.body.matches, true); assert.equal(replay.cache, 'no-store');
  assert.equal(JSON.stringify(replay.body).includes('raw_answers'), false);
  assert.equal(JSON.stringify(replay.body).includes('anchor_low'), false);
  for (const role of ['visitor', 'counselor']) assert.equal((await get(path, role)).status, 403);
  assert.equal((await get(path, null)).status, 401);
  assert.equal((await get(path.replace('match_id=case', 'match_id=other'))).status, 403);
  assert.equal((await get(path + '&event_id=second')).status, 400);
  assert.equal((await get(path.replace(saved.event_id, 'missing'))).status, 404);
  assert.equal((await get(path, 'admin', 'POST')).status, 404);
  const trend = await get('/v1/xg/trend?match_id=case', 'counselor');
  assert.equal(trend.body.reference_baseline.source, 'original'); assert.equal(trend.body.reference_baseline.total, 49);
  assert.equal('raw_answers' in trend.body.reference_baseline, false);
  assert.equal((await get('/v1/xg/trend?match_id=case', 'visitor')).status, 403);
  assert.deepEqual(f.db.snapshot(), before);
});

test('T12 all seven card types retain their fixed zero/full-score bounds', async () => {
  const maxima = { [S.baseline]: 70, [S.state]: 70, [S.feel]: 40, [S.pro]: 60,
    [S.end]: 60, [S.evaluation]: 30, [S.follow]: 60 };
  for (const vector of vectors) {
    const f = await fixture();
    if (vector.optional) await f.provenance.setCaseConfig('case', { optional_enabled: true, focus_text: null, expected_revision: 0, changed_by: 'c' });
    if (vector.round) { await f.repo.closeMatch('case', 3); f.advance(100 * DAY); }
    const { event } = await f.start(vector.scale, vector.session, { follow_round: vector.round || '' });
    for (const full of [false, true]) {
      const answers = fill(event, full ? 10 : 0);
      for (const item of event.basis.items.filter((i) => i.applicable && i.item_type === 'single_choice')) answers[item.code] = full ? item.options.at(-1).value : item.options[0].value;
      const scores = processAnswers(event.basis, answers, 100000).scores;
      const unavailable = vector.scale === S.pro && vector.session === 1;
      assert.equal(scores.total, unavailable ? null : full ? maxima[vector.scale] : 0, vector.name);
      assert.equal(scores.pct, unavailable ? null : full ? 100 : 0, vector.name);
    }
  }
});

test('T12 unsupported newly published engine never falls back or writes a submission', async () => {
  const f = await fixture(), next = defaultVersionBundle();
  next.rules.engine_id = 'unsupported-v2';
  await f.provenance.publishVersions({ ...next, rule_version: 'future-rules', expected_revision: 1, published_by: 'test' });
  const { event } = await f.start(); const before = f.db.snapshot();
  await assert.rejects(f.submit(event), { code: 'XG_RULE_ENGINE_UNAVAILABLE', statusCode: 503 });
  assert.deepEqual(f.db.snapshot(), before);
});
