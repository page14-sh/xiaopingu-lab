const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createAssessmentRepository } = require('./repository');
const { createConsentRepository } = require('./consent');
const { createEventLifecycle } = require('./event-lifecycle');
const { createFollowupRepository } = require('./followups');
const { addCalendarMonths, jobId } = require('./followup-schedule');
const { createIdentityRepository } = require('./identity-repository');
const { createRolloutRepository } = require('./rollout');
const { memoryAssessmentStore } = require('./test-support');
const { COLLECTIONS: C, SCALES: S } = require('./model');
const { createRequestHandler, signSession } = require('../app');
const { dispatchFollowups } = require('../../../scripts/dispatch-followups.cjs');
const DAY = 86400000;
const actor = (role = 'visitor', subject = role === 'visitor' ? 'v' : role === 'counselor' ? 'c' : 'admin') => ({ role, subject,
  aud: 'xg-assessment', demo: false, exp: Date.now() + 3600000,
  auth_method: role === 'visitor' ? 'wechat-cloud' : role === 'counselor' ? 'counselor-edit' : 'admin-password' });
async function fixture({ grant = true } = {}) {
  let time = Date.parse('2026-01-31T01:00:00.000Z'), serial = 0;
  const db = memoryAssessmentStore(), repo = createAssessmentRepository(db, { now: () => new Date(time).toISOString() });
  const consent = createConsentRepository(db, { now: () => new Date(time).toISOString() });
  const followups = createFollowupRepository(db, { now: () => time }), flow = createEventLifecycle(db, consent, { now: () => time });
  const rollout = createRolloutRepository(db);
  await db.transaction((tx) => tx.put(C.visitors, 'v', { visitor_id: 'v', provider: 'wechat-cloud' }));
  for (const scope of ['assessment','followup']) await consent.publishPolicy({ scope, version: 'test', title: 'TEST', content: 'Synthetic only.', published_by: 'test', expected_revision: 0 });
  async function sign(scope = 'followup', agreed = true) {
    const state = await consent.getStatus('v', scope);
    return consent.decide(actor(), { scope, version: agreed ? state.required_version : state.version,
      document_hash: agreed ? state.required_document.content_hash : state.document_hash,
      agreed, channel: 'web', client_event_id: `consent-${++serial}`, expected_revision: state.revision });
  }
  await sign('assessment'); if (grant) await sign();
  await repo.createMatch({ match_id: 'case', visitor_id: 'v', counselor_id: 'c', assessment_id: 'intake' });
  async function start(round = '1m', scale = S.follow, session = 3) {
    return (await flow.start(actor(), { match_id: 'case', scale_code: scale, session_no: session, follow_round: scale === S.follow ? round : '', client_event_id: `attempt-${++serial}` })).event;
  }
  async function submit(event, answers) {
    const value = answers || Object.fromEntries(event.basis.items.filter((i) => i.applicable).map((i) => [i.code, i.item_type === 'text' ? 'test' : i.item_type === 'single_choice' ? 0 : 6]));
    return flow.submit(actor(), { match_id: event.match_id, event_id: event.event_id, request_id: `submit-${++serial}`, answers: value });
  }
  async function configure(patch) { const state = await rollout.get(); return rollout.update(actor('admin'), { expected_revision: state.revision, patch, reason: 'test' }); }
  return { db, repo, consent, followups, flow, rollout, sign, start, submit, configure,
    at(value) { time = typeof value === 'number' ? value : Date.parse(value); }, advance(ms) { time += ms; }, now: () => time };
}

for (const [input, months, expected] of [
  ['2026-01-31T01:00:00.000Z',1,'2026-02-28T01:00:00.000Z'],
  ['2026-01-31T01:00:00.000Z',3,'2026-04-30T01:00:00.000Z'],
  ['2028-01-31T01:00:00.000Z',1,'2028-02-29T01:00:00.000Z'],
  ['2026-11-30T15:59:59.123Z',3,'2027-02-28T15:59:59.123Z'],
  ['2026-01-30T16:00:00.000Z',1,'2026-02-27T16:00:00.000Z']
]) test(`T16 calendar Shanghai ${input} +${months}m`, () => assert.equal(addCalendarMonths(input, months), expected));

