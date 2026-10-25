const test = require('node:test');
const assert = require('node:assert/strict');
const { Db } = require('@cloudbase/database');
const { EJSON } = require('bson');
const { createCloudBaseAssessmentStore } = require('./cloudbase-store');
const { createAssessmentRepository } = require('./repository');
const { COLLECTIONS: C, SCALES: S } = require('./model');
const { createCloudBaseStore } = require('../app');
const { assessmentVersionSeed } = require('./test-support');
const { defaultVersionBundle } = require('./provenance');

// Exercise the INSTALLED SDK's request/response shapes, with its transport replaced.
// No cloud credentials/network. This is not a production transaction/concurrency test.
function sdkHarness(t) {
  const originalRequest = Db.reqClass;
  let documents = new Map();
  for (const { collection, id, record } of assessmentVersionSeed()) {
    documents.set(`${collection}/${id}`, { collection, record: { ...record, _id: id } });
  }
  const transactions = new Map();
  const calls = [];
  let serial = 0;
  let injected;
  class Request {
    async send(action, params = {}) {
      calls.push({ action, params: structuredClone(params) });
      if (injected?.action === action) {
        const result = injected.result;
        injected = null;
        return result;
      }
      if (action === 'database.startTransaction') {
        const transactionId = `tx-${++serial}`;
        transactions.set(transactionId, structuredClone(documents));
        return { transactionId };
      }
      if (action === 'database.commitTransaction') {
        documents = transactions.get(params.transactionId);
        transactions.delete(params.transactionId);
        return { requestId: 'commit' };
      }
      if (action === 'database.abortTransaction') {
        transactions.delete(params.transactionId);
        return { requestId: 'rollback' };
      }
      const source = params.transactionId ? transactions.get(params.transactionId) : documents;
      const filter = EJSON.parse(params.query);
      if (action === 'database.getDocument') {
        let rows = [...source.values()].filter((entry) => entry.collection === params.collectionName)
          .map((entry) => entry.record)
          .filter((row) => Object.entries(filter).every(([field, value]) => row[field] === value));
        rows.sort((a, b) => a.session_no - b.session_no || a._id.localeCompare(b._id));
        if (params.limit) rows = rows.slice(params.offset || 0, (params.offset || 0) + params.limit);
        return { data: { list: rows.map((row) => EJSON.stringify(row)) }, requestId: 'read' };
      }
      if (action === 'database.modifyDocument') {
        const id = filter._id;
        const key = `${params.collectionName}/${id}`;
        const existed = source.has(key);
        source.set(key, { collection: params.collectionName, record: { ...EJSON.parse(params.data), _id: id } });
        return { data: { updated: existed ? 1 : 0, upsert_id: existed ? undefined : id }, requestId: 'write' };
      }
      throw new Error(`Unexpected SDK request ${action}`);
    }
  }
  Db.reqClass = Request;
  t.after(() => { Db.reqClass = originalRequest; });
  const db = new Db({ env: 'offline-test' });
  return {
    db, calls, store: createCloudBaseAssessmentStore(db),
    inject(action, result) { injected = { action, result }; },
    seed(collection, record) { documents.set(`${collection}/${record._id}`, { collection, record }); }
  };
}

test('installed SDK persists a cycle and baseline and returns scoped profiles through the runtime store', async (t) => {
  const harness = sdkHarness(t);
  const runtimeStore = createCloudBaseStore(harness.db);
  const repo = runtimeStore.assessment;
  assert.ok(repo);
  await repo.createMatch({ match_id: 'cycle', visitor_id: 'visitor', counselor_id: 'counselor', assessment_id: 'assessment' });
  await repo.insertEvent({ match_id: 'cycle', event_id: 'baseline', scale_code: S.baseline,
    session_no: 0, status: 'submitted', scores: { total: 49 }, raw_answers: { s1: 7 } });
  const result = await repo.getProfiles('cycle');
  assert.equal(result.baseline.original.total, 49);
  assert.equal(result.baseline.match_id, 'cycle');
  assert.equal(result.end, null);
  assert.equal((await repo.getEvent('cycle', 'baseline')).visitor_id, 'visitor');
  const writes = harness.calls.filter((call) => call.action === 'database.modifyDocument');
  assert.ok(writes.length > 0);
  assert.ok(writes.every((call) => call.params.transactionId));
  assert.ok(writes.every((call) => !Object.hasOwn(EJSON.parse(call.params.data), '_id')));
});

