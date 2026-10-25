const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRequestHandler, signSession } = require('../app');
const { createAssessmentRepository } = require('./repository');
const { createConsentRepository } = require('./consent');
const { createProvenanceRepository, defaultVersionBundle } = require('./provenance');
const { createIdentityRepository } = require('./identity-repository');
const { createEventLifecycle, formView } = require('./event-lifecycle');
const { memoryAssessmentStore } = require('./test-support');
const { COLLECTIONS: C, SCALES: S } = require('./model');

const actor = (role = 'visitor', subject = role === 'visitor' ? 'v' : 'c') => ({ role, subject,
  aud: 'xg-assessment', demo: false, auth_method: role === 'visitor' ? 'wechat-cloud' : 'counselor-edit', exp: Date.now() + 3600000 });
function answersFor(event) {
  return Object.fromEntries(event.basis.items.filter((item) => item.applicable).map((item, index) => [item.code,
    item.item_type === 'text' ? '测试反馈' : item.item_type === 'single_choice' ? item.options[1].value : 4 + index % 5]));
}
async function fixture() {
  const db = memoryAssessmentStore();
  let time = Date.now();
  const repo = createAssessmentRepository(db, { now: () => new Date(time).toISOString() });
  const consent = createConsentRepository(db);
  const provenance = createProvenanceRepository(db);
  const flow = createEventLifecycle(db, consent, { now: () => time });
  await db.transaction(async (tx) => {
    for (const visitor_id of ['v', 'other']) await tx.put(C.visitors, visitor_id, { visitor_id, provider: 'wechat-cloud' });
  });
  for (const scope of ['assessment', 'followup']) await consent.publishPolicy({ scope, version: 'test-v1', title: 'TEST ONLY',
    content: 'Only for automated tests, not production consent.', published_by: 'test', expected_revision: 0 });
  let consentSerial = 0;
  async function sign(scope = 'assessment', agreed = true) {
    const status = await consent.getStatus('v', scope);
    return consent.decide(actor(), { scope, version: agreed ? status.required_version : status.version,
      document_hash: agreed ? status.required_document.content_hash : status.document_hash,
      agreed, channel: 'web', client_event_id: `consent-${++consentSerial}`, expected_revision: status.revision });
  }
  await sign('assessment'); await sign('followup');
  await repo.createMatch({ match_id: 'case', visitor_id: 'v', counselor_id: 'c', assessment_id: 'intake' });
  let attemptSerial = 0;
  const start = (scale = S.baseline, session = 0, principal = actor(), extra = {}) => flow.start(principal, {
    match_id: 'case', scale_code: scale, session_no: session, client_event_id: `attempt-${++attemptSerial}`, ...extra
  });
  const submit = (event, answers = answersFor(event), principal = actor()) => flow.submit(principal, { match_id: 'case', event_id: event.event_id, answers });
  return { db, repo, consent, provenance, flow, start, submit, sign, advance: (milliseconds) => { time += milliseconds; } };
}

test('started -> rejected -> submitted reuses event and frozen basis while retaining all transitions', async () => {
  const { start, submit, db, repo, advance } = await fixture();
  const initial = (await start()).event;
  const basis = structuredClone(initial.basis);
  const answers = answersFor(initial);
  delete answers.s3;
  const rejected = await submit(initial, answers);
  assert.equal(rejected.statusCode, 422);
  assert.equal(rejected.event.status, 'rejected');
  assert.equal(rejected.error.field, 's3');
  assert.equal(db.snapshot()[C.submissions].size, 0);
  assert.equal((await repo.getProfiles('case')).baseline, null);
  advance(80000);
  const submitted = await submit(initial);
  assert.equal(submitted.event.status, 'submitted');
  assert.equal(submitted.event.event_id, initial.event_id);
  assert.equal(submitted.event.event_revision, 3);
  assert.deepEqual(submitted.event.basis, basis);
  assert.equal(submitted.event.started_at, initial.started_at);
  assert.deepEqual(submitted.event.raw_answers, answersFor(initial));
  assert.equal((await repo.getProfiles('case')).baseline.original.total, submitted.event.scores.total);
  assert.deepEqual([...db.snapshot()[C.eventTransitions].values()].map((row) => row.to_status), ['started', 'rejected', 'submitted']);
});

