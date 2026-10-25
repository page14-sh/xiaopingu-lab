const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createAssessmentRepository } = require('./repository');
const { createProvenanceRepository, contentHash } = require('./provenance');
const { createIdentityRepository } = require('./identity-repository');
const { evaluateCombinations } = require('./combination-engine');
const { processAnswers } = require('./answer-processor');
const { consecutiveWindow } = require('./consecutive-window');
const { validateThresholds, parameterSchema } = require('./signal-parameters');
const { memoryAssessmentStore } = require('./test-support');
const { COLLECTIONS: C, SCALES: S } = require('./model');
const { createRequestHandler, signSession } = require('../app');
const defaults = require('./definitions/rules-t03-v1.json').thresholds;
const split = (prefix, count, total) => Object.fromEntries(Array.from({ length: count }, (_, i) =>
  [`${prefix}${i + 1}`, Math.floor(total / count) + (i < total % count ? 1 : 0)]));

// Capture real immutable bases, then feed independently controlled successful
// observations to the pure evaluator. Transaction/retry integration remains in T13.
async function fixture(patch = {}) {
  const db = memoryAssessmentStore(), repo = createAssessmentRepository(db), provenance = createProvenanceRepository(db);
  await repo.createMatch({ match_id: 'case', visitor_id: 'v', counselor_id: 'c', assessment_id: 'intake' });
  const rows = []; let serial = 0, config = 0;
  async function publish(thresholds, extra = {}) {
    const head = await provenance.getThresholds();
    return provenance.publishThresholds({ rule_version: `test-rules-${++serial}`, expected_revision: head.revision,
      thresholds, reason: 'Automated test', published_by: 'admin', ...extra });
  }
  if (Object.keys(patch).length) await publish(patch);
  async function optional(enabled) {
    await provenance.setCaseConfig('case', { optional_enabled: enabled, focus_text: null, expected_revision: config++, changed_by: 'c' });
  }
  async function add(scale, session, total = 42, extras = {}) {
    const event = await repo.insertEvent({ match_id: 'case', event_id: `event-${++serial}`, scale_code: scale, session_no: session,
      status: 'started', scores: {}, raw_answers: {} });
    const input = Object.fromEntries(event.basis.items.filter((i) => i.applicable).map((i) => [i.code,
      i.item_type === 'single_choice' ? (i.code === 'p6' ? 5 : 0) : 6]));
    if ([S.baseline, S.state].includes(scale)) Object.assign(input, split('s', 7, total));
    if (scale === S.feel) Object.assign(input, split('f', 4, total));
    if (scale === S.pro && session > 1) Object.assign(input, split('p', 5, total - 5));
    Object.assign(input, extras);
    const result = processAnswers(event.basis, input, 100000);
    assert.equal(result.valid, true);
    Object.assign(event, { status: 'submitted', raw_answers: result.answers, scores: result.scores,
      quality_flag: result.quality_flag, duration_ms: 100000, submitted_at: '2026-10-25T00:00:00Z' });
    rows.push(event); return event;
  }
  async function result(session) { return evaluateCombinations(await repo.getMatch('case'), rows).find((r) => r.session_no === session); }
  async function has(session, rule) { return (await result(session)).raw.signals.some((s) => s.rule_id === rule); }
  return { db, repo, provenance, rows, publish, optional, add, result, has };
}