test('T16 closing atomically creates exactly two immutable round schedules and preserves repeat close', async () => {
  const f = await fixture(); const closed = await f.repo.closeMatch('case', 3);
  assert.deepEqual(closed.followup_due, { '1m': '2026-02-28T01:00:00.000Z', '3m': '2026-04-30T01:00:00.000Z' });
  assert.equal(f.db.snapshot()[C.followupJobs].size, 2);
  assert.equal(f.db.snapshot()[C.notificationTasks].size, 0);
  f.advance(100 * DAY); const before = f.db.snapshot();
  assert.deepEqual(await f.repo.closeMatch('case', 3), closed); assert.deepEqual(f.db.snapshot(), before);
  await assert.rejects(f.repo.closeMatch('case', 4), { code: 'XG_ALREADY_CLOSED' });
});

test('T16 competing close calls cannot duplicate schedules or move their dates', async () => {
  const f = await fixture();
  const closed = await Promise.all(Array.from({ length: 10 }, () => f.repo.closeMatch('case', 3)));
  assert.ok(closed.every((m) => m.closed_at === closed[0].closed_at)); assert.equal(f.db.snapshot()[C.followupJobs].size, 2);
});

for (const collection of [C.followupJobs,C.ends]) {
  test(`T16 close failure in ${collection} rolls back cycle, pair lock and both schedules`, async () => {
    const f = await fixture(), before = f.db.snapshot(); f.db.failNextWriteTo(collection);
    await assert.rejects(f.repo.closeMatch('case', 3), /Injected storage failure/);
    assert.deepEqual(f.db.snapshot(), before); assert.equal((await f.repo.getMatch('case')).status, 'active');
    await f.repo.closeMatch('case', 3); assert.equal(f.db.snapshot()[C.followupJobs].size, 2);
  });
}

test('T16 early followup is blocked; exact due instant opens only the appropriate round', async () => {
  const f = await fixture(), closed = await f.repo.closeMatch('case', 3);
  f.at(Date.parse(closed.followup_due['1m']) - 1);
  await assert.rejects(f.start('1m'), { code: 'XG_FOLLOWUP_NOT_DUE' });
  assert.equal((await f.followups.dispatchDue()).scanned, 0);
  assert.equal((await f.followups.prompts(actor(), 'case')).filter((p) => p.scale_code === S.follow).length, 0);
  f.advance(1); assert.equal((await f.start('1m')).follow_round, '1m');
  await assert.rejects(f.start('3m'), { code: 'XG_FOLLOWUP_NOT_DUE' });
  assert.deepEqual((await f.followups.prompts(actor(), 'case')).filter((p) => p.scale_code === S.follow).map((p) => p.follow_round), ['1m']);
});

test('T16 due scan queues a durable task without marking delivery success; repeats do not duplicate', async () => {
  const f = await fixture(), closed = await f.repo.closeMatch('case', 3); f.at(closed.followup_due['1m']);
  const result = await f.followups.dispatchDue(); assert.equal(result.results[0].outcome, 'queued'); assert.equal(result.errors.length, 0);
  const task = await f.db.get(C.notificationTasks, jobId('case','1m'));
  assert.equal(task.status, 'queued'); assert.equal(task.attempt_count, 0); assert.deepEqual(task.channels, ['miniprogram','inapp']);
  const profile = (await f.repo.getProfiles('case')).end;
  assert.ok(profile.follow_1m_queued_at); assert.equal(profile.follow_1m_sent_at, null); assert.equal(profile.follow_1m_result, null);
  const before = f.db.snapshot(); assert.equal((await f.followups.dispatchDue()).scanned, 0); assert.deepEqual(f.db.snapshot(), before);
  f.advance(DAY); assert.equal((await f.followups.dispatchDue()).results[0].outcome, 'already_queued');
  assert.equal(f.db.snapshot()[C.notificationTasks].size, 1); assert.equal((await f.db.get(C.notificationTasks, task.task_id)).revision, 1);
});

