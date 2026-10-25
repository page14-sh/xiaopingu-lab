const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRolloutRepository, effectivePolicy } = require('./rollout');
const { createReminderRepository, projectReminder } = require('./reminders');
const { createAssessmentRepository } = require('./repository');
const { createConsentRepository } = require('./consent');
const { createEventLifecycle } = require('./event-lifecycle');
const { createIdentityRepository } = require('./identity-repository');
const { memoryAssessmentStore } = require('./test-support');
const { COLLECTIONS: C, SCALES: S, documentKey } = require('./model');
const { createRequestHandler, signSession } = require('../app');
const actor = (role = 'counselor', subject = role === 'visitor' ? 'v' : role === 'admin' ? 'admin' : 'c') => ({ role, subject,
  aud: 'xg-assessment', demo: false, exp: Date.now() + 3600000,
  auth_method: role === 'visitor' ? 'wechat-cloud' : role === 'admin' ? 'admin-password' : 'counselor-edit' });
async function fixture() {
  const db = memoryAssessmentStore(), repo = createAssessmentRepository(db), consent = createConsentRepository(db);
  const flow = createEventLifecycle(db, consent), rollout = createRolloutRepository(db), reminders = createReminderRepository(db);
  await db.transaction((tx) => tx.put(C.visitors, 'v', { visitor_id: 'v', provider: 'wechat-cloud' }));
  await consent.publishPolicy({ scope: 'assessment', version: 'test', title: 'TEST', content: 'Synthetic test only.', published_by: 'test', expected_revision: 0 });
  const state = await consent.getStatus('v', 'assessment');
  await consent.decide(actor('visitor'), { scope: 'assessment', version: 'test', document_hash: state.required_document.content_hash,
    agreed: true, channel: 'web', client_event_id: 'grant', expected_revision: 0 });
  await repo.createMatch({ match_id: 'case', visitor_id: 'v', counselor_id: 'c', assessment_id: 'intake' });
  await repo.createMatch({ match_id: 'other', visitor_id: 'v', counselor_id: 'other-c', assessment_id: 'intake-other' });
  let serial = 0;
  async function prepare(scale, session, value = 6, extra = {}, match = 'case') {
    const who = actor(scale === S.pro ? 'counselor' : 'visitor', scale === S.pro ? (match === 'case' ? 'c' : 'other-c') : 'v');
    const startInput = { match_id: match, scale_code: scale, session_no: session, client_event_id: `start-${++serial}` };
    const { event } = await flow.start(who, startInput);
    const answers = Object.fromEntries(event.basis.items.filter((i) => i.applicable).map((i) => [i.code,
      i.item_type === 'single_choice' ? (i.code === 'd1' ? 0 : 10) : value]));
    Object.assign(answers, extra);
    return { who, event, startInput, input: { match_id: match, event_id: event.event_id, request_id: `submit-${serial}`, answers } };
  }
  async function card(...args) { const p = await prepare(...args); return (await flow.submit(p.who, p.input)).event; }
  async function configure(patch) {
    const current = await rollout.get(); return rollout.update(actor('admin'), { expected_revision: current.revision, patch, reason: 'Test change' });
  }
  async function rollback() { const current = await rollout.get(); return rollout.update(actor('admin'), { expected_revision: current.revision, reason: 'Emergency test' }, { rollback: true }); }
  return { db, repo, consent, flow, rollout, reminders, prepare, card, configure, rollback };
}
const itemsOf = async (f, role = actor(), options) => (await f.reminders.inbox(role, 'case', options)).items;

for (const globalOn of [false,true]) for (const caseOn of [false,true]) for (const stop of [false,true]) {
  test(`T15 visibility matrix global=${globalOn} case=${caseOn} stop=${stop}`, () => {
    for (const globalCst of [false,true]) for (const caseCst of [false,true]) {
      const effective = effectivePolicy({ revision: 1, enable_reminder: globalOn, enable_cst: globalCst, emergency_stop: stop, collection_paused: false },
        { revision: 2, enable_reminder: caseOn, enable_cst: caseCst });
      for (const [rule, level, visible] of [['OUT-SINGLE','L1',!stop], ['OUT-DROP','L2',!stop && (globalOn || caseOn)],
        ['OUT-LOW','L3',!stop && globalOn], ['DISSOC','L3',true]]) {
        const view = projectReminder({ rule_id: rule, level, signal_id: rule, event_id: 'event' },
          { revision: 1, combined: { downgraded: false } }, { match_id: 'case', session_no: 2, submitted_at: 'time' }, effective);
        assert.equal(!!view, visible, rule);
        if (view) assert.equal(view.cst.enabled, !stop && (globalCst || caseCst) && level !== 'L1');
      }
    }
  });
}

