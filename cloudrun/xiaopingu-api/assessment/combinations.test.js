const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createAssessmentRepository } = require('./repository');
const { createEventLifecycle } = require('./event-lifecycle');
const { createConsentRepository } = require('./consent');
const { createIdentityRepository } = require('./identity-repository');
const { createProvenanceRepository, defaultVersionBundle } = require('./provenance');
const { createCombinationRepository } = require('./combinations');
const { evaluateCombinations } = require('./combination-engine');
const { memoryAssessmentStore } = require('./test-support');
const { COLLECTIONS: C, SCALES: S, documentKey } = require('./model');
const { createRequestHandler, signSession } = require('../app');
const actor = (role = 'visitor', subject = role === 'visitor' ? 'v' : role === 'counselor' ? 'c' : 'admin') => ({ role, subject,
  aud: 'xg-assessment', demo: false, auth_method: role === 'visitor' ? 'wechat-cloud' : role === 'counselor' ? 'counselor-edit' : 'admin-password', exp: Date.now() + 3600000 });
async function fixture() {
  const db = memoryAssessmentStore(), repo = createAssessmentRepository(db), consent = createConsentRepository(db);
  const provenance = createProvenanceRepository(db), flow = createEventLifecycle(db, consent), combos = createCombinationRepository(db);
  await db.transaction((tx) => tx.put(C.visitors, 'v', { visitor_id: 'v', provider: 'wechat-cloud' }));
  await consent.publishPolicy({ scope: 'assessment', version: 'test', title: 'TEST', content: 'Synthetic only.', published_by: 'test', expected_revision: 0 });
  const status = await consent.getStatus('v', 'assessment');
  await consent.decide(actor(), { scope: 'assessment', version: 'test', document_hash: status.required_document.content_hash,
    agreed: true, channel: 'web', client_event_id: 'grant', expected_revision: 0 });
  await repo.createMatch({ match_id: 'case', visitor_id: 'v', counselor_id: 'c', assessment_id: 'intake' });
  let serial = 0;
  async function prepare(scale, session, value = 6, options = {}) {
    const who = actor(scale === S.pro ? 'counselor' : 'visitor', scale === S.pro ? (options.counselor || 'c') : 'v');
    const { event } = await flow.start(who, { match_id: options.match || 'case', scale_code: scale, session_no: session,
      client_event_id: `attempt-${++serial}` });
    const answers = Object.fromEntries(event.basis.items.filter((i) => i.applicable).map((i) => [i.code,
      i.item_type === 'single_choice' ? (i.code === 'p6' ? 10 : 0) : value]));
    Object.assign(answers, options.answers || {});
    const input = { match_id: event.match_id, event_id: event.event_id, request_id: `submit-${serial}`, answers };
    return { who, event, input };
  }
  async function card(...args) { const p = await prepare(...args); return (await flow.submit(p.who, p.input)).event; }
  const read = (session, revision) => combos.read('case', session, revision);
  return { db, repo, consent, provenance, flow, combos, prepare, card, read };
}
const ids = (result) => result.raw.signals.map((s) => s.rule_id);
const permutations = [[S.state,S.feel,S.pro],[S.state,S.pro,S.feel],[S.feel,S.state,S.pro],
  [S.feel,S.pro,S.state],[S.pro,S.state,S.feel],[S.pro,S.feel,S.state]];
async function dropFixture() {
  const f = await fixture(); await f.card(S.baseline, 0, 7); await f.card(S.state, 2, 6); return f;
}
async function stable(f, session) {
  await f.card(S.feel, session, 9);
  await f.card(S.pro, session, 9, { answers: { p1: 8 } }); // 54/60 = 36/40 = 90%.
}

for (const [index, order] of permutations.entries()) {
  test(`T13 all arrival permutations ${index + 1} keep original L2 and derive one L1`, async () => {
    const f = await dropFixture();
    for (const scale of order) {
      await f.card(scale, 3, scale === S.state ? 6 : 9, scale === S.pro ? { answers: { p1: 8 } } : {});
      const partial = await f.read(3);
      if (partial.combined.missing_cards.length) assert.equal(partial.combined.downgraded, false);
    }
    const result = await f.read(3);
    assert.deepEqual(ids(result), ['OUT-DROP']);
    assert.equal(result.combined.status, 'complete');
    assert.equal(result.combined.original_level, 'L2'); assert.equal(result.combined.display_level, 'L1');
    assert.equal(result.combined.reason, 'outcome_drop_alliance_stable'); assert.equal(result.combined.diff_post, 0);
    assert.equal(new Set(Object.values(result.combined.event_ids)).size, 3);
    assert.equal(result.raw.signals[0].signal_id, documentKey('case', 3, 'OUT-DROP'));
    const before = f.db.snapshot(); await f.combos.refresh('case'); await f.read(3); assert.deepEqual(f.db.snapshot(), before);
  });
}