test('T16 concurrent scans enqueue at most one task per round', async () => {
  const f = await fixture(), closed = await f.repo.closeMatch('case', 3); f.at(closed.followup_due['1m']);
  await Promise.all(Array.from({ length: 10 }, () => f.followups.dispatchDue()));
  assert.equal(f.db.snapshot()[C.notificationTasks].size, 1); assert.equal((await f.db.get(C.notificationTasks, jobId('case','1m'))).revision, 1);
});

test('T16 absent consent blocks due enqueue, and later consent resumes the original plan', async () => {
  const f = await fixture({ grant: false }), closed = await f.repo.closeMatch('case', 3); f.at(closed.followup_due['1m']);
  assert.equal((await f.followups.dispatchDue()).results[0].outcome, 'blocked'); assert.equal(f.db.snapshot()[C.notificationTasks].size, 0);
  assert.deepEqual(await f.followups.prompts(actor(), 'case'), []);
  await f.sign(); f.advance(DAY);
  assert.equal((await f.followups.dispatchDue()).results[0].outcome, 'queued');
  assert.equal((await f.db.get(C.followupJobs, jobId('case','1m'))).due_at, closed.followup_due['1m']);
});

test('T16 consent withdrawal blocks open forms immediately and queued work on recheck; regrant reuses task ID', async () => {
  const f = await fixture(), closed = await f.repo.closeMatch('case', 3); f.at(closed.followup_due['1m']);
  await f.followups.dispatchDue(); const event = await f.start(); await f.sign('followup', false);
  assert.deepEqual(await f.followups.prompts(actor(), 'case'), []);
  await assert.rejects(f.submit(event), { code: 'XG_CONSENT_REQUIRED' });
  await assert.rejects(f.start(), { code: 'XG_CONSENT_REQUIRED' });
  f.advance(DAY); assert.equal((await f.followups.dispatchDue()).results[0].outcome, 'blocked');
  assert.equal((await f.db.get(C.notificationTasks, jobId('case','1m'))).status, 'blocked');
  await f.sign(); f.advance(DAY); await f.followups.dispatchDue();
  assert.equal(f.db.snapshot()[C.notificationTasks].size, 1); assert.equal((await f.db.get(C.notificationTasks, jobId('case','1m'))).status, 'queued');
});

test('T16 a new required consent version blocks scheduling until explicitly signed', async () => {
  const f = await fixture(), closed = await f.repo.closeMatch('case', 3);
  await f.consent.publishPolicy({ scope: 'followup', version: 'new', title: 'TEST', content: 'New synthetic consent.', published_by: 'test', expected_revision: 1 });
  f.at(closed.followup_due['1m']); assert.equal((await f.followups.dispatchDue()).results[0].outcome, 'blocked');
  await f.sign(); f.advance(DAY); await f.followups.dispatchDue();
  assert.equal((await f.db.get(C.notificationTasks, jobId('case','1m'))).consent_ref.version, 'new');
});

test('T16 collection pause defers a due round, but reminder emergency stop alone does not cancel followup collection', async () => {
  const f = await fixture(), closed = await f.repo.closeMatch('case', 3); f.at(closed.followup_due['1m']);
  await f.configure({ collection_paused: true, emergency_stop: true });
  assert.equal((await f.followups.dispatchDue()).results[0].reason, 'XG_COLLECTION_PAUSED');
  assert.equal(f.db.snapshot()[C.notificationTasks].size, 0);
  await f.configure({ collection_paused: false }); f.advance(DAY);
  assert.equal((await f.followups.dispatchDue()).results[0].outcome, 'queued');
});

test('T16 notification enqueue failure is reported and rolls back the inspection so a retry can recover', async () => {
  const f = await fixture(), closed = await f.repo.closeMatch('case', 3); f.at(closed.followup_due['1m']);
  const before = f.db.snapshot(); f.db.failNextWriteTo(C.notificationTasks);
  const failed = await f.followups.dispatchDue(); assert.equal(failed.errors.length, 1); assert.deepEqual(f.db.snapshot(), before);
  assert.equal((await f.followups.dispatchDue()).results[0].outcome, 'queued');
});

