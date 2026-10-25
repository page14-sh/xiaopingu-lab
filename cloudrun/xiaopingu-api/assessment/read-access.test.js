const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRequestHandler, signSession } = require('../app');
const { createAssessmentRepository } = require('./repository');
const { createIdentityRepository } = require('./identity-repository');
const { memoryAssessmentStore } = require('./test-support');
const { COLLECTIONS: C, SCALES: S } = require('./model');

const secret = 'read-test-session-secret-with-enough-entropy';
const sentinel = 'INTERNAL_SECRET_MUST_NOT_LEAK';
const token = (role, subject) => signSession({ role, subject, aud: 'xg-assessment', demo: false,
  auth_method: { visitor: 'wechat-cloud', counselor: 'counselor-edit', admin: 'admin-password' }[role],
  exp: Date.now() + 60000 }, secret);
const identities = { visitor: token('visitor', 'v1'), stranger: token('visitor', 'v2'),
  ca: token('counselor', 'ca'), cb: token('counselor', 'cb'), admin: token('admin', 'admin') };

async function fixture(t) {
  const db = memoryAssessmentStore();
  const repo = createAssessmentRepository(db);
  await db.transaction(async (tx) => {
    for (const visitor_id of ['v1', 'v2']) await tx.put(C.visitors, visitor_id, { visitor_id, provider: 'wechat-cloud' });
  });
  await repo.createMatch({ match_id: 'old-a', visitor_id: 'v1', counselor_id: 'ca', assessment_id: 'intake-1' });
  const definitions = [
    ['baseline', S.baseline, 0, { s1: 7, b1: 6, r1: 8, d1: 0 }],
    ['state', S.state, 2, { s1: 6 }], ['feel', S.feel, 2, { f1: 8, f2: 7, f3: 8, f4: 7 }],
    ['pro', S.pro, 2, { p1: 8, p2: 8, p3: 8, p4: 8, p5: 8, p6: 5 }],
    ['end', S.end, 5, { e1: 8 }], ['evaluation', S.evaluation, 5, { v1: 9, o1: 'ADMIN_ONLY_FEEDBACK' }]
  ];
  for (const [id, scale_code, session_no, raw_answers] of definitions) {
    await repo.insertEvent({ match_id: 'old-a', event_id: id, scale_code, session_no, status: 'submitted',
      raw_answers: { ...raw_answers, secret_extra: sentinel }, scores: { total: 42, pct: 60, ors_total: 24, add_total: 6, supp_total: 18 } });
  }
  await repo.closeMatch('old-a', 5);
  await repo.insertEvent({ match_id: 'old-a', event_id: 'follow', scale_code: S.follow, session_no: 5,
    follow_round: '1m', status: 'submitted', raw_answers: { u1: 8, secret_extra: sentinel }, scores: { total: 45, supp_total: 23 } });
  await repo.createMatch({ match_id: 'new-b', visitor_id: 'v1', counselor_id: 'cb', assessment_id: 'intake-2', previous_match_id: 'old-a' });
  await repo.insertEvent({ match_id: 'new-b', event_id: 'b-base', scale_code: S.baseline, session_no: 0, status: 'submitted', scores: { total: 63 } });
  await repo.insertEvent({ match_id: 'new-b', event_id: 'b-state', scale_code: S.state, session_no: 2, status: 'submitted', scores: { total: 56 } });
  await db.transaction(async (tx) => {
    const state = await tx.get(C.events, 'state');
    await tx.put(C.events, 'state', { ...state, future_score: 999, llm_output: sentinel, private_note: sentinel });
    const baseline = await tx.get(C.baselines, 'old-a');
    await tx.put(C.baselines, 'old-a', { ...baseline, risk_level: sentinel, focus_text: sentinel,
      original: { ...baseline.original, secret_extra: sentinel } });
    await tx.put(C.llmResults, 'state', {
      event_id: 'state', match_id: 'old-a', visitor_id: 'v1', counselor_id: 'ca', session_no: 999,
      summary: '本节数据已汇总，可在下节共同核对。', suggest_actions: ['核对最近的生活变化'],
      dim_scores: { ORS: 60, 联盟: 75, 稳定度: 70, 目标进展: 65, private_dimension: sentinel },
      model: 'model-v1', prompt_version: 'v1', scored_at: '2026-10-25T10:00:00Z',
      raw_response: sentinel, system_prompt: sentinel, api_key: sentinel
    });
  });
  const store = {
    assessment: repo, identity: createIdentityRepository(db),
    async findById(_table, id) { return ['ca', 'cb'].includes(id) ? { id, is_active: true, review_status: 'approved' } : null; },
    async list(table) { return table === 'assessments' ? [{ id: 'legacy', selected_counselor_id: 'cb', visitor_user_id: 'v1' }] : []; }
  };
  const server = http.createServer(createRequestHandler({ store, sessionSecret: secret }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  async function get(path, identity) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      headers: identity ? { authorization: `Bearer ${identities[identity]}` } : {}
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  return { db, repo, get };
}

test('visitor history exposes only their card metadata, with no scores, raw answers, quality or M3 records', async (t) => {
  const { get } = await fixture(t);
  const response = await get('/v1/xg/events?match_id=old-a', 'visitor');
  assert.equal(response.status, 200);
  assert.equal(response.body.events.length, 6);
  assert.equal(response.body.events.some((row) => row.scale_code === S.pro), false);
  for (const row of response.body.events) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'scale_code', 'session_no', 'follow_round', 'status', 'created_at', 'submitted_at'].sort());
  }
  assert.equal(JSON.stringify(response.body).includes(sentinel), false);
  assert.equal((await get('/v1/xg/events?match_id=old-a&event_id=pro', 'visitor')).status, 403);
  assert.equal((await get(`/v1/xg/events?match_id=old-a&scale_code=${S.pro}`, 'visitor')).status, 403);
});