for (const [total, expected] of [[20,true],[21,false],[22,false]]) {
  test(`T14 OUT-LOW strict boundary ${total}/70`, async () => {
    const f = await fixture(); await f.add(S.baseline, 0, 0); await f.add(S.state, 2, total);
    assert.equal(await f.has(2, 'OUT-LOW'), expected);
  });
}
for (const [values, expected] of [[[42,42],true],[[43,42],false],[[42,43],false]]) {
  test(`T14 OUT-DROP inclusive seven-point boundary ${values}`, async () => {
    const f = await fixture(); await f.add(S.baseline, 0, 49);
    for (const [i, value] of values.entries()) await f.add(S.state, i + 2, value);
    assert.equal(await f.has(3, 'OUT-DROP'), expected);
  });
}
for (const [values, mono, accel] of [
  [[42,35,28],true,true], [[42,42,35],false,true], [[34,35,28],false,false], [[42,41,35],true,false]
]) {
  test(`T14 monotonic/accelerated semantics ${values}`, async () => {
    const f = await fixture(); await f.add(S.baseline, 0, 49);
    for (const [i, value] of values.entries()) await f.add(S.state, i + 2, value);
    assert.equal(await f.has(4, 'OUT-MONO'), mono); assert.equal(await f.has(4, 'OUT-ACCEL'), accel);
  });
}
for (const [values, expected] of [
  [[47,49,50,51],true], [[46,49,50,51],false], [[49,49,49,52],false], [[30,31,32,33],false]
]) {
  test(`T14 OUT-FLAT is strict distance from baseline ${values}`, async () => {
    const f = await fixture(); await f.add(S.baseline, 0, 49);
    for (const [i, value] of values.entries()) await f.add(S.state, i + 2, value);
    assert.equal(await f.has(5, 'OUT-FLAT'), expected);
  });
}

test('T14 OUT-SINGLE is inclusive but suppressed by a higher outcome signal', async () => {
  for (const [total, single] of [[42,true],[43,false],[20,false]]) {
    const f = await fixture(); await f.add(S.baseline, 0, 49); await f.add(S.state, 2, total);
    assert.equal(await f.has(2, 'OUT-SINGLE'), single);
  }
});

for (const [total, expected] of [[28,true],[29,false]]) {
  test(`T14 ALL-TOTAL inclusive boundary ${total}`, async () => {
    const f = await fixture(); await f.add(S.feel, 1, total); await f.add(S.feel, 2, total);
    assert.equal(await f.has(2, 'ALL-TOTAL'), expected);
  });
}

test('T14 ALL-DIM can hit different items on adjacent sessions and retains both item codes', async () => {
  const f = await fixture(); await f.add(S.feel, 1, 36, { f1: 3 }); await f.add(S.feel, 2, 36, { f2: 3 });
  const hit = (await f.result(2)).raw.signals.find((s) => s.rule_id === 'ALL-DIM');
  assert.deepEqual(hit.facts.items.map((i) => i.codes), [['f1'], ['f2']]);
  const g = await fixture(); await g.add(S.feel, 1, 36, { f1: 4 }); await g.add(S.feel, 2, 36, { f2: 4 });
  assert.equal(await g.has(2, 'ALL-DIM'), false);
});

for (const [pro, expected] of [[35,true],[36,true],[37,false]]) {
  test(`T14 ALL-GAP 15-point boundary with M2=30 and M3=${pro}`, async () => {
    const f = await fixture(); await f.add(S.feel, 2, 30); await f.add(S.pro, 2, pro);
    assert.equal(await f.has(2, 'ALL-GAP'), expected);
  });
}

for (const scale of [S.state, S.pro]) {
  test(`T14 stabilization ${scale}: three-point boundary, optional gating and disabled gap`, async () => {
    const rule = scale === S.state ? 'STAB-SELF' : 'STAB-PRO', key = scale === S.state ? 's8' : 'p4';
    for (const [value, expected] of [[3,true],[4,false]]) {
      const f = await fixture(); await f.optional(true);
      await f.add(scale, 2, 42, { [key]: value }); await f.add(scale, 3, 42, { [key]: value });
      assert.equal(await f.has(3, rule), expected);
    }
    const f = await fixture();
    await f.add(scale, 2, 42, scale === S.pro ? { p4: 0 } : {});
    await f.optional(true); await f.add(scale, 3, 42, { [key]: 0 });
    assert.equal(await f.has(3, rule), false);
    await f.optional(false); await f.add(scale, 4, 42, scale === S.pro ? { p4: 0 } : {});
    await f.optional(true); await f.add(scale, 5, 42, { [key]: 0 });
    assert.equal(await f.has(5, rule), false);
    await f.add(scale, 6, 42, { [key]: 0 }); assert.equal(await f.has(6, rule), true);
  });
}