test('rejection does not reserve a successful slot and a new attempt may submit instead', async () => {
  const { start, submit, db } = await fixture();
  const first = (await start()).event;
  await submit(first, {});
  const second = (await start()).event;
  assert.notEqual(first.event_id, second.event_id);
  await submit(second);
  await assert.rejects(submit(first), { code: 'XG_ALREADY_SUBMITTED' });
  assert.equal((await db.get(C.events, first.event_id)).status, 'rejected');
  assert.equal(db.snapshot()[C.submissions].size, 1);
});

test('start key resumes the same attempt and cannot be reused for a different card', async () => {
  const { flow, db } = await fixture();
  const request = { match_id: 'case', scale_code: S.baseline, session_no: 0, client_event_id: 'stable' };
  const first = await flow.start(actor(), request);
  const again = await flow.start(actor(), request);
  assert.equal(again.duplicated, true);
  assert.deepEqual(again.event.basis, first.event.basis);
  assert.equal(db.snapshot()[C.events].size, 1);
  await assert.rejects(flow.start(actor(), { ...request, scale_code: S.feel, session_no: 1 }), { code: 'XG_IDEMPOTENCY_CONFLICT' });
});

test('submission starts from an existing event; the start key never short-circuits valid submission', async () => {
  const { flow, start } = await fixture();
  await assert.rejects(flow.submit(actor(), { match_id: 'case', answers: {} }), { code: 'XG_BAD_PARAM' });
  const initial = (await start()).event;
  const result = await flow.submit(actor(), { match_id: 'case', event_id: initial.event_id,
    client_event_id: initial.client_event_id, answers: answersFor(initial) });
  assert.equal(result.event.status, 'submitted');
  assert.equal(result.duplicated, false);
});

test('successful answers are immutable and late abandon cannot overwrite them', async () => {
  const { start, submit, flow, db } = await fixture();
  const initial = (await start()).event;
  await submit(initial);
  const before = db.snapshot();
  await assert.rejects(flow.abandon(actor(), { match_id: 'case', event_id: initial.event_id, reason: 'page_leave' }), { code: 'XG_ALREADY_SUBMITTED' });
  await assert.rejects(submit(initial, { ...answersFor(initial), s1: 10 }), { code: 'XG_ALREADY_SUBMITTED' });
  assert.deepEqual(db.snapshot(), before);
  assert.equal((await submit(initial)).duplicated, true);
  assert.deepEqual(db.snapshot(), before);
});

test('abandoned is terminal; duplicate abandon is harmless and a fresh attempt is allowed', async () => {
  const { start, submit, flow, db } = await fixture();
  const initial = (await start()).event;
  await flow.abandon(actor(), { match_id: 'case', event_id: initial.event_id, reason: 'user_exit' });
  const before = db.snapshot();
  assert.equal((await flow.abandon(actor(), { match_id: 'case', event_id: initial.event_id, reason: 'user_exit' })).duplicated, true);
  assert.deepEqual(db.snapshot(), before);
  await assert.rejects(submit(initial), { code: 'XG_EVENT_ABANDONED' });
  const fresh = (await start()).event;
  assert.equal((await submit(fresh)).event.status, 'submitted');
});

test('rejected attempts can be abandoned without losing rejection history', async () => {
  const { start, submit, flow, db } = await fixture();
  const initial = (await start()).event;
  await submit(initial, {});
  await flow.abandon(actor(), { match_id: 'case', event_id: initial.event_id });
  assert.deepEqual([...db.snapshot()[C.eventTransitions].values()].map((row) => row.to_status), ['started', 'rejected', 'abandoned']);
  assert.equal(db.snapshot()[C.submissions].size, 0);
});

test('expired submission persists abandonment rather than creating scores or a successful slot', async () => {
  const { start, submit, advance, db } = await fixture();
  const initial = (await start()).event;
  advance(30 * 60 * 1000);
  const result = await submit(initial);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error.code, 'XG_EVENT_EXPIRED');
  assert.equal((await db.get(C.events, initial.event_id)).status, 'abandoned');
  assert.equal(db.snapshot()[C.submissions].size, 0);
  assert.equal(formView(result.event), null);
});