test('visitor cannot read trend, comparison or LLM even for their own cycle', async (t) => {
  const { get } = await fixture(t);
  for (const endpoint of ['trend', 'person-compare', 'llm-results']) {
    const response = await get(`/v1/xg/${endpoint}?match_id=old-a`, 'visitor');
    assert.equal(response.status, 403);
    assert.equal(JSON.stringify(response.body).includes(sentinel), false);
  }
});

test('counselor reads only M2/M3 answers through an explicit question whitelist', async (t) => {
  const { get } = await fixture(t);
  const response = await get('/v1/xg/events?match_id=old-a', 'ca');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.events.map((row) => row.scale_code).sort(), [S.feel, S.pro].sort());
  assert.deepEqual(response.body.events.find((row) => row.scale_code === S.feel).raw_answers, { f1: 8, f2: 7, f3: 8, f4: 7 });
  for (const row of response.body.events) {
    assert.ok('total' in row && 'pct' in row);
    assert.equal('supp_total' in row, false);
    assert.equal('ors_total' in row, false);
  }
  for (const card of [S.baseline, S.state, S.end, S.evaluation, S.follow]) {
    assert.equal((await get(`/v1/xg/events?match_id=old-a&scale_code=${card}`, 'ca')).status, 403);
  }
});

test('admin receives explicit card fields, not future/internal fields or arbitrary nested data', async (t) => {
  const { get } = await fixture(t);
  const response = await get('/v1/xg/events?match_id=old-a', 'admin');
  assert.equal(response.status, 200);
  assert.equal(response.body.events.length, 7);
  assert.equal(response.body.events.find((row) => row.id === 'evaluation').raw_answers.o1, 'ADMIN_ONLY_FEEDBACK');
  assert.equal(JSON.stringify(response.body).includes(sentinel), false);
  assert.ok(response.body.events.every((row) => !('_id' in row) && !('actor_id' in row) && !('future_score' in row)));
});

test('cross-period access is denied even after the same visitor has a new counselor', async (t) => {
  const { get } = await fixture(t);
  for (const endpoint of ['events', 'trend', 'person-compare', 'llm-results']) {
    assert.equal((await get(`/v1/xg/${endpoint}?match_id=old-a`, 'cb')).status, 403);
    assert.equal((await get(`/v1/xg/${endpoint}?match_id=new-b`, 'ca')).status, 403);
    assert.equal((await get(`/v1/xg/${endpoint}?match_id=old-a`, 'stranger')).status, 403);
    assert.equal((await get(`/v1/xg/${endpoint}?match_id=old-a`)).status, 401);
  }
  assert.equal((await get('/v1/xg/trend?match_id=old-a', 'ca')).body.points[0].total, 42);
  assert.equal((await get('/v1/xg/trend?match_id=new-b', 'cb')).body.points[0].total, 56);
});

test('event ID and LLM result cannot be used to bypass cycle authorization', async (t) => {
  const { get } = await fixture(t);
  assert.equal((await get('/v1/xg/events?match_id=new-b&event_id=state', 'admin')).status, 403);
  assert.equal((await get('/v1/xg/llm-results?match_id=new-b&event_id=state', 'admin')).status, 403);
});