test('T14 DISSOC is exactly d1=2 and remains independent of all-zero core', async () => {
  for (const value of [0,1,2]) {
    const f = await fixture(); await f.add(S.baseline, 0, 0, { d1: value });
    assert.equal(await f.has(0, 'DISSOC'), value === 2);
  }
});

test('T14 rejected/abandoned/missing sessions break windows; other cards cannot fill the gap', async () => {
  for (const status of ['missing', 'rejected', 'abandoned']) {
    const f = await fixture(); await f.add(S.baseline, 0, 49); await f.add(S.state, 2, 42);
    if (status !== 'missing') { const middle = await f.add(S.state, 3, 42); middle.status = status; }
    await f.add(S.feel, 3, 28); await f.add(S.state, 4, 42);
    assert.equal(await f.has(4, 'OUT-DROP'), false);
  }
});

test('T14 first-session recheck supplies reference but never counts toward a regular window', async () => {
  const f = await fixture(); await f.add(S.baseline, 0, 70); await f.add(S.state, 1, 49);
  await f.add(S.state, 2, 42); assert.equal(await f.has(2, 'OUT-DROP'), false);
  await f.add(S.state, 3, 42); assert.equal(await f.has(3, 'OUT-DROP'), true);
  const signal = (await f.result(3)).raw.signals.find((s) => s.rule_id === 'OUT-DROP');
  assert.deepEqual(signal.window_sessions, [2,3]); assert.equal(signal.facts.reference_total, 49);
});

test('T14 missing histories are not padded and huge configured windows return safely', async () => {
  assert.deepEqual(consecutiveWindow(new Map([[2, {}], [4, {}]]), 4, 2, 2), []);
  assert.deepEqual(consecutiveWindow(new Map([[2, {}]]), 2, Number.MAX_SAFE_INTEGER, 2), []);
  assert.deepEqual(consecutiveWindow(new Map([[1, {}], [2, {}]]), 2, 2, 2), []);
  const f = await fixture({ outcome_drop_consecutive: Number.MAX_SAFE_INTEGER });
  await f.add(S.baseline, 0, 49); await f.add(S.state, 2, 42); await f.add(S.state, 3, 42);
  assert.equal(await f.has(3, 'OUT-DROP'), false);
});

test('T14 changed consecutive lengths require the complete configured window', async () => {
  const f = await fixture({ outcome_drop_consecutive: 3, alliance_consecutive: 3, stability_consecutive: 3 });
  await f.add(S.baseline, 0, 49); await f.optional(true);
  for (const n of [2,3,4]) {
    await f.add(S.state, n, 42, { s8: 0 }); await f.add(S.feel, n, 28); await f.add(S.pro, n, 42, { p4: 0 });
    for (const rule of ['OUT-DROP','ALL-TOTAL','STAB-SELF','STAB-PRO']) assert.equal(await f.has(n, rule), n === 4, rule);
  }
  const g = await fixture({ outcome_flat_consecutive: 2 }); await g.add(S.baseline, 0, 49);
  await g.add(S.state, 2, 49); await g.add(S.state, 3, 49); assert.equal(await g.has(3, 'OUT-FLAT'), true);
});

for (const [values, expected] of [[[35,42,42,35],false],[[49,42,42,35],true]]) {
  test(`T14 N=4 acceleration checks the entire prior window ${values}`, async () => {
    const f = await fixture({ l3_consecutive: 4 }); await f.add(S.baseline, 0, 49);
    for (const [i, value] of values.entries()) await f.add(S.state, i + 2, value);
    assert.equal(await f.has(5, 'OUT-ACCEL'), expected);
    if (expected) {
      const signal = (await f.result(5)).raw.signals.find((s) => s.rule_id === 'OUT-ACCEL');
      assert.deepEqual(signal.window_sessions, [2,3,4,5]); assert.equal(signal.parameters.l3_consecutive, 4);
    }
  });
}