test('installed SDK scopes every page in database and reads beyond the old 1000-row cap', async (t) => {
  const harness = sdkHarness(t);
  for (let i = 0; i < 1005; i++) {
    harness.seed(C.events, { _id: `a-${String(i).padStart(4, '0')}`, match_id: 'a', session_no: i });
    harness.seed(C.events, { _id: `b-${String(i).padStart(4, '0')}`, match_id: 'b', session_no: i });
  }
  const rows = await harness.store.eventsForMatch('a');
  assert.equal(rows.length, 1005);
  assert.ok(rows.every((row) => row.match_id === 'a'));
  assert.equal(harness.calls.length, 11);
  for (const call of harness.calls) {
    assert.equal(call.params.collectionName, C.events);
    assert.deepEqual(EJSON.parse(call.params.query), { match_id: 'a' });
    assert.equal(call.params.limit, 100);
  }
  const count = harness.calls.length;
  await assert.rejects(harness.store.eventsForMatch(undefined), { code: 'XG_BAD_PARAM' });
  assert.equal(harness.calls.length, count);
});

test('SDK error responses fail closed instead of being interpreted as missing documents or empty lists', async (t) => {
  const harness = sdkHarness(t);
  assert.equal(await harness.store.get(C.matches, 'absent'), null);
  for (const read of [
    () => harness.store.get(C.matches, 'absent'),
    () => harness.store.eventsForMatch('a')
  ]) {
    harness.inject('database.getDocument', { code: 'PERMISSION_DENIED', message: 'private platform detail' });
    await assert.rejects(read(), (error) => error.code === 'PERMISSION_DENIED' && !error.message.includes('private'));
  }
});

test('returned SDK write errors abort the transaction and preserve the original error code', async (t) => {
  const harness = sdkHarness(t);
  harness.inject('database.modifyDocument', { code: 'WRITE_DENIED' });
  await assert.rejects(harness.store.transaction((tx) => tx.put(C.matches, 'a', { match_id: 'a' })),
    { code: 'WRITE_DENIED' });
  assert.ok(harness.calls.some((call) => call.action === 'database.abortTransaction'));
  assert.equal(await harness.store.get(C.matches, 'a'), null);
});

test('a failed commit does not report a successful cycle or consume its pair lock', async (t) => {
  const harness = sdkHarness(t);
  const repo = createAssessmentRepository(harness.store);
  const input = { match_id: 'a', visitor_id: 'v', counselor_id: 'c', assessment_id: 'assessment' };
  harness.inject('database.commitTransaction', { code: 'COMMIT_DENIED' });
  await assert.rejects(repo.createMatch(input), { code: 'XG_COMMIT_UNKNOWN' });
  assert.equal(await harness.store.get(C.matches, 'a'), null);
  await repo.createMatch(input);
  assert.equal((await repo.getMatch('a')).status, 'active');
});

test('transaction no-op result without a real upsert id is not accepted as a successful write', async (t) => {
  const harness = sdkHarness(t);
  harness.inject('database.modifyDocument', { data: { updated: 0 } });
  await assert.rejects(harness.store.transaction((tx) => tx.put(C.matches, 'a', { match_id: 'a' })),
    /did not persist/);
});

test('installed SDK commits verified intake and ownership together and stores canonical approval', async (t) => {
  const harness = sdkHarness(t);
  const { identity } = createCloudBaseStore(harness.db);
  const visitor = await identity.exchangeIdentity({ appid: 'wx-app', openid: 'native-openid',
    jti: 'assertion-one', exp: Math.floor(Date.now() / 1000) + 60 });
  const principal = { role: 'visitor', subject: visitor.id, aud: 'xg-assessment', demo: false,
    auth_method: 'wechat-cloud', exp: Date.now() + 60000 };
  const intake = await identity.createIntake(principal, { answers: { concern: 'test' } });
  assert.equal((await harness.store.get('assessments', intake.assessment_id)).xg_managed, true);
  assert.equal((await harness.store.get(C.intakes, intake.assessment_id)).visitor_id, visitor.id);
  const pending = await identity.requestMatch(principal, { assessment_id: intake.assessment_id, counselor_id: 'c' });
  const approved = await identity.approveRequest({ ...principal, role: 'counselor', subject: 'c', auth_method: 'counselor-edit' }, pending.request_id);
  assert.equal(approved.status, 'approved');
  assert.equal((await harness.store.get(C.requests, pending.request_id)).approved_by, 'c');
});

