const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { validateAnswers } = require('./answer-validation');
const { processAnswers } = require('./answer-processor');
const { requestHash } = require('./request-hash');
const { createAssessmentRepository } = require('./repository');
const { createProvenanceRepository, contentHash } = require('./provenance');
const { createConsentRepository } = require('./consent');
const { createIdentityRepository } = require('./identity-repository');
const { createEventLifecycle, formView } = require('./event-lifecycle');
const { memoryAssessmentStore } = require('./test-support');
const { createRequestHandler, signSession } = require('../app');
const { COLLECTIONS: C, SCALES: S } = require('./model');
const catalog = require('./definitions/items-v3-2.json');

const scenarios = [
  { name: 'M0', scale: S.baseline, session: 0, count: 13 },
  { name: 'M1-core', scale: S.state, session: 2, count: 7 },
  { name: 'M1-optional', scale: S.state, session: 2, optional: true, count: 10 },
  { name: 'M2', scale: S.feel, session: 1, count: 4 },
  { name: 'M3-first', scale: S.pro, session: 1, count: 5 },
  { name: 'M3-later', scale: S.pro, session: 2, count: 6 },
  { name: 'M4-end', scale: S.end, session: 3, count: 6 },
  { name: 'M4-evaluation', scale: S.evaluation, session: 3, count: 4 },
  { name: 'M4-follow-1m', scale: S.follow, session: 3, round: '1m', count: 6 },
  { name: 'M4-follow-3m', scale: S.follow, session: 3, round: '3m', count: 6 }
];
const actor = (role = 'visitor') => ({ role, subject: role === 'visitor' ? 'v' : 'c', aud: 'xg-assessment',
  auth_method: role === 'visitor' ? 'wechat-cloud' : 'counselor-edit', demo: false, exp: Date.now() + 3600000 });
const answersFor = (basis) => Object.fromEntries(basis.items.filter((i) => i.applicable).map((i) => [i.code,
  i.item_type === 'text' ? ' 保留原文\n反馈 ' : i.item_type === 'single_choice' ? i.options[0].value : 6]));

async function fixture(scenario) {
  const db = memoryAssessmentStore();
  let time = Date.now();
  const repo = createAssessmentRepository(db, { now: () => new Date(time).toISOString() });
  const provenance = createProvenanceRepository(db);
  const consent = createConsentRepository(db);
  const flow = createEventLifecycle(db, consent, { now: () => time });
  const who = actor(scenario.scale === S.pro ? 'counselor' : 'visitor');
  await db.transaction((tx) => tx.put(C.visitors, 'v', { visitor_id: 'v', provider: 'wechat-cloud' }));
  for (const scope of ['assessment', 'followup']) {
    await consent.publishPolicy({ scope, version: 'test-v1', title: 'TEST ONLY', content: 'Synthetic test consent.', published_by: 'test', expected_revision: 0 });
    const state = await consent.getStatus('v', scope);
    await consent.decide(actor(), { scope, version: state.required_version, document_hash: state.required_document.content_hash,
      agreed: true, channel: 'web', client_event_id: `grant-${scope}`, expected_revision: 0 });
  }
  await repo.createMatch({ match_id: 'case', visitor_id: 'v', counselor_id: 'c', assessment_id: 'intake' });
  if (scenario.optional) await provenance.setCaseConfig('case', { optional_enabled: true, focus_text: '本周期关注点', expected_revision: 0, changed_by: 'c' });
  if (scenario.scale === S.follow) { await repo.closeMatch('case', scenario.session); time += 100 * 86400000; }
  const { event } = await flow.start(who, { match_id: 'case', scale_code: scenario.scale, session_no: scenario.session,
    follow_round: scenario.round || '', client_event_id: 'attempt' });
  return { db, repo, provenance, consent, flow, who, event, basis: event.basis };
}
function rejected(basis, input, code, field) {
  const result = processAnswers(basis, input, 600000);
  assert.equal(result.valid, false);
  assert.equal(result.error.code, code);
  assert.equal(result.error.field, field);
  assert.equal('scores' in result, false);
  assert.equal('answers' in result, false);
}