test('T15 safe defaults are read without seeding and safety is an invariant, not a client switch', async () => {
  const f = await fixture(), before = f.db.snapshot(), policy = await f.rollout.get();
  assert.equal(policy.stage, 'phase_one'); assert.equal(policy.enable_reminder, false); assert.equal(policy.enable_cst, false);
  assert.equal(policy.safety_always_on, true); assert.equal(policy.collection_paused, false);
  assert.deepEqual(f.db.snapshot(), before);
  await assert.rejects(f.configure({ safety_always_on: false }), { code: 'XG_BAD_PARAM' });
});

test('T15 phase one projects L1 and safety but hides ordinary L2/L3 before pagination', async () => {
  const f = await fixture(); await f.card(S.baseline, 0, 7, { d1: 2 });
  await f.card(S.state, 2, 6); await f.card(S.state, 3, 6); await f.card(S.state, 4, 2);
  const items = await itemsOf(f);
  assert.deepEqual(new Set(items.map((i) => i.alert_level)), new Set(['L1','L3']));
  assert.equal(items.filter((i) => i.is_safety).length, 1);
  assert.ok(items.every((i) => i.alert_level === 'L1' || i.is_safety));
  const paged = [];
  for (let offset = 0; offset < items.length; offset++) paged.push(...await itemsOf(f, actor(), { limit: 1, offset }));
  assert.deepEqual(paged, items);
  assert.ok(items.every((i) => !/下降|恶化|病情|变差/.test(i.suggest_text)));
  for (const item of items) for (const field of ['scores','raw_answers','original_level','basis','raw','policy']) assert.equal(field in item, false);
});

test('T15 case opt-in exposes only its own L2 and cannot expose ordinary L3', async () => {
  const f = await fixture();
  for (const match of ['case','other']) {
    await f.card(S.baseline, 0, 7, {}, match); await f.card(S.state, 2, 6, {}, match); await f.card(S.state, 3, 6, {}, match); await f.card(S.state, 4, 2, {}, match);
  }
  await f.rollout.caseSwitch(actor(), 'case', { enable_reminder: true, enable_cst: true }, { expected_revision: 0 });
  const items = await itemsOf(f); assert.ok(items.some((i) => i.alert_level === 'L2'));
  assert.ok(items.every((i) => i.alert_level !== 'L3'));
  assert.ok(items.filter((i) => i.alert_level === 'L2').every((i) => i.cst.enabled && i.cst.steps.length === 3));
  const other = await f.reminders.inbox(actor('counselor','other-c'), 'other');
  assert.ok(other.items.every((i) => i.alert_level === 'L1'));
});

test('T15 global on admits ordinary L3; global off still allows case L2 until emergency rollback', async () => {
  const f = await fixture(); await f.card(S.baseline, 0, 7); await f.card(S.state, 2, 6); await f.card(S.state, 3, 6); await f.card(S.state, 4, 2);
  await f.rollout.caseSwitch(actor(), 'case', { enable_reminder: true, enable_cst: true });
  await f.configure({ enable_reminder: true, enable_cst: true });
  assert.ok((await itemsOf(f)).some((i) => i.alert_level === 'L3'));
  await f.configure({ enable_reminder: false, enable_cst: false });
  assert.ok((await itemsOf(f)).some((i) => i.alert_level === 'L2'));
  const before = f.db.snapshot(); await f.rollback();
  assert.deepEqual(await itemsOf(f), []);
  const after = f.db.snapshot();
  for (const collection of Object.values(C).filter((c) => ![C.rollout,C.rolloutHistory].includes(c))) assert.deepEqual(after[collection], before[collection]);
  assert.equal((await f.rollout.caseSwitch(actor(), 'case')).enable_reminder, true);
  assert.equal((await f.rollout.caseSwitch(actor(), 'case')).effective.l2_visible, false);
});