test('installed SDK LLM pagination includes cycle filtering before limit and offset', async (t) => {
  const harness = sdkHarness(t);
  for (const [id, match] of [['a-1', 'a'], ['a-2', 'a'], ['b-1', 'b']]) {
    harness.seed(C.llmResults, { _id: id, event_id: id, match_id: match });
  }
  const rows = await harness.store.llmResultsForMatch('a', { limit: 1, offset: 1 });
  assert.deepEqual(rows.map((row) => row.event_id), ['a-2']);
  const call = harness.calls.at(-1);
  assert.equal(call.params.collectionName, C.llmResults);
  assert.deepEqual(EJSON.parse(call.params.query), { match_id: 'a' });
  assert.equal(call.params.offset, 1);
  assert.equal(call.params.limit, 1);
});

test('installed SDK persists immutable consent document, state and history with scoped audit queries', async (t) => {
  const harness = sdkHarness(t);
  harness.seed(C.visitors, { _id: 'visitor', visitor_id: 'visitor', provider: 'wechat-cloud' });
  const { consent } = createCloudBaseStore(harness.db);
  await consent.publishPolicy({ scope: 'assessment', version: 'test-v1', title: 'TEST ONLY', content: 'Not production consent.',
    published_by: 'test', expected_revision: 0 });
  const current = await consent.getStatus('visitor', 'assessment');
  const actor = { role: 'visitor', subject: 'visitor', aud: 'xg-assessment', demo: false, auth_method: 'wechat-cloud', exp: Date.now() + 60000 };
  await consent.decide(actor, { scope: 'assessment', version: current.required_version, document_hash: current.required_document.content_hash,
    agreed: true, channel: 'miniprogram', client_event_id: 'grant', expected_revision: current.revision });
  assert.equal((await consent.getStatus('visitor', 'assessment')).agreed, true);
  assert.equal((await consent.history('visitor', 'assessment'))[0].action, 'agreed');
  const query = harness.calls.filter((call) => call.action === 'database.getDocument' && call.params.collectionName === C.consentHistory && call.params.limit).at(-1);
  assert.deepEqual(EJSON.parse(query.params.query), { visitor_id: 'visitor', scope: 'assessment' });
  assert.match(query.params.order, /revision/);
  const state = await consent.getStatus('visitor', 'assessment');
  await consent.decide(actor, { scope: 'assessment', version: state.version, document_hash: state.document_hash,
    agreed: false, channel: 'miniprogram', client_event_id: 'withdraw', expected_revision: state.revision });
  await assert.rejects(consent.assertCurrent('visitor', 'assessment'), { code: 'XG_CONSENT_REQUIRED' });
});

test('installed SDK consent guard and business write share a single transaction and both conflict anchors', async (t) => {
  const harness = sdkHarness(t);
  harness.seed(C.visitors, { _id: 'visitor', visitor_id: 'visitor', provider: 'wechat-cloud' });
  const { consent } = createCloudBaseStore(harness.db);
  await consent.publishPolicy({ scope: 'assessment', version: 'test-v1', title: 'TEST ONLY', content: 'Not production consent.',
    published_by: 'test', expected_revision: 0 });
  const state = await consent.getStatus('visitor', 'assessment');
  await consent.decide({ role: 'visitor', subject: 'visitor', aud: 'xg-assessment', demo: false, auth_method: 'wechat-cloud', exp: Date.now() + 60000 },
    { scope: 'assessment', version: state.required_version, document_hash: state.required_document.content_hash,
      agreed: true, channel: 'web', client_event_id: 'grant', expected_revision: 0 });
  const start = harness.calls.length;
  await consent.runWithConsent('visitor', 'assessment', (tx, reference) => tx.put(C.submissions, 'guarded', { reference }));
  const writes = harness.calls.slice(start).filter((call) => call.action === 'database.modifyDocument');
  assert.deepEqual(writes.map((call) => call.params.collectionName).sort(), [C.consentPolicies, C.consentStates, C.submissions].sort());
  assert.equal(new Set(writes.map((call) => call.params.transactionId)).size, 1);
  assert.ok(writes.every((call) => call.params.transactionId));
});