test('consent revoked while filling blocks submit but allows abandon; completed retries do not recollect', async () => {
  const { start, submit, sign, flow, db } = await fixture();
  const initial = (await start()).event;
  await sign('assessment', false);
  const before = db.snapshot();
  await assert.rejects(submit(initial), { code: 'XG_CONSENT_REQUIRED' });
  assert.deepEqual(db.snapshot(), before);
  await flow.abandon(actor(), { match_id: 'case', event_id: initial.event_id });
  await sign();
  const fresh = (await start()).event;
  await submit(fresh);
  await sign('assessment', false);
  const done = db.snapshot();
  assert.equal((await submit(fresh)).duplicated, true);
  assert.deepEqual(db.snapshot(), done);
});

test('a new consent version may be signed before submitting without recapturing the question basis', async () => {
  const { start, submit, consent, sign } = await fixture();
  const initial = (await start()).event;
  await consent.publishPolicy({ scope: 'assessment', version: 'test-v2', title: 'TEST ONLY', content: 'Second test version.', published_by: 'test', expected_revision: 1 });
  await assert.rejects(submit(initial), { code: 'XG_CONSENT_REQUIRED' });
  await sign();
  const result = await submit(initial);
  assert.equal(result.event.start_consent.version, 'test-v1');
  assert.equal(result.event.submission_consent.version, 'test-v2');
  assert.deepEqual(result.event.basis, initial.basis);
});

test('version/config changes while filling do not change required items, score denominator or displayed text', async () => {
  const { provenance, start, submit } = await fixture();
  await provenance.setCaseConfig('case', { optional_enabled: true, focus_text: '原主题', expected_revision: 0, changed_by: 'c' });
  const initial = (await start(S.state, 2)).event;
  const bundle = defaultVersionBundle();
  bundle.catalog.items[0].text = '新题目';
  await provenance.publishVersions({ ...bundle, item_version: 'new-items', published_by: 'test', expected_revision: 1 });
  await provenance.setCaseConfig('case', { optional_enabled: false, focus_text: '新主题', expected_revision: 1, changed_by: 'c' });
  const answers = Object.fromEntries(initial.basis.items.filter((item) => item.applicable).map((item) => [item.code, 10]));
  const result = await submit(initial, answers);
  assert.equal(result.event.scores.total, 70);
  assert.equal(result.event.scores.pct, 100);
  assert.equal(result.event.scores.stability_total, 30);
  assert.equal(result.event.basis.context.focus_text, '原主题');
  assert.equal(formView(initial).items.length, 10);
});

test('first-session p6 cannot be fabricated and complete pro totals remain null', async () => {
  const { start, submit } = await fixture();
  const counselor = actor('counselor');
  const initial = (await start(S.pro, 1, counselor)).event;
  const invalid = await submit(initial, { ...answersFor(initial), p6: 5 }, counselor);
  assert.equal(invalid.error.code, 'XG_ITEM_NOT_APPLICABLE');
  const valid = await submit(initial, answersFor(initial), counselor);
  assert.equal(valid.event.scores.total, null);
  assert.equal(valid.event.scores.pct, null);
  assert.equal(valid.event.raw_answers.p6, undefined);
});

test('a write failure rolls back consent anchors, audit, slot, event and profile together', async () => {
  const { start, submit, db } = await fixture();
  const initial = (await start()).event;
  const before = db.snapshot();
  db.failNextWriteTo(C.events);
  await assert.rejects(submit(initial), /Injected storage failure/);
  assert.deepEqual(db.snapshot(), before);
  assert.equal((await submit(initial)).event.status, 'submitted');
});