test('T16 successful followup atomically completes its schedule and cancels unsent work', async () => {
  const f = await fixture(), closed = await f.repo.closeMatch('case', 3); f.at(closed.followup_due['1m']); await f.followups.dispatchDue();
  const event = await f.start(); const before = f.db.snapshot(); f.db.failNextWriteTo(C.followupJobs);
  await assert.rejects(f.submit(event), /Injected storage failure/); assert.deepEqual(f.db.snapshot(), before);
  await f.submit(event);
  assert.equal((await f.db.get(C.followupJobs, jobId('case','1m'))).status, 'completed');
  assert.equal((await f.db.get(C.notificationTasks, jobId('case','1m'))).status, 'cancelled');
  assert.equal((await f.followups.prompts(actor(), 'case')).some((p) => p.follow_round === '1m'), false);
  f.advance(DAY); assert.equal((await f.followups.dispatchDue()).scanned, 0);
});

test('T16 rejection and abandon leave the round available for a fresh attempt', async () => {
  const f = await fixture(), closed = await f.repo.closeMatch('case', 3); f.at(closed.followup_due['1m']);
  const event = await f.start(); assert.equal((await f.submit(event, {})).statusCode, 422);
  await f.flow.abandon(actor(), { match_id: 'case', event_id: event.event_id, request_id: 'leave' });
  assert.ok((await f.followups.prompts(actor(), 'case')).some((p) => p.follow_round === '1m'));
  assert.notEqual((await f.start()).event_id, event.event_id);
});

test('T16 3m is independent from 1m and both remain attached to the old cycle after rematching', async () => {
  const f = await fixture(), closed = await f.repo.closeMatch('case', 3);
  await f.repo.createMatch({ match_id: 'new', visitor_id: 'v', counselor_id: 'new-c', assessment_id: 'new-intake', previous_match_id: 'case' });
  const before = await f.repo.getProfiles('new'); f.at(closed.followup_due['3m']);
  const result = await f.followups.dispatchDue(); assert.equal(result.results.filter((r) => r.outcome === 'queued').length, 2);
  for (const round of ['1m','3m']) {
    const task = await f.db.get(C.notificationTasks, jobId('case', round)); assert.equal(task.match_id, 'case'); assert.equal(task.counselor_id, 'c');
  }
  await f.submit(await f.start('3m')); assert.deepEqual(await f.repo.getProfiles('new'), before);
  assert.equal((await f.db.get(C.followupJobs, jobId('case','1m'))).status, 'queued');
  await assert.rejects(f.followups.prompts(actor('counselor','new-c'), 'case'), { code: 'XG_FORBIDDEN' });
});

test('T16 no delivery worker result is overwritten or treated as a new send', async () => {
  for (const status of ['sent','failed','processing','cancelled']) {
    const f = await fixture(), closed = await f.repo.closeMatch('case', 3); f.at(closed.followup_due['1m']); await f.followups.dispatchDue();
    const id = jobId('case','1m'), task = await f.db.get(C.notificationTasks, id);
    await f.db.transaction((tx) => tx.put(C.notificationTasks, id, { ...task, status, attempt_count: 3 }));
    f.advance(DAY); await f.followups.dispatchDue();
    assert.equal((await f.db.get(C.notificationTasks, id)).status, status); assert.equal((await f.db.get(C.notificationTasks, id)).attempt_count, 3);
  }
});

test('T16 bounded scans progress without offset skipping, including blocked jobs', async () => {
  const f = await fixture({ grant: false }), closed = await f.repo.closeMatch('case', 3); f.at(closed.followup_due['3m']);
  const first = await f.followups.dispatchDue({ limit: 1 }), second = await f.followups.dispatchDue({ limit: 1 });
  assert.equal(first.scanned, 1); assert.equal(second.scanned, 1); assert.notEqual(first.results[0].job_id, second.results[0].job_id);
  assert.equal((await f.followups.dispatchDue({ limit: 1 })).scanned, 0);
});