test('T15 safety remains visible once during emergency while CST and ordinary reminders are suppressed', async () => {
  const f = await fixture(); await f.card(S.baseline, 0, 7, { d1: 2 }); await f.card(S.state, 2, 2); await f.card(S.state, 3, 2);
  await f.rollout.caseSwitch(actor(), 'case', { enable_reminder: true, enable_cst: true }); await f.configure({ enable_reminder: true, enable_cst: true });
  await f.rollback();
  const items = await itemsOf(f); assert.equal(items.length, 1); assert.equal(items[0].is_safety, true); assert.equal(items[0].alert_level, 'L3');
  assert.equal(items[0].cst.enabled, false); assert.deepEqual(items[0].cst.steps, []);
  const p = await f.card(S.state, 4, 1); assert.equal(p.status, 'submitted');
  assert.ok((await f.repo.getCombination('case', 4)).raw.signals.some((s) => s.rule_id === 'OUT-LOW'));
  assert.equal((await itemsOf(f)).length, 1);
});

test('T15 releasing emergency applies the retained case settings without deleting prior revisions', async () => {
  const f = await fixture(); await f.card(S.baseline, 0, 7); await f.card(S.state, 2, 6); await f.card(S.state, 3, 6);
  await f.rollout.caseSwitch(actor(), 'case', { enable_reminder: true }); await f.rollback();
  assert.equal((await itemsOf(f)).length, 0);
  const data = f.db.snapshot(); await f.configure({ emergency_stop: false });
  assert.ok((await itemsOf(f)).some((i) => i.alert_level === 'L2'));
  for (const c of [C.events,C.rawSignals,C.combinations,C.combinationHistory]) assert.deepEqual(f.db.snapshot()[c], data[c]);
});

test('T15 a combined L1 is visible without revealing the hidden original L2 record', async () => {
  const f = await fixture(); await f.card(S.baseline, 0, 7); await f.card(S.state, 2, 6); await f.card(S.state, 3, 6);
  await f.card(S.feel, 3, 9); await f.card(S.pro, 3, 9, { p1: 8 });
  const items = await itemsOf(f, actor(), { session_no: 3 });
  assert.equal(items.length, 1); assert.equal(items[0].alert_level, 'L1'); assert.equal(items[0].cst.enabled, false);
  assert.equal('original_level' in items[0], false);
  assert.equal((await f.repo.getCombination('case', 3)).combined.original_level, 'L2');
});

test('T15 collection pause blocks only new attempts; existing forms may resume, submit or abandon', async () => {
  const f = await fixture(), submit = await f.prepare(S.state, 2), leave = await f.prepare(S.feel, 2);
  await f.configure({ collection_paused: true }); const before = f.db.snapshot();
  await assert.rejects(f.prepare(S.state, 3), { code: 'XG_COLLECTION_PAUSED' }); assert.deepEqual(f.db.snapshot(), before);
  assert.equal((await f.flow.start(submit.who, submit.startInput)).event.event_id, submit.event.event_id);
  assert.equal((await f.flow.submit(submit.who, submit.input)).event.status, 'submitted');
  assert.equal((await f.flow.abandon(leave.who, { match_id: 'case', event_id: leave.event.event_id, request_id: 'leave' })).event.status, 'abandoned');
  await f.configure({ collection_paused: false }); assert.equal((await f.prepare(S.state, 3)).event.status, 'started');
});

test('T15 rollback preserves collection state and does not prevent closing a cycle', async () => {
  const f = await fixture(); await f.configure({ collection_paused: true });
  const result = await f.rollback(); assert.equal(result.collection_paused, true);
  await f.repo.closeMatch('case', 1); assert.equal((await f.repo.getMatch('case')).status, 'closed');
});