test('T14 N=4 monotonic decline needs all four adjacent observations', async () => {
  const f = await fixture({ l3_consecutive: 4 }); await f.add(S.baseline, 0, 49);
  for (const [i, total] of [42,35,28,21].entries()) await f.add(S.state, i + 2, total);
  assert.equal(await f.has(4, 'OUT-MONO'), false); assert.equal(await f.has(5, 'OUT-MONO'), true);
});

for (const [patch, rule, scale, values, expected] of [
  [{outcome_drop_abs:8}, 'OUT-DROP', S.state, [41,41], true],
  [{outcome_drop_abs:8}, 'OUT-DROP', S.state, [42,42], false],
  [{l3_low_pct:20}, 'OUT-LOW', S.state, [13], true],
  [{l3_low_pct:20}, 'OUT-LOW', S.state, [14], false],
  [{alliance_total_max:25}, 'ALL-TOTAL', S.feel, [25,25], true],
  [{alliance_total_max:25}, 'ALL-TOTAL', S.feel, [26,26], false],
  [{outcome_flat_delta:2,outcome_flat_consecutive:2}, 'OUT-FLAT', S.state, [48,50], true],
  [{outcome_flat_delta:2,outcome_flat_consecutive:2}, 'OUT-FLAT', S.state, [47,50], false]
]) {
  test(`T14 configurable boundary ${rule} ${JSON.stringify(patch)} ${values}`, async () => {
    const f = await fixture(patch); await f.add(S.baseline, 0, 49);
    for (const [i, value] of values.entries()) await f.add(scale, i + 2, value);
    assert.equal(await f.has(values.length + 1, rule), expected);
  });
}

test('T14 zero-valued maximum thresholds are meaningful and accept only zero observations', async () => {
  const f = await fixture({ alliance_total_max: 0, alliance_dim_max: 0, stability_item_max: 0 }); await f.optional(true);
  for (const n of [2,3]) {
    await f.add(S.feel, n, 0); await f.add(S.state, n, 42, { s8: 0 }); await f.add(S.pro, n, 42, { p4: 0 });
  }
  for (const rule of ['ALL-TOTAL','ALL-DIM','STAB-SELF','STAB-PRO']) assert.equal(await f.has(3, rule), true);
});

test('T14 decimal gap thresholds compare unrounded ratios, not the displayed two decimals', async () => {
  const f = await fixture({ diff_post_warn: 13.334 });
  await f.add(S.feel, 2, 28); await f.add(S.pro, 2, 34); // 70 - 56.666... = 13.333...
  assert.equal(await f.has(2, 'ALL-GAP'), false);
  assert.equal((await f.result(2)).combined.diff_post, 13.33);
  const g = await fixture({ diff_post_warn: 13.333 }); await g.add(S.feel, 2, 28); await g.add(S.pro, 2, 34);
  assert.equal(await g.has(2, 'ALL-GAP'), true);
});

test('T14 changed policy uses one frozen target policy across old and new window observations', async () => {
  const f = await fixture(); await f.add(S.baseline, 0, 49); await f.add(S.state, 2, 42); await f.add(S.state, 3, 42);
  const original = await f.result(3);
  await f.publish({ outcome_drop_abs: 8 });
  assert.deepEqual(await f.result(3), original);
  await f.add(S.state, 4, 42); assert.equal(await f.has(4, 'OUT-DROP'), false);
  const newest = await f.result(4);
  assert.equal(newest.raw.policy.thresholds.outcome_drop_abs, 8);
  assert.equal(newest.raw.policy.engine_id, 'xg-combination-t03-v2');
  assert.equal(original.raw.policy.thresholds.outcome_drop_abs, 7);
});