test('T16 active prompts use actual session numbers, separate consent and exclude successful cards', async () => {
  const f = await fixture(); assert.deepEqual((await f.followups.prompts(actor(), 'case')).map((p) => p.scale_code), [S.baseline]);
  await f.submit(await f.start('', S.baseline, 0));
  assert.deepEqual((await f.followups.prompts(actor(), 'case', { session_no: 1 })).map((p) => p.scale_code), [S.feel]);
  f.advance(8 * DAY);
  assert.deepEqual((await f.followups.prompts(actor(), 'case', { session_no: 1 })).map((p) => p.scale_code), [S.state,S.feel]);
  assert.deepEqual((await f.followups.prompts(actor(), 'case', { session_no: 5 })).map((p) => p.session_no), [5,5]);
  assert.deepEqual((await f.followups.prompts(actor('counselor'), 'case', { session_no: 5 })).map((p) => p.scale_code), [S.pro]);
  await f.submit(await f.start('', S.feel, 5));
  assert.deepEqual((await f.followups.prompts(actor(), 'case', { session_no: 5 })).map((p) => p.scale_code), [S.state]);
  await f.sign('followup', false);
  assert.deepEqual(await f.followups.prompts(actor(), 'case', { session_no: 5, scope: 'followup' }), []);
});