test('T15 global settings, history and revisions are atomic and retry-safe', async () => {
  const f = await fixture(), before = f.db.snapshot();
  const input = { expected_revision: 0, patch: { enable_reminder: true }, reason: 'Reviewed rollout' };
  f.db.failNextWriteTo(C.rollout); await assert.rejects(f.rollout.update(actor('admin'), input), /Injected storage failure/);
  assert.deepEqual(f.db.snapshot(), before);
  const first = await f.rollout.update(actor('admin'), input); assert.equal(first.revision, 1);
  const saved = f.db.snapshot(); assert.equal((await f.rollout.update(actor('admin'), input)).duplicated, true); assert.deepEqual(f.db.snapshot(), saved);
  const audit = await f.rollout.readHistory(actor('admin'), 'global', '', 1);
  assert.equal(audit.changed_by, 'admin'); assert.equal(audit.before.enable_reminder, false); assert.equal(audit.after.enable_reminder, true);
  await f.configure({ enable_cst: true });
  await assert.rejects(f.rollout.update(actor('admin'), input), { code: 'XG_ROLLOUT_CONFLICT' });
});

test('T15 competing global writers preserve one revision; collection locks do not consume semantic revisions', async () => {
  const f = await fixture(); await f.prepare(S.state, 2);
  assert.equal((await f.rollout.get()).revision, 0);
  const results = await Promise.allSettled([
    f.rollout.update(actor('admin'), { expected_revision: 0, patch: { enable_reminder: true }, reason: 'a' }),
    f.rollout.update(actor('admin'), { expected_revision: 0, patch: { emergency_stop: true }, reason: 'b' })
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'XG_ROLLOUT_CONFLICT');
  assert.equal((await f.rollout.get()).revision, 1);
});

test('T15 case updates retain compatibility, but versioned callers reject stale changes and record scoped history', async () => {
  const f = await fixture();
  const first = await f.rollout.caseSwitch(actor(), 'case', { enable_reminder: true }, { expected_revision: 0 });
  assert.equal(first.revision, 1);
  const before = f.db.snapshot(); await f.rollout.caseSwitch(actor(), 'case', { enable_reminder: true }, { expected_revision: 0 }); assert.deepEqual(f.db.snapshot(), before);
  await f.rollout.caseSwitch(actor(), 'case', { enable_cst: true }, { expected_revision: 1 });
  await assert.rejects(f.rollout.caseSwitch(actor(), 'case', { enable_reminder: false }, { expected_revision: 0 }), { code: 'XG_ROLLOUT_CONFLICT' });
  assert.equal((await f.rollout.caseSwitch(actor(), 'case', { enable_reminder: false })).revision, 3);
  const history = await f.rollout.readHistory(actor('admin'), 'case', 'case', 2);
  assert.equal(history.match_id, 'case'); assert.equal(history.after.enable_cst, true);
  await assert.rejects(f.rollout.caseSwitch(actor('counselor','other-c'), 'case', { enable_reminder: true }), { code: 'XG_FORBIDDEN' });
  await assert.rejects(f.rollout.caseSwitch(actor(), 'case', { emergency_stop: false }), { code: 'XG_BAD_PARAM' });
  await assert.rejects(f.rollout.caseSwitch(actor('admin'), 'case', { enable_reminder: true }), { code: 'XG_FORBIDDEN' });
});

test('T15 inbox reads final flags after a rollback during candidate assembly', async () => {
  const f = await fixture(); await f.card(S.baseline, 0, 7); await f.card(S.state, 2, 6); await f.card(S.state, 3, 6);
  await f.configure({ enable_reminder: true }); let rolled = false;
  const wrapped = { ...f.db, async eventsForMatch(id) {
    const rows = await f.db.eventsForMatch(id); if (!rolled) { rolled = true; await f.rollback(); } return rows;
  } };
  const result = await createReminderRepository(wrapped).inbox(actor(), 'case');
  assert.equal(result.policy.stage, 'emergency_paused'); assert.deepEqual(result.items, []);
});

test('T15 changing gates does not enqueue notifications or reopen completed calculation jobs', async () => {
  const f = await fixture(); await f.card(S.baseline, 0, 7); await f.card(S.state, 2, 6); await f.card(S.state, 3, 6);
  const before = f.db.snapshot(); await f.configure({ enable_reminder: true, enable_cst: true }); await itemsOf(f); await f.rollback();
  for (const collection of [C.combinationJobs,C.combinations,C.rawSignals,C.combinationHistory,C.events,C.requestReceipts]) assert.deepEqual(f.db.snapshot()[collection], before[collection]);
});

test('T15 HTTP enforces admin rollout, own-cycle inbox, case fields, query bounds and paused prompts', async (t) => {
  const f = await fixture(); await f.card(S.baseline, 0, 7, { d1: 2 }); await f.card(S.state, 2, 6); await f.card(S.state, 3, 6);
  const secret = 't15-http-test';
  const store = { assessment: f.repo, consent: f.consent, lifecycle: f.flow, identity: createIdentityRepository(f.db),
    async list() { return []; }, async findById(_table, id) { return { id, is_active: true, review_status: 'approved' }; } };
  const server = http.createServer(createRequestHandler({ store, sessionSecret: secret }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((resolve) => server.close(resolve)));
  async function request(path, who = actor('admin'), method = 'GET', body) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/xg${path}`, { method,
      headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${signSession(who, secret)}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  }
  const initial = await request('/admin/rollout'); assert.equal(initial.status, 200); assert.equal(initial.cache, 'no-store');
  for (const who of [actor(),actor('visitor')]) for (const method of ['GET','POST']) assert.equal((await request('/admin/rollout', who, method, method === 'POST' ? {} : undefined)).status, 403);
  assert.equal((await request('/admin/rollout', null)).status, 401);
  for (const patch of [{ safety_always_on: false }, { enable_l3: true }, { enable_reminder: 'true' }, { enable_reminder: true, published_by: 'fake' }]) {
    assert.equal((await request('/admin/rollout', actor('admin'), 'POST', { expected_revision: 0, reason: 'test', ...patch })).status, 400);
  }
  const updated = await request('/admin/rollout', actor('admin'), 'POST', { expected_revision: 0, reason: 'test', enable_reminder: true, enable_cst: true });
  assert.equal(updated.status, 200); assert.equal(updated.body.updated_by, 'admin');
  const inbox = await request('/counselor/inbox?match_id=case', actor()); assert.equal(inbox.status, 200); assert.equal(inbox.cache, 'no-store');
  assert.ok(inbox.body.items.some((i) => i.alert_level === 'L2'));
  assert.equal('total' in inbox.body, false);
  assert.equal((await request('/counselor/inbox?match_id=case', actor('visitor'))).status, 403);
  assert.equal((await request('/counselor/inbox?match_id=case', actor('counselor','other-c'))).status, 403);
  for (const suffix of ['&limit=0','&offset=-1','&match_id=other','&status=invalid','&alert_type=unknown']) assert.equal((await request('/counselor/inbox?match_id=case' + suffix, actor())).status, 400);
  assert.equal((await request('/case-switch?match_id=case&match_id=other', actor())).status, 400);
  assert.equal((await request('/case-switch', actor(), 'POST', { match_id: 'case', enable_l3: true })).status, 400);
  const switched = await request('/case-switch', actor(), 'POST', { match_id: 'case', enable_reminder: true, expected_revision: 0 });
  assert.equal(switched.status, 200); assert.equal(switched.body.effective.l2_visible, true);
  const rollback = await request('/admin/rollout/rollback', actor('admin'), 'POST', { expected_revision: 1, reason: 'test rollback' });
  assert.equal(rollback.body.emergency_stop, true);
  const safetyOnly = await request('/counselor/inbox?match_id=case', actor()); assert.equal(safetyOnly.body.items.length, 1); assert.equal(safetyOnly.body.items[0].is_safety, true);
  const historical = await request('/admin/rollout/history?scope=global&revision=2'); assert.equal(historical.body.action, 'rollback');
  assert.equal((await request('/admin/rollout/history?scope=case&match_id=case&revision=1', actor())).status, 403);
  await f.configure({ collection_paused: true });
  const prompts = await request('/prompts/next?match_id=case', actor('visitor')); assert.equal(prompts.status, 200); assert.deepEqual(prompts.body, { prompts: [] });
  assert.equal((await request('/admin/rollout', actor('admin'), 'DELETE')).status, 405);
});