test('T14 unsafe threshold values and impossible window lengths fail before publication', async () => {
  const f = await fixture(), before = f.db.snapshot();
  const patches = [{}, { unknown: 1 }, { l3_consecutive: 2 }, { outcome_drop_consecutive: 1 },
    { alliance_consecutive: 2.5 }, { stability_consecutive: Number.MAX_SAFE_INTEGER + 1 },
    { outcome_drop_abs: 71 }, { outcome_flat_delta: 0 }, { alliance_total_max: 41 },
    { alliance_dim_max: 11 }, { stability_item_max: -1 }, { diff_post_warn: 101 }, { l3_low_pct: 0 }];
  for (const value of [null, '3', true, [], {}, NaN, Infinity, -Infinity]) patches.push({ outcome_drop_abs: value });
  for (const patch of patches) await assert.rejects(f.provenance.publishThresholds({ rule_version: 'invalid', expected_revision: 1,
    thresholds: patch, reason: 'test', published_by: 'admin' }), { code: 'XG_RULE_PARAMETERS_INVALID' });
  assert.deepEqual(f.db.snapshot(), before);
  assert.throws(() => validateThresholds({ outcome_drop_abs: 7 }), { code: 'XG_RULE_PARAMETERS_INVALID' });
  assert.deepEqual(validateThresholds(defaults), defaults);
});

test('T14 version updates are immutable, optimistic, auditable and atomically rolled back on failure', async () => {
  const f = await fixture();
  const change = { rule_version: 'v2', expected_revision: 1, thresholds: { outcome_drop_abs: 8 }, reason: 'test rationale', published_by: 'admin' };
  const before = f.db.snapshot(); f.db.failNextWriteTo(C.assessmentRelease);
  await assert.rejects(f.provenance.publishThresholds(change), /Injected storage failure/); assert.deepEqual(f.db.snapshot(), before);
  const applied = await f.provenance.publishThresholds(change); assert.equal(applied.revision, 2);
  const record = await f.db.get(C.ruleVersions, 'v2');
  assert.equal(record.previous_rule_version, 'rules-t03-v1'); assert.equal(record.threshold_change.reason, 'test rationale');
  assert.equal(record.content_hash, contentHash(record.definition));
  const saved = f.db.snapshot(); assert.equal((await f.provenance.publishThresholds(change)).duplicated, true); assert.deepEqual(f.db.snapshot(), saved);
  await assert.rejects(f.provenance.publishThresholds({ ...change, thresholds: { outcome_drop_abs: 9 } }), { code: 'XG_VERSION_IMMUTABLE' });
  await assert.rejects(f.provenance.publishThresholds({ ...change, rule_version: 'stale' }), { code: 'XG_VERSION_CONFLICT' });
  await f.publish({ outcome_drop_abs: 9 });
  await assert.rejects(f.provenance.publishThresholds(change), { code: 'XG_VERSION_IMMUTABLE' }); // Cannot reactivate v2.
});