test('T13 reversing already captured events produces byte-identical final evaluations', async () => {
  const f = await dropFixture(); await f.card(S.state, 3, 6); await stable(f, 3);
  const match = await f.repo.getMatch('case'), events = await f.repo.listEvents('case');
  assert.deepEqual(evaluateCombinations(match, events), evaluateCombinations(match, events.slice().reverse()));
});

test('T13 missing M2 or M3 never downgrades an outcome drop', async () => {
  const f = await dropFixture(); await f.card(S.state, 3, 6);
  const pending = await f.read(3);
  assert.equal(pending.combined.display_level, 'L2'); assert.equal(pending.combined.status, 'pending_cards');
  await f.card(S.feel, 3, 9);
  assert.equal((await f.read(3)).combined.display_level, 'L2');
});

test('T13 low current alliance blocks downgrade without needing a fabricated consecutive signal', async () => {
  const f = await dropFixture(); await f.card(S.state, 3, 6);
  await f.card(S.feel, 3, 7); await f.card(S.pro, 3, 7, { answers: { p1: 4 } });
  assert.equal((await f.read(3)).combined.downgraded, false);
  assert.equal((await f.read(3)).combined.display_level, 'L2');
});

test('T13 low dimension blocks downgrade even with total above 28 and matching pro percent', async () => {
  const f = await dropFixture(); await f.card(S.state, 3, 6);
  await f.card(S.feel, 3, 10, { answers: { f1: 3 } });
  await f.card(S.pro, 3, 8);
  assert.equal((await f.read(3)).combined.alliance_stable, false);
  assert.equal((await f.read(3)).combined.display_level, 'L2');
});

test('T13 L3 absolute low remains L3 after stable alliance arrives', async () => {
  const f = await fixture(); await f.card(S.baseline, 0, 7); await f.card(S.state, 2, 2);
  await stable(f, 2);
  const result = await f.read(2);
  assert.ok(ids(result).includes('OUT-LOW')); assert.equal(result.combined.reason, 'preserve_l3');
  assert.equal(result.combined.display_level, 'L3');
});

test('T13 escalating decline keeps multiple L3 evidence paths and cannot be downgraded', async () => {
  const f = await fixture(); await f.card(S.baseline, 0, 7);
  await f.card(S.state, 2, 6); await f.card(S.state, 3, 5); await f.card(S.state, 4, 4); await stable(f, 4);
  const result = await f.read(4);
  for (const id of ['OUT-DROP','OUT-MONO','OUT-ACCEL']) assert.ok(ids(result).includes(id));
  assert.equal(result.combined.display_level, 'L3');
});

test('T13 flat signals retain L2 under a stable alliance', async () => {
  const f = await fixture(); await f.card(S.baseline, 0, 7);
  for (const n of [2,3,4,5]) await f.card(S.state, n, 7);
  await stable(f, 5);
  const result = await f.read(5); assert.ok(ids(result).includes('OUT-FLAT'));
  assert.equal(result.combined.display_level, 'L2'); assert.equal(result.combined.reason, 'preserve_flat');
});

for (const order of [[S.feel, S.pro], [S.pro, S.feel]]) {
  test(`T13 ALL-GAP stable business ID with order ${order.join(',')}`, async () => {
    const f = await fixture();
    for (const scale of order) await f.card(scale, 2, scale === S.feel ? 9 : 6, scale === S.pro ? { answers: { p1: 2 } } : {});
    const result = await f.read(2), gap = result.raw.signals.find((s) => s.rule_id === 'ALL-GAP');
    assert.equal(gap.signal_id, documentKey('case', 2, 'ALL-GAP'));
    assert.equal(gap.evidence.length, 2); assert.notEqual(gap.evidence[0].event_id, gap.evidence[1].event_id);
    assert.equal(result.combined.display_level, 'L2');
    assert.equal(result.combined.diff_post, 30);
  });
}