test('local simultaneous submit/abandon admits only a valid terminal state', async () => {
  const { start, submit, flow, db } = await fixture();
  const first = (await start()).event;
  const submitFirst = await Promise.allSettled([submit(first), flow.abandon(actor(), { match_id: 'case', event_id: first.event_id })]);
  assert.equal(submitFirst[0].status, 'fulfilled');
  assert.equal(submitFirst[1].reason.code, 'XG_ALREADY_SUBMITTED');
  const second = (await start(S.feel, 1)).event;
  const abandonFirst = await Promise.allSettled([flow.abandon(actor(), { match_id: 'case', event_id: second.event_id }), submit(second)]);
  assert.equal(abandonFirst[1].reason.code, 'XG_EVENT_ABANDONED');
  assert.equal((await db.get(C.events, first.event_id)).status, 'submitted');
  assert.equal((await db.get(C.events, second.event_id)).status, 'abandoned');
});

test('server elapsed time drives quality; client duration cannot override it', async () => {
  const { start, flow, advance } = await fixture();
  const initial = (await start()).event;
  advance(1000);
  const result = await flow.submit(actor(), { match_id: 'case', event_id: initial.event_id, answers: answersFor(initial), duration_ms: 999999 });
  assert.equal(result.event.duration_ms, 1000);
  assert.equal(result.event.client_duration_ms, 999999);
  assert.equal(result.event.quality_flag, 'low');
});

test('unsafe role, event reassignment and body identity injection cannot transition an attempt', async () => {
  const { start, submit, flow, db } = await fixture();
  const initial = (await start()).event;
  const before = db.snapshot();
  await assert.rejects(submit(initial, answersFor(initial), actor('visitor', 'other')), { code: 'XG_FORBIDDEN' });
  await assert.rejects(submit(initial, answersFor(initial), actor('counselor')), { code: 'XG_FORBIDDEN' });
  await assert.rejects(flow.submit(actor(), { match_id: 'case', event_id: initial.event_id, scale_code: S.state, answers: answersFor(initial) }), { code: 'XG_FORBIDDEN' });
  assert.deepEqual(db.snapshot(), before);
});

test('baseline recheck is limited to overdue pre-first-session use and preserves the original', async () => {
  const { start, submit, advance, repo } = await fixture();
  const baseline = (await start()).event;
  await submit(baseline);
  const original = (await repo.getProfiles('case')).baseline.original;
  await assert.rejects(start(S.state, 1), { code: 'XG_RECHECK_NOT_DUE' });
  advance(8 * 86400000);
  const recheck = (await start(S.state, 1)).event;
  await submit(recheck);
  const profile = (await repo.getProfiles('case')).baseline;
  assert.deepEqual(profile.original, original);
  assert.equal(profile.recheck.event_id, recheck.event_id);
});