test('T14 concurrent config writers admit one new release without losing the winner', async () => {
  const f = await fixture();
  const results = await Promise.allSettled([8,9].map((value) => f.provenance.publishThresholds({ rule_version: `v-${value}`,
    expected_revision: 1, thresholds: { outcome_drop_abs: value }, reason: 'test', published_by: 'admin' })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'XG_VERSION_CONFLICT');
  assert.equal((await f.provenance.getThresholds()).revision, 2); assert.equal(f.db.snapshot()[C.ruleVersions].size, 2);
});

test('T14 configuration never modifies captured cards, historical versions or recompute jobs', async () => {
  const f = await fixture(); const old = await f.add(S.state, 2, 42); const before = f.db.snapshot();
  await f.publish({ outcome_drop_abs: 8, l3_consecutive: 4 });
  const after = f.db.snapshot();
  for (const collection of Object.values(C).filter((c) => ![C.ruleVersions, C.assessmentRelease].includes(c))) assert.deepEqual(after[collection], before[collection]);
  assert.deepEqual(after[C.ruleVersions].get('rules-t03-v1'), before[C.ruleVersions].get('rules-t03-v1'));
  assert.equal(old.basis.rules.thresholds.outcome_drop_abs, 7);
  const fresh = await f.add(S.state, 3, 42); assert.equal(fresh.basis.rules.thresholds.outcome_drop_abs, 8);
});

test('T14 admin configuration HTTP validates identity, schema and author instead of trusting client metadata', async (t) => {
  const f = await fixture(), secret = 't14-http-test';
  await f.db.transaction((tx) => tx.put(C.visitors, 'v', { visitor_id: 'v', provider: 'wechat-cloud' }));
  const store = { assessment: f.repo, provenance: f.provenance, identity: createIdentityRepository(f.db), async list() { return []; },
    async findById(_table, id) { return { id, is_active: true, review_status: 'approved' }; } };
  const server = http.createServer(createRequestHandler({ store, sessionSecret: secret }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((resolve) => server.close(resolve)));
  async function request(method = 'GET', body, role = 'admin', query = '') {
    const principal = { role, subject: role === 'visitor' ? 'v' : role === 'counselor' ? 'c' : 'admin', aud: 'xg-assessment', demo: false,
      auth_method: role === 'visitor' ? 'wechat-cloud' : role === 'counselor' ? 'counselor-edit' : 'admin-password', exp: Date.now() + 60000 };
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/xg/admin/rule-thresholds${query}`, { method,
      headers: { 'content-type': 'application/json', ...(role ? { authorization: `Bearer ${signSession(principal, secret)}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  }
  const input = { rule_version: 'http-v2', expected_revision: 1, thresholds: { outcome_drop_abs: 8 }, reason: 'Admin review' };
  const read = await request(); assert.equal(read.status, 200); assert.equal(read.cache, 'no-store'); assert.deepEqual(read.body.parameters, parameterSchema());
  for (const role of ['visitor','counselor']) for (const method of ['GET','POST']) assert.equal((await request(method, method === 'POST' ? input : undefined, role)).status, 403);
  assert.equal((await request('GET', undefined, null)).status, 401);
  assert.equal((await request('POST', { ...input, published_by: 'forged' })).status, 400);
  assert.equal((await request('POST', { ...input, reason: '' })).status, 400);
  assert.equal((await request('GET', undefined, 'admin', '?revision=1')).status, 400);
  assert.equal((await request('POST', { ...input, thresholds: { l3_consecutive: 1 } })).status, 400);
  const updated = await request('POST', input); assert.equal(updated.status, 201); assert.equal(updated.body.published_by, 'admin');
  assert.equal((await request('POST', input)).status, 200);
  assert.equal((await request('POST', { ...input, rule_version: 'old-base' })).status, 409);
  assert.equal((await request('POST', { ...input, rule_version: 'no-change', expected_revision: 2 })).body.error.code, 'XG_RULE_NO_CHANGE');
  assert.equal((await request('DELETE')).status, 404);
});

test('T14 changed item thresholds apply to both alliance and stabilization at the exact boundary', async () => {
  for (const [value, expected] of [[2,true],[3,false]]) {
    const f = await fixture({ alliance_dim_max: 2, stability_item_max: 2 }); await f.optional(true);
    for (const n of [2,3]) {
      await f.add(S.feel, n, 36, { f1: value }); await f.add(S.state, n, 42, { s8: value }); await f.add(S.pro, n, 42, { p4: value });
    }
    for (const rule of ['ALL-DIM','STAB-SELF','STAB-PRO']) assert.equal(await f.has(3, rule), expected, rule);
  }
});

test('T14 historical invalid window settings stop evaluation instead of silently disabling a signal', async () => {
  const f = await fixture(); const event = await f.add(S.state, 2, 42);
  event.basis.rules.thresholds.l3_consecutive = 2;
  event.basis.rule_hash = contentHash(event.basis.rules);
  const { basis_hash, ...basis } = event.basis; event.basis.basis_hash = contentHash(basis);
  assert.throws(() => evaluateCombinations({ match_id: 'case', visitor_id: 'v', counselor_id: 'c' }, f.rows),
    { code: 'XG_RULE_PARAMETERS_INVALID', statusCode: 503 });
});