for (const scenario of scenarios) {
  test(`T11 ${scenario.name}: each required item rejects missing/null without filling defaults`, async () => {
    const { basis } = await fixture(scenario);
    const answers = answersFor(basis);
    assert.equal(Object.keys(answers).length, scenario.count);
    for (const code of Object.keys(answers)) {
      const missing = { ...answers }; delete missing[code];
      for (const input of [missing, { ...answers, [code]: null }, { ...answers, [code]: undefined }]) {
        rejected(basis, input, 'XG_MISSING_ITEM', code);
      }
    }
    const before = structuredClone({ basis, answers });
    const result = processAnswers(basis, answers, 600000);
    assert.equal(result.valid, true);
    assert.deepEqual(result.answers, answers);
    assert.deepEqual({ basis, answers }, before);
  });
  test(`T11 ${scenario.name}: every slider accepts 0/10 and rejects coercion, fractions and overflow`, async () => {
    const { basis } = await fixture(scenario);
    const answers = answersFor(basis);
    for (const item of basis.items.filter((i) => i.applicable && i.item_type === 'slider')) {
      for (const value of [0, 10]) assert.equal(validateAnswers(basis, { ...answers, [item.code]: value }).valid, true);
      for (const value of [-1, 11, 0.5, 9.999, '0', '10', '', ' ', true, false, [], {}, NaN, Infinity, -Infinity]) {
        rejected(basis, { ...answers, [item.code]: value }, 'XG_VALUE_RANGE', item.code);
      }
    }
  });
}

test('T11 matrix includes all seven cards and all 42 published item codes', async () => {
  const codes = new Set(), cards = new Set();
  for (const scenario of scenarios) {
    const { basis } = await fixture(scenario);
    cards.add(basis.card.scale_code);
    for (const item of basis.items) codes.add(item.code);
  }
  assert.equal(cards.size, 7); assert.equal(codes.size, 42);
  assert.deepEqual([...codes].sort(), catalog.items.map((i) => i.code).sort());
});

test('T11 answers must be an own-property object; unknown/cross-card keys are never ignored', async () => {
  const { basis } = await fixture(scenarios[0]);
  for (const input of [null, undefined, [], 'answers', 1, true, Object.create({ s1: 6 })]) {
    rejected(basis, input, 'XG_BAD_ANSWERS', 'answers');
  }
  for (const code of ['f1', 's8', 'S1', 's1 ', '__proto__', 'constructor', '$set']) {
    const input = JSON.parse(JSON.stringify(answersFor(basis)));
    Object.defineProperty(input, code, { value: null, enumerable: true });
    rejected(basis, input, 'XG_UNKNOWN_ITEM', 'answers');
  }
});

test('T11 both choice questions use exact numeric option values', async () => {
  for (const [scenario, code, allowed] of [[scenarios[0], 'd1', [0, 1, 2]], [scenarios[5], 'p6', [0, 5, 10]]]) {
    const { basis } = await fixture(scenario), answers = answersFor(basis);
    assert.deepEqual(basis.items.find((i) => i.code === code).options.map((o) => o.value), allowed);
    for (const value of allowed) assert.equal(validateAnswers(basis, { ...answers, [code]: value }).valid, true);
    for (const value of [...allowed.map(String), -1, 3, 11, 0.5, true, false, [], {}, NaN, Infinity]) {
      rejected(basis, { ...answers, [code]: value }, 'XG_VALUE_RANGE', code);
    }
  }
});

test('T11 first-session p6 allows omission/null only and never writes a fabricated answer', async () => {
  const { basis } = await fixture(scenarios[4]), answers = answersFor(basis);
  for (const input of [answers, { ...answers, p6: null }]) {
    const result = processAnswers(basis, input, 600000);
    assert.equal(result.valid, true); assert.equal(Object.hasOwn(result.answers, 'p6'), false);
    assert.equal(result.scores.total, null); assert.equal(result.scores.pct, null);
  }
  for (const value of [0, 5, 10, '', false, [], {}]) rejected(basis, { ...answers, p6: value }, 'XG_ITEM_NOT_APPLICABLE', 'p6');
});