test('installed SDK preserves embedded question/rule basis after publishing a new release and case config', async (t) => {
  const harness = sdkHarness(t);
  const { assessment, provenance } = createCloudBaseStore(harness.db);
  await assessment.createMatch({ match_id: 'a', visitor_id: 'v', counselor_id: 'c', assessment_id: 'intake' });
  await provenance.setCaseConfig('a', { optional_enabled: true, focus_text: '原关注点', expected_revision: 0, changed_by: 'c' });
  const original = await assessment.insertEvent({ match_id: 'a', event_id: 'old', scale_code: S.state, session_no: 2, status: 'started' });
  const bundle = defaultVersionBundle();
  bundle.catalog.items.find((item) => item.code === 's1').text = '新版题面';
  await provenance.publishVersions({ ...bundle, item_version: 'items-next', published_by: 'test', expected_revision: 1 });
  await provenance.setCaseConfig('a', { optional_enabled: false, focus_text: '新关注点', expected_revision: 1, changed_by: 'c' });
  const current = await assessment.insertEvent({ match_id: 'a', event_id: 'new', scale_code: S.state, session_no: 3, status: 'started' });
  assert.equal(current.basis.items.length, 7);
  assert.equal(current.basis.items[0].text, '新版题面');
  assert.equal(current.basis.context.focus_text, '新关注点');
  const historical = await provenance.eventBasis('a', 'old');
  assert.deepEqual(historical.basis, original.basis);
  assert.equal(historical.basis.items.length, 10);
  assert.equal(historical.basis.context.focus_text, '原关注点');
});

test('installed SDK lifecycle commits rejection then atomically commits score, consent, slot, profile and audit', async (t) => {
  const harness = sdkHarness(t);
  harness.seed(C.visitors, { _id: 'v', visitor_id: 'v', provider: 'wechat-cloud' });
  const store = createCloudBaseStore(harness.db);
  await store.consent.publishPolicy({ scope: 'assessment', version: 'test-v1', title: 'TEST ONLY',
    content: 'Test consent, not for production.', published_by: 'test', expected_revision: 0 });
  const status = await store.consent.getStatus('v', 'assessment');
  const principal = { role: 'visitor', subject: 'v', aud: 'xg-assessment', demo: false, auth_method: 'wechat-cloud', exp: Date.now() + 60000 };
  await store.consent.decide(principal, { scope: 'assessment', version: status.required_version,
    document_hash: status.required_document.content_hash, agreed: true, channel: 'web', client_event_id: 'grant', expected_revision: 0 });
  await store.assessment.createMatch({ match_id: 'case', visitor_id: 'v', counselor_id: 'c', assessment_id: 'intake' });
  const started = await store.lifecycle.start(principal, { match_id: 'case', scale_code: S.baseline, session_no: 0, client_event_id: 'begin' });
  const startWrites = harness.calls.filter((call) => call.action === 'database.modifyDocument');
  const eventWrite = startWrites.find((call) => call.params.collectionName === C.events);
  assert.ok(startWrites.some((call) => call.params.collectionName === C.rollout && call.params.transactionId === eventWrite.params.transactionId));
  const input = { match_id: 'case', event_id: started.event.event_id };
  const rejected = await store.lifecycle.submit(principal, { ...input, answers: {} });
  assert.equal(rejected.statusCode, 422);
  assert.equal((await store.assessment.getEvent('case', input.event_id)).status, 'rejected');
  const before = harness.calls.length;
  const answers = Object.fromEntries(started.event.basis.items.map((item) => [item.code, item.item_type === 'single_choice' ? 0 : 6]));
  const submitted = await store.lifecycle.submit(principal, { ...input, answers });
  assert.equal(submitted.event.status, 'submitted');
  assert.equal(submitted.event.scores.total, 42);
  assert.equal((await store.assessment.getProfiles('case')).baseline.original.total, 42);
  const writes = harness.calls.slice(before).filter((call) => call.action === 'database.modifyDocument');
  const primary = writes.filter((call) => ![C.combinationJobs, C.rawSignals, C.combinations, C.combinationHistory].includes(call.params.collectionName));
  assert.equal(new Set(primary.map((call) => call.params.transactionId)).size, 1);
  assert.ok(writes.some((call) => call.params.collectionName === C.combinationJobs && call.params.transactionId === primary[0].params.transactionId));
  const derived = writes.filter((call) => [C.rawSignals, C.combinations, C.combinationHistory].includes(call.params.collectionName));
  assert.equal(derived.length, 3);
  assert.equal(new Set(derived.map((call) => call.params.transactionId)).size, 1);
  for (const collection of [C.consentPolicies, C.consentStates, C.events, C.eventTransitions, C.submissions, C.baselines, C.matches]) {
    assert.ok(writes.some((call) => call.params.collectionName === collection), collection);
  }
});