for (const [proTotal, gapExpected] of [[36, true], [37, false]]) {
  test(`T13 gap threshold compares unrounded percentages at pro total ${proTotal}`, async () => {
    const f = await fixture(); await f.card(S.feel, 2, 7, { answers: { f1: 9 } }); // 30/40 = 75%.
    await f.card(S.pro, 2, 6, { answers: { p1: proTotal - 34 } });
    const result = await f.read(2); assert.equal(ids(result).includes('ALL-GAP'), gapExpected);
  });
}

test('T13 first-session p6 absence leaves diff null and cannot create ALL-GAP', async () => {
  const f = await fixture(); await f.card(S.feel, 1, 0); await f.card(S.pro, 1, 10);
  const result = await f.read(1); assert.equal(result.combined.status, 'not_comparable');
  assert.equal(result.combined.diff_post, null); assert.equal(ids(result).includes('ALL-GAP'), false);
});

test('T13 late historical card rebuilds subsequent windows and retains prior revisions', async () => {
  const f = await fixture(); await f.card(S.baseline, 0, 7);
  await f.card(S.state, 2, 6); await f.card(S.state, 4, 6); await stable(f, 4);
  const before = await f.read(4); assert.equal(ids(before).includes('OUT-DROP'), false);
  await f.card(S.state, 3, 6);
  const after = await f.read(4); assert.ok(ids(after).includes('OUT-DROP'));
  assert.equal(after.combined.display_level, 'L1'); assert.equal(after.revision, before.revision + 1);
  const history = await f.read(4, before.revision);
  assert.deepEqual(history.raw, before.raw); assert.deepEqual(history.combined, before.combined);
});

test('T13 late baseline updates waiting state results and safety path remains independent', async () => {
  const f = await fixture(); await f.card(S.state, 2, 6); await f.card(S.state, 3, 6); await stable(f, 3);
  assert.equal((await f.read(3)).combined.status, 'pending_baseline');
  await f.card(S.baseline, 0, 7, { answers: { d1: 2 } });
  const result = await f.read(3); assert.ok(ids(result).includes('OUT-DROP')); assert.ok(ids(result).includes('DISSOC'));
  assert.equal(result.combined.display_level, 'L3');
  assert.equal(result.raw.signals.find((s) => s.rule_id === 'DISSOC').signal_id, documentKey('case', 0, 'DISSOC'));
});

test('T13 rejected and abandoned cards do not complete a combination or create signals', async () => {
  const f = await dropFixture(); await f.card(S.state, 3, 6);
  const p = await f.prepare(S.feel, 3), before = await f.read(3);
  await f.flow.submit(p.who, { ...p.input, answers: {} });
  assert.deepEqual(await f.read(3), before);
  await f.flow.abandon(p.who, { match_id: 'case', event_id: p.event.event_id, request_id: 'leave' });
  assert.deepEqual(await f.read(3), before);
});

test('T13 source version policy is deterministic and later releases do not reinterpret saved results', async () => {
  const f = await dropFixture(); await f.card(S.state, 3, 6);
  const next = defaultVersionBundle(); next.rules.thresholds.diff_post_warn = 1;
  await f.provenance.publishVersions({ ...next, rule_version: 'rules-later', published_by: 'test', expected_revision: 1 });
  await f.card(S.feel, 3, 9); await f.card(S.pro, 3, 9);
  const result = await f.read(3);
  assert.equal(result.raw.policy.rule_version, 'rules-t03-v1'); assert.equal(result.combined.downgraded, true);
  assert.ok(result.combined.source_bases.some((e) => e.basis_ref.rule_version === 'rules-later'));
  const before = f.db.snapshot(); await f.combos.refresh('case'); assert.deepEqual(f.db.snapshot(), before);
});

test('T13 a normal case has no raw signal IDs and no notification or clinical label', async () => {
  const f = await fixture(); await f.card(S.baseline, 0, 7); await f.card(S.state, 2, 7); await stable(f, 2);
  const result = await f.read(2); assert.deepEqual(result.raw.signals, []); assert.equal(result.combined.display_level, null);
  assert.equal(/恶化|病情|未察觉/.test(JSON.stringify(result)), false);
});