test('T11 text is required, nonblank, bounded and preserved without coercion or trimming', async () => {
  const { basis } = await fixture(scenarios[7]), answers = answersFor(basis);
  for (const value of ['', ' \n\t\u3000', 0, false, [], {}, '字'.repeat(2001), '😀'.repeat(1001)]) {
    rejected(basis, { ...answers, o1: value }, 'XG_VALUE_RANGE', 'o1');
  }
  for (const value of ['字', '字'.repeat(2000), '😀'.repeat(1000), ' 原文\n保留 ', '<script>plain text</script>']) {
    const result = processAnswers(basis, { ...answers, o1: value }, 600000);
    assert.equal(result.valid, true); assert.equal(result.answers.o1, value);
    assert.equal(result.scores.total, 18);
  }
});

test('T11 optional module requirements remain frozen in both toggle directions', async () => {
  for (const scenario of [scenarios[1], scenarios[2]]) {
    const f = await fixture(scenario);
    await f.provenance.setCaseConfig('case', { optional_enabled: !scenario.optional,
      focus_text: '新的关注点', expected_revision: scenario.optional ? 1 : 0, changed_by: 'c' });
    const answers = answersFor(f.basis);
    if (scenario.optional) {
      for (const code of ['s8', 's9', 's10']) {
        const missing = { ...answers }; delete missing[code];
        const bad = await f.flow.submit(f.who, { match_id: 'case', event_id: f.event.event_id, request_id: `missing-${code}`, answers: missing });
        assert.equal(bad.error.code, 'XG_MISSING_ITEM'); assert.equal(bad.error.field, code);
      }
    } else {
      for (const code of ['s8', 's9', 's10']) {
        const bad = await f.flow.submit(f.who, { match_id: 'case', event_id: f.event.event_id, request_id: `extra-${code}`, answers: { ...answers, [code]: null } });
        assert.equal(bad.error.code, 'XG_UNKNOWN_ITEM');
      }
    }
    const saved = await f.flow.submit(f.who, { match_id: 'case', event_id: f.event.event_id, request_id: 'correct', answers });
    assert.equal(saved.event.status, 'submitted'); assert.deepEqual(saved.event.basis, f.basis);
    assert.equal(saved.event.scores.stability_total, scenario.optional ? 18 : null);
  }
});

test('T11 form constraints come from the same validator and unknown question types fail closed', async () => {
  for (const scenario of [scenarios[0], scenarios[4], scenarios[7]]) {
    const { event, basis } = await fixture(scenario), form = formView(event);
    for (const item of form.items) {
      if (item.item_type === 'slider') assert.deepEqual(item.validation, { min: 0, max: 10, integer: true });
      if (item.item_type === 'single_choice') assert.deepEqual(item.validation.values, item.options.map((o) => o.value));
      if (item.item_type === 'text') assert.deepEqual(item.validation, { max_length: 2000, non_blank: true, length_unit: 'utf16' });
    }
    const broken = structuredClone(basis); broken.items[0].item_type = 'unknown';
    assert.throws(() => validateAnswers(broken, answersFor(basis)), { code: 'XG_BASIS_INVALID' });
  }
});

test('T11 valid low-duration/zero-variance responses remain accepted with quality flags', async () => {
  const { basis } = await fixture(scenarios[1]);
  for (const value of [0, 5, 10]) {
    const result = processAnswers(basis, Object.fromEntries(basis.items.map((i) => [i.code, value])), 0);
    assert.equal(result.valid, true); assert.equal(result.quality_flag, 'low');
  }
});

test('T11 request hashing preserves T10 hashes and distinguishes nonfinite numbers from null/strings', () => {
  for (const value of [{ answers: { s2: 0, s1: 10 }, duration_ms: null }, { answers: [null, true, '文本'] }, { answers: false }]) {
    assert.equal(requestHash(value), contentHash(value));
  }
  const values = [null, NaN, Infinity, -Infinity, 'NaN', 'Infinity', '-Infinity'];
  assert.equal(new Set(values.map((value) => requestHash({ answers: { s1: value } }))).size, values.length);
  assert.throws(() => contentHash({ s1: Infinity }), { code: 'XG_BASIS_INVALID' });
});