test('T10 installed SDK rolls back confirmed conflict before retry', async (t) => {
  const harness = sdkHarness(t);
  const events = [];
  const store = createCloudBaseAssessmentStore(harness.db, { sleep: async () => {}, onTransactionEvent: (e) => events.push(e) });
  harness.inject('database.commitTransaction', { code: 'DATABASE_TRANSACTION_CONFLICT' });
  await store.transaction((tx) => tx.put(C.matches, 'conflict', { value: 1 }));
  const actions = harness.calls.map((call) => call.action);
  const abort = actions.indexOf('database.abortTransaction');
  assert.equal(actions[abort + 1], 'database.startTransaction');
  assert.equal(events.filter((e) => e.type === 'conflict').length, 1);
  assert.equal((await store.get(C.matches, 'conflict')).value, 1);
});

test('T10 retry budget is bounded and business failures never retry', async () => {
  let starts = 0, aborts = 0;
  const db = { async startTransaction() { starts++; return {
    async commit() { throw Object.assign(new Error('conflict'), { code: 'DATABASE_TRANSACTION_CONFLICT' }); },
    async rollback() { aborts++; return {}; }
  }; } };
  const store = createCloudBaseAssessmentStore(db, { maxTransactionAttempts: 3, sleep: async () => {} });
  await assert.rejects(store.transaction(async () => {}), { code: 'XG_TRANSACTION_BUSY', statusCode: 503 });
  assert.equal(starts, 3); assert.equal(aborts, 3);
  await assert.rejects(store.transaction(async () => { throw new Error('business'); }), /business/);
  assert.equal(starts, 4); assert.equal(aborts, 4);
});

test('T10 lost commit acknowledgement is not retried automatically', async (t) => {
  const harness = sdkHarness(t);
  let commits = 0;
  const wrapped = { collection: (...args) => harness.db.collection(...args), async startTransaction() {
    const tx = await harness.db.startTransaction();
    return { collection: (...args) => tx.collection(...args), rollback: () => tx.rollback(), async commit() {
      await tx.commit(); commits++; throw new Error('response lost');
    } };
  } };
  const store = createCloudBaseAssessmentStore(wrapped);
  await assert.rejects(store.transaction((tx) => tx.put(C.matches, 'durable', { saved: true })), { code: 'XG_COMMIT_UNKNOWN' });
  assert.equal(commits, 1);
  assert.equal((await harness.store.get(C.matches, 'durable')).saved, true);
});

test('T16 installed SDK applies bounded due-status/date filtering in the database', async (t) => {
  const harness = sdkHarness(t);
  await harness.store.dueFollowups('2026-02-28T01:00:00.000Z', 25);
  const call = harness.calls.at(-1);
  assert.equal(call.action, 'database.getDocument'); assert.equal(call.params.collectionName, C.followupJobs);
  assert.equal(call.params.limit, 25);
  assert.deepEqual(EJSON.parse(call.params.query), { status: { $in: ['scheduled','blocked','queued'] }, next_check_at: { $lte: '2026-02-28T01:00:00.000Z' } });
});

test('T17 installed SDK bounds notification scans and recipient queries on the server', async (t) => {
  const harness = sdkHarness(t);
  await harness.store.dueNotifications('2026-10-25T00:00:00.000Z', 20);
  let call = harness.calls.at(-1);
  assert.equal(call.params.collectionName, C.notificationTasks); assert.equal(call.params.limit, 20);
  assert.deepEqual(EJSON.parse(call.params.query), { status: { $in: ['queued','retry_wait','blocked','processing'] }, next_attempt_at: { $lte: '2026-10-25T00:00:00.000Z' } });
  await harness.store.messagesForRecipient('visitor', 'v', { limit: 50, offset: 0 });
  call = harness.calls.at(-1); assert.deepEqual(EJSON.parse(call.params.query), { recipient_role: 'visitor', recipient_id: 'v' });
});