test('T13 enqueue failure rolls back the answer and receipt as one transaction', async () => {
  const f = await fixture(), p = await f.prepare(S.state, 2), before = f.db.snapshot();
  f.db.failNextWriteTo(C.combinationJobs);
  await assert.rejects(f.flow.submit(p.who, p.input), /Injected storage failure/);
  assert.deepEqual(f.db.snapshot(), before);
  assert.equal((await f.flow.submit(p.who, p.input)).event.status, 'submitted');
});

test('T13 derived write failure retains durable job and same request retry resumes without rescoring', async () => {
  const f = await fixture(), p = await f.prepare(S.state, 2);
  f.db.failNextWriteTo(C.combinationHistory);
  await assert.rejects(f.flow.submit(p.who, p.input), { code: 'XG_COMBINATION_PENDING' });
  assert.equal((await f.db.get(C.events, p.event.event_id)).status, 'submitted');
  assert.equal(f.db.snapshot()[C.submissions].size, 1);
  assert.equal(f.db.snapshot()[C.combinationHistory].size, 0); assert.equal(f.db.snapshot()[C.rawSignals].size, 0);
  assert.equal((await f.db.get(C.combinationJobs, 'case')).status, 'pending');
  const replay = await f.flow.submit(p.who, p.input); assert.equal(replay.replayed, true);
  assert.equal(f.db.snapshot()[C.eventTransitions].size, 2); assert.equal(f.db.snapshot()[C.requestReceipts].size, 2);
  assert.equal((await f.db.get(C.combinationJobs, 'case')).status, 'complete');
});

test('T13 duplicate submit and competing recompute workers cannot append duplicate history', async () => {
  const f = await fixture(), p = await f.prepare(S.feel, 2); await f.flow.submit(p.who, p.input);
  const before = f.db.snapshot();
  await Promise.all([f.flow.submit(p.who, p.input), f.combos.refresh('case'), f.combos.refresh('case')]);
  assert.deepEqual(f.db.snapshot(), before);
});

test('T13 a case changed during snapshot read restarts instead of publishing stale results', async () => {
  const f = await fixture(), p = await f.prepare(S.state, 2);
  f.db.failNextWriteTo(C.combinationHistory);
  await assert.rejects(f.flow.submit(p.who, p.input), { code: 'XG_COMBINATION_PENDING' });
  let changed = false;
  const wrapped = { ...f.db, async eventsForMatch(id) {
    const rows = await f.db.eventsForMatch(id);
    if (!changed) { changed = true; await f.db.transaction(async (tx) => { const m = await tx.get(C.matches, id); await tx.put(C.matches, id, { ...m, version: m.version + 1 }); }); }
    return rows;
  } };
  await createCombinationRepository(wrapped).refresh('case');
  assert.equal(f.db.snapshot()[C.combinationHistory].size, 1); assert.equal((await f.db.get(C.combinationJobs, 'case')).status, 'complete');
});

test('T13 cycles and session numbers never borrow missing counterpart cards', async () => {
  const f = await fixture(); await f.repo.createMatch({ match_id: 'other', visitor_id: 'v', counselor_id: 'other-c', assessment_id: 'other-intake' });
  await f.card(S.feel, 2, 9); await f.card(S.pro, 3, 6);
  await f.card(S.pro, 2, 6, { match: 'other', counselor: 'other-c' });
  const result = await f.read(2); assert.equal(result.combined.event_ids.pro, null); assert.equal(ids(result).includes('ALL-GAP'), false);
});