test('query projection, role override, duplicate match id and invalid pagination are rejected', async (t) => {
  const { get } = await fixture(t);
  for (const query of ['select=*', 'role=admin', 'user_id=v1', 'match_id=new-b', 'limit=0', 'limit=201',
    'offset=-1', 'limit=1e2', 'offset=Infinity', 'follow_round=6m']) {
    assert.equal((await get(`/v1/xg/events?match_id=old-a&${query}`, 'visitor')).status, 400, query);
  }
  assert.equal((await get('/v1/xg/events', 'visitor')).status, 400);
  assert.equal((await get('/v1/xg/trend?match_id=old-a&from_session=3&to_session=2', 'ca')).status, 400);
});

test('pagination happens after card visibility filtering and does not reveal hidden record counts', async (t) => {
  const { get } = await fixture(t);
  const all = (await get('/v1/xg/events?match_id=old-a', 'visitor')).body.events;
  const collected = [];
  for (let offset = 0; offset < all.length; offset++) {
    const page = (await get(`/v1/xg/events?match_id=old-a&limit=1&offset=${offset}`, 'visitor')).body;
    assert.deepEqual(Object.keys(page), ['events']);
    collected.push(...page.events);
  }
  assert.deepEqual(collected, all);
});

test('trend and stage comparison omit baseline free text, risk tags and internal snapshots', async (t) => {
  const { get } = await fixture(t);
  for (const endpoint of ['trend', 'person-compare']) {
    const response = await get(`/v1/xg/${endpoint}?match_id=old-a`, 'ca');
    assert.equal(response.status, 200);
    assert.equal(JSON.stringify(response.body).includes(sentinel), false);
    assert.equal('risk_level' in response.body.baseline, false);
    assert.equal('raw_answers' in response.body.baseline, false);
  }
  const comparison = (await get('/v1/xg/person-compare?match_id=old-a', 'ca')).body;
  assert.equal(comparison.follow_1m.supp_total, 23);
  assert.equal(comparison.follow_3m, null);
  assert.equal('delta' in comparison, false);
});

test('LLM reads whitelist dimensions and metadata and take session number from the linked event', async (t) => {
  const { get } = await fixture(t);
  for (const role of ['ca', 'admin']) {
    const response = await get('/v1/xg/llm-results?match_id=old-a', role);
    assert.equal(response.status, 200);
    assert.equal(response.body.results.length, 1);
    assert.equal(response.body.results[0].session_no, 2);
    assert.deepEqual(Object.keys(response.body.results[0].dim_scores), ['ORS', '联盟', '稳定度', '目标进展']);
    assert.equal(JSON.stringify(response.body).includes(sentinel), false);
  }
});

test('unsafe LLM summary/actions or malformed dimensions are withheld, including for admins', async (t) => {
  const { db, get } = await fixture(t);
  const original = await db.get(C.llmResults, 'state');
  for (const patch of [
    { summary: '病情恶化' }, { suggest_actions: ['严重时需要处理'] },
    { suggest_actions: [{ private: sentinel }] }, { dim_scores: { ORS: 999 } }
  ]) {
    await db.transaction((tx) => tx.put(C.llmResults, 'state', { ...original, ...patch }));
    assert.deepEqual((await get('/v1/xg/llm-results?match_id=old-a', 'admin')).body, { results: [] });
  }
});

test('LLM result with forged redundant scope or linked event fails closed', async (t) => {
  const { db, get } = await fixture(t);
  const original = await db.get(C.llmResults, 'state');
  for (const patch of [{ counselor_id: 'cb' }, { event_id: 'b-state' }, { match_id: 'new-b' }]) {
    await db.transaction((tx) => tx.put(C.llmResults, 'state', { ...original, ...patch }));
    const response = await get('/v1/xg/llm-results?match_id=old-a&event_id=state', 'admin');
    assert.equal(response.status, 403);
    assert.equal(JSON.stringify(response.body).includes(sentinel), false);
  }
});

test('all private read responses and failures are marked no-store and vary by authorization', async (t) => {
  const { get } = await fixture(t);
  for (const [path, role] of [['events', 'visitor'], ['llm-results', 'ca'], ['trend', 'visitor'], ['events', undefined]]) {
    const response = await get(`/v1/xg/${path}?match_id=old-a`, role);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('vary'), 'Authorization');
  }
});

test('legacy generic API cannot read any four-assessment collection, including new LLM results', async (t) => {
  const { get } = await fixture(t);
  for (const collection of Object.values(C)) {
    for (const role of ['visitor', 'admin', undefined]) {
      assert.equal((await get(`/rest/v1/${collection}?select=*`, role)).status, 404);
    }
  }
});