async function httpFixture(t, scenario) {
  const f = await fixture(scenario);
  const secret = 't11-test-session';
  const store = { assessment: f.repo, provenance: f.provenance, lifecycle: f.flow, consent: f.consent,
    identity: createIdentityRepository(f.db), async list() { return []; },
    async findById(_table, id) { return id === 'c' ? { id, is_active: true, review_status: 'approved' } : null; } };
  const server = http.createServer(createRequestHandler({ store, sessionSecret: secret }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  async function post(answers, request_id, raw) {
    const body = { match_id: 'case', event_id: f.event.event_id, request_id, answers };
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/xg/events`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${signSession(f.who, secret)}` },
      body: raw === undefined ? JSON.stringify(body) : raw });
    return { status: response.status, body: await response.json() };
  }
  return { ...f, post };
}

for (const scenario of scenarios) {
  test(`T11 HTTP ${scenario.name}: rejection is durable, unscored, replayable and correctable`, async (t) => {
    const f = await httpFixture(t, scenario), answers = answersFor(f.basis);
    const initial = f.db.snapshot();
    const code = Object.keys(answers)[0], missing = { ...answers }; delete missing[code];
    const bad = await f.post(missing, 'bad');
    assert.equal(bad.status, 422); assert.equal(bad.body.error.field, code);
    const rejectedEvent = await f.db.get(C.events, f.event.event_id);
    assert.equal(rejectedEvent.status, 'rejected'); assert.deepEqual(rejectedEvent.scores, {}); assert.deepEqual(rejectedEvent.raw_answers, {});
    for (const collection of [C.submissions, C.baselines, C.ends]) assert.deepEqual(f.db.snapshot()[collection], initial[collection]);
    const snapshot = f.db.snapshot();
    assert.equal((await f.post(missing, 'bad')).body.replayed, true);
    assert.deepEqual(f.db.snapshot(), snapshot);
    assert.equal((await f.post(answers, 'bad')).status, 409);
    const saved = await f.post(answers, 'correct'); assert.equal(saved.status, 201);
    const event = await f.db.get(C.events, f.event.event_id);
    assert.equal(event.status, 'submitted'); assert.equal(event.event_revision, 3);
    assert.deepEqual(event.raw_answers, answers); assert.deepEqual(event.basis, f.basis);
    assert.equal(f.db.snapshot()[C.submissions].size, 1);
    assert.equal(f.db.snapshot()[C.eventTransitions].size, 3);
    assert.equal(f.db.snapshot()[C.requestReceipts].size, 3);
    if (f.who.role === 'visitor') for (const field of ['scores', 'total', 'raw_answers', 'basis']) assert.equal(field in saved.body, false);
  });
}

test('T11 HTTP JSON numeric overflow returns durable 422, retains key identity and permits correction', async (t) => {
  const f = await httpFixture(t, scenarios[0]), answers = answersFor(f.basis);
  const raw = JSON.stringify({ match_id: 'case', event_id: f.event.event_id, request_id: 'overflow', answers: { ...answers, s1: 'OVERFLOW' } }).replace('"OVERFLOW"', '1e400');
  const bad = await f.post(null, null, raw);
  assert.equal(bad.status, 422); assert.equal(bad.body.error.code, 'XG_VALUE_RANGE'); assert.equal(bad.body.error.field, 's1');
  assert.equal((await f.post(null, null, raw)).body.replayed, true);
  assert.equal((await f.post({ ...answers, s1: null }, 'overflow')).status, 409);
  assert.equal((await f.db.get(C.events, f.event.event_id)).status, 'rejected');
  assert.equal((await f.post(answers, 'correct')).status, 201);
});

test('T11 HTTP malformed JSON is a 400 without state changes; wrong answer shapes are durable 422', async (t) => {
  const f = await httpFixture(t, scenarios[0]);
  const before = f.db.snapshot();
  assert.equal((await f.post(null, null, '{broken')).status, 400);
  assert.deepEqual(f.db.snapshot(), before);
  for (const [i, answers] of [null, [], 'wrong', 1, false].entries()) {
    const bad = await f.post(answers, `shape-${i}`);
    assert.equal(bad.status, 422); assert.equal(bad.body.error.code, 'XG_BAD_ANSWERS');
  }
  assert.equal(f.db.snapshot()[C.submissions].size, 0);
});