test('T13 admin audit protects current/history scopes, pending recovery and stored output integrity', async (t) => {
  const f = await dropFixture(); await f.card(S.state, 3, 6); const old = await f.read(3); await stable(f, 3);
  const secret = 't13-http';
  const store = { assessment: f.repo, consent: f.consent, lifecycle: f.flow, provenance: f.provenance,
    identity: createIdentityRepository(f.db), async list() { return []; }, async findById(_table, id) { return { id, is_active: true, review_status: 'approved' }; } };
  const server = http.createServer(createRequestHandler({ store, sessionSecret: secret }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((resolve) => server.close(resolve)));
  async function get(query, role = 'admin', method = 'GET') {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/xg/admin/session-combination?${query}`, {
      method, headers: role ? { authorization: `Bearer ${signSession(actor(role), secret)}` } : {} });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  }
  const query = 'match_id=case&session_no=3';
  const response = await get(query); assert.equal(response.status, 200); assert.equal(response.cache, 'no-store');
  assert.equal(response.body.combined.display_level, 'L1');
  assert.equal(JSON.stringify(response.body).includes('raw_answers'), false);
  assert.equal((await get(`${query}&revision=${old.revision}`)).body.combined.display_level, 'L2');
  for (const role of ['visitor', 'counselor']) assert.equal((await get(query, role)).status, 403);
  assert.equal((await get(query, null)).status, 401);
  for (const suffix of ['&session_no=4', '&other=1', '&revision=0', '&revision=-1']) assert.equal((await get(query + suffix)).status, 400);
  assert.equal((await get('match_id=case&session_no=999')).status, 404);
  assert.equal((await get(query, 'admin', 'POST')).status, 404);
  const id = documentKey('case', 3), raw = await f.db.get(C.rawSignals, id);
  await f.db.transaction((tx) => tx.put(C.rawSignals, id, { ...raw, signals: [{ secret: 'DO_NOT_ECHO' }] }));
  const bad = await get(query); assert.equal(bad.status, 503); assert.equal(JSON.stringify(bad.body).includes('DO_NOT_ECHO'), false);
});

test('T13 independent stabilization evidence survives stable-alliance composition', async () => {
  const f = await fixture(); await f.card(S.baseline, 0, 7);
  await f.provenance.setCaseConfig('case', { optional_enabled: true, focus_text: null, expected_revision: 0, changed_by: 'c' });
  for (const n of [2, 3]) await f.card(S.state, n, 6, { answers: { s8: 2, s9: 9, s10: 9 } });
  await stable(f, 3);
  const result = await f.read(3);
  assert.ok(ids(result).includes('OUT-DROP')); assert.ok(ids(result).includes('STAB-SELF'));
  assert.equal(result.combined.original_level, 'L2'); assert.equal(result.combined.display_level, 'L2');
});

test('T13 missing prior sessions never create consecutive alliance signals; late M2 repairs the window', async () => {
  const f = await fixture(); await f.card(S.feel, 2, 6); await f.card(S.feel, 4, 6);
  assert.equal(ids(await f.read(4)).includes('ALL-TOTAL'), false);
  await f.card(S.feel, 3, 6);
  assert.equal(ids(await f.read(4)).includes('ALL-TOTAL'), true);
});

test('T13 latest audit recovers pending work and fails closed under repeated revision races', async () => {
  const f = await fixture(), p = await f.prepare(S.state, 2);
  f.db.failNextWriteTo(C.combinationHistory);
  await assert.rejects(f.flow.submit(p.who, p.input), { code: 'XG_COMBINATION_PENDING' });
  const wrapped = { ...f.db, async eventsForMatch(id) {
    const rows = await f.db.eventsForMatch(id);
    await f.db.transaction(async (tx) => { const m = await tx.get(C.matches, id); await tx.put(C.matches, id, { ...m, version: m.version + 1 }); });
    return rows;
  } };
  await assert.rejects(createCombinationRepository(wrapped).read('case', 2), { code: 'XG_COMBINATION_PENDING' });
  assert.equal((await f.db.get(C.combinationJobs, 'case')).status, 'pending');
  assert.equal((await f.read(2)).combined.status, 'pending_cards');
  assert.equal((await f.db.get(C.combinationJobs, 'case')).status, 'complete');
});

test('T13 a missing/corrupt source basis or mismatched ownership never produces a guessed evaluation', async () => {
  const f = await fixture(); await f.card(S.state, 2, 6);
  const match = await f.repo.getMatch('case'), events = await f.repo.listEvents('case');
  const missing = structuredClone(events); delete missing[0].basis;
  assert.throws(() => evaluateCombinations(match, missing), { code: 'XG_BASIS_REQUIRED' });
  const wrong = structuredClone(events); wrong[0].counselor_id = 'wrong';
  assert.throws(() => evaluateCombinations(match, wrong), { code: 'XG_SCOPE_MISMATCH' });
  const scores = structuredClone(events); scores[0].scores.total = 1;
  assert.throws(() => evaluateCombinations(match, scores), { code: 'XG_COMBINATION_SCORES_MISMATCH' });
});