test('HTTP start/reject/correct/submit chain returns only safe visitor fields and a durable rejection', async (t) => {
  const f = await fixture();
  const secret = 'lifecycle-http-test-secret';
  const store = { assessment: f.repo, consent: f.consent, lifecycle: f.flow, identity: createIdentityRepository(f.db), async list() { return []; } };
  const server = http.createServer(createRequestHandler({ store, sessionSecret: secret }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  async function post(path, body) {
    if (path !== '/events/start') body = { request_id: require('node:crypto').randomUUID(), ...body };
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/xg${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${signSession(actor(), secret)}` }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const started = await post('/events/start', { match_id: 'case', scale_code: S.baseline, session_no: 0, client_event_id: 'http-start' });
  assert.equal(started.status, 201);
  assert.equal(started.body.form.items.length, 13);
  assert.equal('rules' in started.body.form, false);
  assert.equal('basis' in started.body, false);
  const event = await f.repo.getEvent('case', started.body.event_id);
  assert.equal((await post('/events', { match_id: 'case', event_id: event.event_id, request_id: null, answers: {} })).status, 400);
  const bad = await post('/events', { match_id: 'case', event_id: event.event_id, request_id: 'http-rejected', answers: {} });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.status, 'rejected');
  assert.equal(bad.body.error.field, 's1');
  assert.equal((await f.repo.getEvent('case', event.event_id)).status, 'rejected');
  const valid = await post('/events', { match_id: 'case', event_id: event.event_id, answers: answersFor(event) });
  assert.equal(valid.status, 201);
  assert.equal(valid.body.saved, true);
  assert.equal(valid.body.status, 'submitted');
  assert.equal('total' in valid.body, false);
  assert.equal('scores' in valid.body, false);
  assert.equal('raw_answers' in valid.body, false);
  const old = await post('/events', { match_id: 'case', event_id: event.event_id, request_id: 'http-rejected', answers: {} });
  assert.equal(old.status, 422);
  assert.equal(old.body.status, 'submitted');
  assert.equal(old.body.request_status, 'rejected');
  assert.equal(old.body.replayed, true);
  assert.equal(old.body.request_revision, 2);
  assert.equal(old.body.revision, 3);
  assert.equal((await post('/events', { match_id: 'case', event_id: event.event_id, request_id: 'http-rejected', answers: answersFor(event) })).status, 409);
  assert.equal((await post('/events/abandon', { match_id: 'case', event_id: event.event_id, request_id: null })).status, 400);
  assert.equal((await post('/events/abandon', { match_id: 'case', event_id: event.event_id })).status, 409);
  assert.equal((await post('/events', { match_id: 'case', event_id: event.event_id, answers: answersFor(event) })).status, 200);
});

test('T10 explicit request key is immutable, canonical and atomically persisted', async () => {
  const { flow, start, db } = await fixture();
  const event = (await start()).event;
  const input = { match_id: 'case', event_id: event.event_id, request_id: 'submit-one', answers: answersFor(event), duration_ms: 100 };
  const first = await flow.submit(actor(), input);
  const before = db.snapshot();
  const reversed = Object.fromEntries(Object.entries(input.answers).reverse());
  const retry = await flow.submit(actor(), { ...input, answers: reversed });
  assert.equal(first.replayed, false);
  assert.equal(retry.replayed, true);
  assert.equal(retry.request_revision, 2);
  assert.deepEqual(db.snapshot(), before);
  await assert.rejects(flow.submit(actor(), { ...input, duration_ms: 101 }), { code: 'XG_IDEMPOTENCY_CONFLICT' });
  await assert.rejects(flow.submit(actor(), { ...input, answers: {} }), { code: 'XG_IDEMPOTENCY_CONFLICT' });
  const receipts = [...db.snapshot()[C.requestReceipts].values()];
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every((r) => !('answers' in r) && !('basis' in r) && r.completed_at));
});

test('T10 replay of rejected request after correction preserves current submitted state', async () => {
  const { flow, start, db } = await fixture();
  const event = (await start()).event;
  const input = { match_id: 'case', event_id: event.event_id, request_id: 'bad', answers: {} };
  assert.equal((await flow.submit(actor(), input)).statusCode, 422);
  await flow.submit(actor(), { ...input, request_id: 'corrected', answers: answersFor(event) });
  const before = db.snapshot();
  const retry = await flow.submit(actor(), input);
  assert.equal(retry.statusCode, 422);
  assert.equal(retry.request_status, 'rejected');
  assert.equal(retry.request_revision, 2);
  assert.equal(retry.event.status, 'submitted');
  assert.equal(retry.event.event_revision, 3);
  assert.deepEqual(db.snapshot(), before);
});

test('T10 ten identical requests produce one receipt and one successful slot', async () => {
  const { flow, db } = await fixture();
  const input = { match_id: 'case', scale_code: S.baseline, session_no: 0, client_event_id: 'ten' };
  const started = await Promise.all(Array.from({ length: 10 }, () => flow.start(actor(), input)));
  assert.equal(started.filter((r) => !r.replayed).length, 1);
  const event = started[0].event;
  const submissions = await Promise.all(Array.from({ length: 10 }, () => flow.submit(actor(), {
    match_id: 'case', event_id: event.event_id, request_id: 'ten-submit', answers: answersFor(event)
  })));
  assert.equal(submissions.filter((r) => !r.replayed).length, 1);
  const state = db.snapshot();
  assert.equal(state[C.events].size, 1);
  assert.equal(state[C.submissions].size, 1);
  assert.equal(state[C.baselines].size, 1);
  assert.equal(state[C.eventTransitions].size, 2);
  assert.equal(state[C.requestReceipts].size, 2);
});

test('T10 receipt failure rolls back slot/profile/event/audit and permits same-key retry', async () => {
  const { flow, start, db } = await fixture();
  const event = (await start()).event;
  const input = { match_id: 'case', event_id: event.event_id, request_id: 'rollback', answers: answersFor(event) };
  const before = db.snapshot();
  db.failNextWriteTo(C.requestReceipts);
  await assert.rejects(flow.submit(actor(), input), /Injected storage failure/);
  assert.deepEqual(db.snapshot(), before);
  assert.equal((await flow.submit(actor(), input)).event.status, 'submitted');
});

test('T10 same key across operations is allowed; changed abandonment reason conflicts', async () => {
  const { flow } = await fixture();
  const input = { match_id: 'case', scale_code: S.baseline, session_no: 0, client_event_id: 'same', request_id: 'same' };
  const { event } = await flow.start(actor(), input);
  const end = { match_id: 'case', event_id: event.event_id, request_id: 'same', reason: 'user_exit' };
  await flow.abandon(actor(), end);
  assert.equal((await flow.abandon(actor(), end)).replayed, true);
  await assert.rejects(flow.abandon(actor(), { ...end, reason: 'page_leave' }), { code: 'XG_IDEMPOTENCY_CONFLICT' });
  const replay = await flow.start(actor(), input);
  assert.equal(replay.event.status, 'abandoned');
  assert.equal(formView(replay.event), null);
});

test('T18 scheduler reaps started and rejected exactly at expiry without extending rejected TTL', async () => {
  const f = await fixture(); const first=(await f.start()).event, second=(await f.start()).event;
  f.advance(20*60000); await f.submit(second,{});
  assert.equal((await f.db.get(C.events,second.event_id)).expires_at,second.expires_at);
  await assert.rejects(f.flow.abandon(actor(),{match_id:'case',event_id:first.event_id,reason:'timeout'}),{code:'XG_EVENT_NOT_EXPIRED'});
  f.advance(10*60000-1);assert.equal((await f.flow.reapExpired()).scanned,0);
  f.advance(1);const result=await f.flow.reapExpired();assert.equal(result.results.filter(r=>r.outcome==='reaped').length,2);
  for(const initial of [first,second]){const e=await f.db.get(C.events,initial.event_id);assert.equal(e.status,'abandoned');assert.equal(e.duration_ms,30*60000);assert.equal(e.abandon_reason,'timeout');}
  const transitions=[...f.db.snapshot()[C.eventTransitions].values()].filter(r=>r.to_status==='abandoned');
  assert.equal(transitions.length,2);assert.ok(transitions.every(r=>r.initiator==='scheduler'));
  assert.equal((await f.flow.reapExpired()).scanned,0);
});

test('T18 concurrent reapers write one terminal revision and preserve client receipts',async()=>{
  const f=await fixture();const initial=(await f.start()).event;const receipts=f.db.snapshot()[C.requestReceipts];
  f.advance(86400000);const results=await Promise.all(Array.from({length:10},()=>f.flow.reapExpired()));
  assert.equal(results.flatMap(r=>r.results).filter(r=>r.outcome==='reaped').length,1);
  const state=f.db.snapshot();assert.equal(state[C.eventTransitions].size,2);assert.deepEqual(state[C.requestReceipts],receipts);
  const event=await f.db.get(C.events,initial.event_id);assert.equal(event.event_revision,2);assert.equal(event.duration_ms,30*60000);
  assert.equal(Date.parse(event.abandoned_at)-Date.parse(event.started_at),86400000);
  assert.equal(state[C.submissions].size,0);assert.equal(state[C.notificationTasks].size,0);
  const replay=await f.flow.start(actor(),{match_id:'case',scale_code:S.baseline,session_no:0,client_event_id:initial.client_event_id});
  assert.equal(replay.replayed,true);assert.equal(replay.event.status,'abandoned');assert.equal(formView(replay.event),null);
});

test('T18 stale expiry candidate cannot overwrite successful submission or explicit abandonment',async()=>{
  const f=await fixture();const first=(await f.start()).event, second=(await f.start(S.feel,1)).event;
  const candidates=[{_id:first.event_id},{_id:second.event_id}];
  await f.submit(first);await f.flow.abandon(actor(),{match_id:'case',event_id:second.event_id,reason:'user_exit'});
  f.advance(3600000);const before=f.db.snapshot();
  const flow=createEventLifecycle({...f.db,expiredEvents:async()=>candidates},f.consent,{now:()=>Date.parse(first.expires_at)+3600000});
  const result=await flow.reapExpired();assert.deepEqual(result.results.map(r=>r.outcome),['skipped','skipped']);assert.deepEqual(f.db.snapshot(),before);
});

test('T18 cleanup still runs after consent revocation, closed cycle and collection pause',async()=>{
  const f=await fixture();const initial=(await f.start()).event;await f.sign('assessment',false);await f.repo.closeMatch('case',1);
  const {createRolloutRepository}=require('./rollout');const rollout=createRolloutRepository(f.db);
  await rollout.update({...actor('admin','admin'),auth_method:'admin-password'},{expected_revision:0,patch:{collection_paused:true},reason:'Synthetic pause'});
  f.advance(3600000);const before=f.db.snapshot();const result=await f.flow.reapExpired();assert.equal(result.results[0].outcome,'reaped');
  const after=f.db.snapshot();for(const collection of [C.consentStates,C.followupJobs,C.notificationTasks,C.submissions,C.baselines])assert.deepEqual(after[collection],before[collection]);
  assert.equal((await f.db.get(C.events,initial.event_id)).status,'abandoned');
});

test('T18 failed expiry transaction rolls back event, audit and cycle and can retry',async()=>{
  const f=await fixture();const initial=(await f.start()).event;f.advance(3600000);const before=f.db.snapshot();
  f.db.failNextWriteTo(C.matches);const result=await f.flow.reapExpired();assert.deepEqual(result.errors,[{event_id:initial.event_id,code:'XG_REAP_FAILED'}]);
  assert.deepEqual(f.db.snapshot(),before);assert.equal((await f.flow.reapExpired()).results[0].outcome,'reaped');
});

test('T18 bounded expiry batches make progress and isolate per-record errors',async()=>{
  const f=await fixture();await f.start();await f.start();await f.start();f.advance(3600000);
  for(const limit of [0,101,1.2,'2'])await assert.rejects(f.flow.reapExpired({limit}),{code:'XG_BAD_PARAM'});
  f.db.failNextWriteTo(C.eventTransitions);const result=await f.flow.reapExpired({limit:2});
  assert.equal(result.errors.length,1);assert.equal(result.results.length,1);assert.equal(result.more_possible,true);
  const next=await f.flow.reapExpired({limit:2});assert.equal(next.results.length,2);assert.equal((await f.flow.reapExpired({limit:2})).scanned,0);
});

test('T18 scheduler HTTP requires dedicated credentials, rejects client time and runs independent scan CLI',async(t)=>{
  const f=await fixture();await f.start();await f.start();f.advance(3600000);
  const secret='expiry-http-test-secret',scheduler='scheduler-test-secret-'.repeat(3),matching='matching-test-secret-'.repeat(3);
  const store={assessment:f.repo,consent:f.consent,lifecycle:f.flow,identity:createIdentityRepository(f.db),async list(){return [];}};
  const server=http.createServer(createRequestHandler({store,sessionSecret:secret,serviceSecrets:{scheduler,matching}}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const apiBase=`http://127.0.0.1:${server.address().port}`;
  const request=(token,body={},method='POST')=>fetch(`${apiBase}/v1/xg/jobs/events-expire`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{})});
  for(const token of ['',matching,signSession(actor(),secret),signSession({...actor('admin','admin'),auth_method:'admin-password'},secret)])assert.equal((await request(token)).status,401);
  assert.equal((await request(scheduler,{},'GET')).status,405);
  for(const body of [{now:Date.now()},{event_id:'anything'},{limit:101}])assert.equal((await request(scheduler,body)).status,400);
  const {dispatchFollowups}=require('../../../scripts/dispatch-followups.cjs');
  const result=await dispatchFollowups({apiBase,secret:scheduler,limit:1,jobType:'expiry'});
  assert.equal(result.reaped,2);assert.equal(result.errors,0);assert.equal(result.batches,3);assert.equal(result.more_possible,false);
});