async function apiFixture(t, secrets = { matching: 'matching-test-only-secret-'.repeat(2), scheduler: 'scheduler-test-only-secret-'.repeat(2) }) {
  const f = await fixture(), sessionSecret = 'test-session-secret';
  const store = { assessment: f.repo, identity: createIdentityRepository(f.db), consent: f.consent, lifecycle: f.flow, followups: f.followups,
    async list() { return []; }, async findById(_table,id) { return { id, is_active: true, review_status: 'approved' }; } };
  const server = http.createServer(createRequestHandler({ store, sessionSecret, serviceSecrets: secrets }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, token, body, method = 'POST') {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  }
  return { ...f, base, secrets, request, session: (role) => signSession(actor(role), sessionSecret) };
}

test('T16 service HTTP separates matching and scheduler credentials from every user session', async (t) => {
  const f = await apiFixture(t), close = '/v1/xg/m4/close', dispatch = '/v1/xg/jobs/follow-dispatch';
  for (const token of [undefined, 'wrong', f.session('visitor'), f.session('counselor'), f.session('admin'), f.secrets.scheduler]) {
    assert.equal((await f.request(close, token, { match_id: 'case', session_no: 3 })).status, 401);
  }
  assert.equal((await f.request(dispatch, f.secrets.matching, {})).status, 401);
  assert.equal((await f.request(close, f.secrets.matching, { match_id: 'case', session_no: 3, closed_at: 'forged' })).status, 400);
  const closed = await f.request(close, f.secrets.matching, { match_id: 'case', session_no: 3 });
  assert.equal(closed.status, 200); assert.equal(closed.cache, 'no-store'); assert.equal(closed.body.follow_1m_due_at, '2026-02-28T01:00:00.000Z');
  assert.deepEqual((await f.request(close, f.secrets.matching, { match_id: 'case', session_no: 3 })).body, closed.body);
  assert.equal((await f.request(close, f.secrets.matching, { match_id: 'case', session_no: 4 })).status, 409);
  assert.equal((await f.request(dispatch, f.secrets.scheduler, { now: '2099-01-01' })).status, 400);
  assert.equal((await f.request(dispatch, f.secrets.scheduler, { limit: 101 })).status, 400);
  assert.equal((await f.request(dispatch, f.secrets.scheduler, undefined, 'GET')).status, 405);
  assert.equal((await f.request('/v1/xg/me', f.secrets.scheduler, undefined, 'GET')).status, 401);
  const prompts = await f.request('/v1/xg/prompts/next?match_id=case', f.session('visitor'), undefined, 'GET');
  assert.equal(prompts.status, 200); assert.deepEqual(prompts.body.prompts.map((p) => p.scale_code), [S.end,S.evaluation]);
});

test('T16 missing or shared service secrets fail closed without exposing credentials', async (t) => {
  for (const secrets of [{}, { matching: 'same-secret-'.repeat(4), scheduler: 'same-secret-'.repeat(4) }]) {
    const f = await apiFixture(t, secrets);
    const result = await f.request('/v1/xg/m4/close', secrets.matching, { match_id: 'case', session_no: 3 });
    assert.equal(result.status, 503); assert.equal(JSON.stringify(result.body).includes('same-secret'), false);
  }
});

test('T16 standalone scheduler invokes due work without any page request and drains bounded batches', async (t) => {
  const f = await apiFixture(t), closed = await f.repo.closeMatch('case', 3); f.at(closed.followup_due['3m']);
  const result = await dispatchFollowups({ apiBase: f.base, secret: f.secrets.scheduler, limit: 1, maxBatches: 5 });
  assert.equal(result.queued, 2); assert.equal(result.errors, 0); assert.equal(result.more_possible, false);
  assert.equal(f.db.snapshot()[C.notificationTasks].size, 2);
});

test('T16 scheduler client refuses unsafe targets, redirects, invalid config and infinite paging', async () => {
  const secret = 'test-only-secret-'.repeat(3); let calls = 0;
  const fetchImpl = async (_url, options) => { calls++; assert.equal(options.redirect, 'error'); return { ok: true, json: async () => ({ scanned: 1, results: [], errors: [], more_possible: true }) }; };
  const result = await dispatchFollowups({ apiBase: 'https://example.invalid', secret, maxBatches: 2, fetchImpl });
  assert.equal(calls, 2); assert.equal(result.more_possible, true);
  for (const apiBase of ['http://example.invalid', 'https://user:password@example.invalid', 'https://example.invalid?secret=x']) {
    await assert.rejects(dispatchFollowups({ apiBase, secret, fetchImpl }), /Invalid scheduler configuration/);
  }
});

test('T16 profile write failure rolls back enqueue and a corrupt task cannot be silently repurposed', async () => {
  const f = await fixture(), closed = await f.repo.closeMatch('case', 3); f.at(closed.followup_due['1m']);
  const before = f.db.snapshot(); f.db.failNextWriteTo(C.ends);
  assert.equal((await f.followups.dispatchDue()).errors.length, 1); assert.deepEqual(f.db.snapshot(), before);
  await f.followups.dispatchDue();
  const id = jobId('case','1m'), task = await f.db.get(C.notificationTasks, id);
  await f.db.transaction((tx) => tx.put(C.notificationTasks, id, { ...task, kind: 'other' }));
  f.advance(DAY); const corrupted = f.db.snapshot();
  assert.equal((await f.followups.dispatchDue()).errors[0].code, 'XG_SCOPE_MISMATCH');
  assert.deepEqual(f.db.snapshot(), corrupted);
});

test('T16 missing legacy schedules and tampered due dates fail closed instead of rescheduling', async () => {
  const f = await fixture();
  const match = await f.repo.getMatch('case');
  await f.db.transaction((tx) => tx.put(C.matches, 'case', { ...match, status: 'closed', closing_session_no: 3, closed_at: new Date(f.now()).toISOString() }));
  await assert.rejects(f.repo.closeMatch('case', 3), { code: 'XG_FOLLOWUP_SCHEDULE_MISSING' });
  assert.equal(f.db.snapshot()[C.followupJobs].size, 0);
  const g = await fixture(), closed = await g.repo.closeMatch('case', 3); g.at(closed.followup_due['1m']);
  const id = jobId('case','1m'), job = await g.db.get(C.followupJobs, id);
  await g.db.transaction((tx) => tx.put(C.followupJobs, id, { ...job, due_at: '2000-01-01T00:00:00.000Z' }));
  await assert.rejects(g.start(), { code: 'XG_FOLLOWUP_SCHEDULE_MISSING' });
  assert.equal((await g.followups.dispatchDue()).errors[0].code, 'XG_FOLLOWUP_SCHEDULE_MISSING');
  assert.equal(g.db.snapshot()[C.notificationTasks].size, 0);
});