test('T17 installed SDK bridge receipt claim and completion prevent a second send reservation', async (t) => {
  const harness = sdkHarness(t);
  const { createBridgeStore } = require('../../../cloudfunctions/xg-subscribe-send/handler');
  const store = createBridgeStore(harness.db), id = 'b'.repeat(64);
  assert.equal(await store.claim(id, 'hash'), null);
  assert.equal((await store.claim(id, 'hash')).status, 'pending');
  await store.complete(id, 'hash', { kind: 'accepted', code: 'WX_OK' });
  assert.equal((await store.claim(id, 'hash')).result.kind, 'accepted');
  await assert.rejects(store.complete(id, 'hash', { kind: 'rejected', code: 'OTHER' }), /immutable/);
});

test('T18 installed SDK expiry query limits status and time with minimal projection',async(t)=>{
  const h=sdkHarness(t);await h.store.expiredEvents('2026-10-25T00:00:00.000Z',25);
  const call=h.calls.at(-1);assert.equal(call.params.collectionName,C.events);assert.equal(call.params.limit,25);
  assert.deepEqual(EJSON.parse(call.params.query),{status:{$in:['started','rejected']},expires_at:{$lte:'2026-10-25T00:00:00.000Z'}});
  assert.deepEqual(EJSON.parse(call.params.projection),{_id:1,event_id:1});assert.match(call.params.order,/expires_at/);
});

test('T18 installed SDK statistics queries keyset and projections on the server',async(t)=>{
  const h=sdkHarness(t),{DATASETS}=require('./statistics-source');
  const args={from:'2026-10-19T16:00:00.000Z',to:'2026-10-20T16:00:00.000Z',asOf:'2026-10-25T04:00:00.000Z',after:'cursor',limit:100};
  for(const [name,spec]of Object.entries(DATASETS)){
    await h.store.statisticsPage(name,args);const call=h.calls.at(-1),query=EJSON.parse(call.params.query);
    assert.equal(call.params.collectionName,spec.collection);assert.equal(call.params.limit,100);assert.deepEqual(query._id,{$gt:'cursor'});
    assert.deepEqual(EJSON.parse(call.params.projection),Object.fromEntries(['_id',...spec.fields].map(f=>[f,1])));
    assert.equal(JSON.stringify(query).includes(args.asOf),!!(spec.historical||spec.throughNow));
    assert.equal(JSON.stringify(query).includes(args.from),!spec.historical);
    assert.match(call.params.order,/_id/);
  }
  await h.store.statisticsPage('events',args);
  assert.deepEqual(EJSON.parse(h.calls.at(-1).params.query),{started_at:{$lte:args.asOf},_id:{$gt:'cursor'}});
  await assert.rejects(h.store.statisticsPage('assessments',args),/Unknown statistics source/);
  h.inject('database.getDocument',{code:'PERMISSION_DENIED',message:'private'});
  await assert.rejects(h.store.statisticsPage('events',args),{code:'PERMISSION_DENIED'});
});

test('T19 installed SDK scopes runnable/recovery jobs and admin queue projections',async(t)=>{
 const h=sdkHarness(t),at='2026-10-25T01:00:00.000Z';await h.store.dueLlmJobs(at,5);
 let call=h.calls.at(-1);assert.equal(call.params.collectionName,C.llmJobs);assert.equal(call.params.limit,5);
 assert.deepEqual(EJSON.parse(call.params.query),{status:{$in:['pending','retry_wait','blocked','processing']},next_attempt_at:{$lte:at}});
 assert.deepEqual(EJSON.parse(call.params.projection),{_id:1});
 await h.store.recoverableLlmJobs(at,50);call=h.calls.at(-1);assert.deepEqual(EJSON.parse(call.params.query),{status:'failed',recovery_eligible:true,recover_at:{$lte:at}});
 await h.store.llmJobsPage({status:'review_required',after:'cursor',limit:20});call=h.calls.at(-1);
 assert.deepEqual(EJSON.parse(call.params.query),{status:'review_required',_id:{$gt:'cursor'}});
 const projection=EJSON.parse(call.params.projection);assert.equal(projection.last_error,1);assert.equal(projection.snapshot,undefined);assert.equal(projection.lease_token,undefined);
});
