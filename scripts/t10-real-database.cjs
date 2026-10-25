// Opt-in integration acceptance. Never imported by the application or unit suite.
// Requires an authorized tcb CLI; credentials remain in memory and are never logged.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomBytes } = require('node:crypto');
const { writeFileSync, mkdirSync, readFileSync } = require('node:fs');
const path = require('node:path');
const exec = promisify(execFile);
const root = path.resolve(__dirname, '..');
const runtime = path.join(root, 'cloudrun/xiaopingu-api');
const tcb = require(path.join(runtime, 'node_modules/@cloudbase/node-sdk'));
const { createCloudBaseAssessmentStore } = require(path.join(runtime, 'assessment/cloudbase-store'));
const { createAssessmentRepository } = require(path.join(runtime, 'assessment/repository'));
const { createConsentRepository } = require(path.join(runtime, 'assessment/consent'));
const { createProvenanceRepository, defaultVersionBundle } = require(path.join(runtime, 'assessment/provenance'));
const { createEventLifecycle } = require(path.join(runtime, 'assessment/event-lifecycle'));
const { COLLECTIONS: C, SCALES: S } = require(path.join(runtime, 'assessment/model'));
const env = 'xpg-demo-d3gzsswtcc3233ea0';
const prefix = `xg_t10_${Date.now()}_${randomBytes(3).toString('hex')}_`;
const names = new Map(Object.values(C).map((name) => [name, prefix + name.slice(3)]));
const report = { env, prefix, started_at: new Date().toISOString(), tests: [], created: [], acl: {}, cleanup: [], transaction_events: {} };
const output = path.join(root, 'outputs/t10', `${prefix}report.json`);
mkdirSync(path.dirname(output), { recursive: true });
function persist() { writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
function safeCode(error) { return String(error?.code || error?.name || 'ERROR').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 100); }
async function cli(args) {
  let stdout;
  try { ({ stdout } = await exec('tcb', args, { timeout: 45000, maxBuffer: 2 * 1024 * 1024 })); }
  catch (error) {
    let code = 'CLI_FAILED';
    try { code = JSON.parse(error.stdout.slice(error.stdout.indexOf('{'))).error?.code || code; } catch { /* Non-JSON output is deliberately not logged. */ }
    throw Object.assign(new Error('CloudBase CLI call failed'), { code });
  }
  const parsed = JSON.parse(stdout.slice(stdout.indexOf('{')));
  if (parsed.error) throw Object.assign(new Error('CloudBase CLI error'), { code: parsed.error.code });
  return parsed.data || parsed;
}
async function api(action, body) {
  const result = await cli(['api', 'tcb', action, '--api-version', '2018-06-08', '--body', JSON.stringify({ EnvId: env, ...body }), '--json']);
  const data = result.Response || result;
  if (data.Error) throw Object.assign(new Error('CloudBase API error'), { code: data.Error.Code });
  return data;
}
function checked(result) {
  if (!result || result.code) throw Object.assign(new Error('SDK operation failed'), { code: result?.code || 'SDK_EMPTY' });
  return result;
}
let creds;
function physical(name) { assert.ok(names.has(name), 'Refuse unmapped collection'); return names.get(name); }
function client({ loseCommit = false, failReceipt = false } = {}) {
  const db = tcb.init({ env, region: 'ap-shanghai', secretId: creds.secretId, secretKey: creds.secretKey, sessionToken: creds.token }).database();
  let lost = false;
  const mapped = { collection: (name) => db.collection(physical(name)), async startTransaction() {
    const tx = await db.startTransaction();
    return { collection(name) {
      const collection = tx.collection(physical(name));
      if (failReceipt && name === C.requestReceipts) return { doc(id) { return { get: () => collection.doc(id).get(),
        set() { throw Object.assign(new Error('Injected receipt failure'), { code: 'TEST_RECEIPT_FAILURE' }); } }; } };
      return collection;
    }, async commit() {
      const result = await tx.commit();
      if (loseCommit && !lost) { lost = true; throw Object.assign(new Error('Injected lost response after real commit'), { code: 'TEST_RESPONSE_LOST' }); }
      return result;
    }, rollback: () => tx.rollback() };
  } };
  const store = createCloudBaseAssessmentStore(mapped, { onTransactionEvent(e) {
    report.transaction_events[e.type] = (report.transaction_events[e.type] || 0) + 1;
  } });
  const consent = createConsentRepository(store);
  return { db, store, consent, repo: createAssessmentRepository(store), flow: createEventLifecycle(store, consent) };
}
const actor = (id) => ({ role: 'visitor', subject: id, aud: 'xg-assessment', demo: false, auth_method: 'wechat-cloud', exp: Date.now() + 3600000 });
function answers(event) { return Object.fromEntries(event.basis.items.filter((i) => i.applicable).map((i) => [i.code,
  i.item_type === 'text' ? 'Synthetic T10 test' : i.item_type === 'single_choice' ? i.options[0].value : 6])); }
async function clientRetry(work) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await work(); }
    catch (error) {
      if (!['XG_TRANSACTION_BUSY', 'XG_COMMIT_UNKNOWN'].includes(error.code) || attempt === 3) throw error;
      report.client_retries = (report.client_retries || 0) + 1;
      await new Promise((resolve) => setTimeout(resolve, 400 + Math.random() * 1200));
    }
  }
}
async function allSuccessful(promises) {
  const settled = await Promise.allSettled(promises);
  const failure = settled.find((r) => r.status === 'rejected');
  if (failure) throw failure.reason;
  return settled.map((r) => r.value);
}
async function test(name, work) {
  console.log(`RUN ${name}`);
  const start = Date.now();
  await work();
  report.tests.push({ name, passed: true, duration_ms: Date.now() - start }); persist();
  console.log(`PASS ${name}`);
}
async function main() {
  if (!['--run', '--cleanup'].includes(process.argv[2])) throw new Error('Use --run or --cleanup <report>');
  creds = await cli(['secrets', 'get', '--json']);
  assert.ok(creds.isTemporary && creds.secretId && creds.secretKey && creds.token, 'Temporary CLI credentials required');
  const base = client();
  if (process.argv[2] === '--cleanup') {
    const reportPath = path.resolve(process.argv[3] || '');
    assert.equal(path.dirname(reportPath), path.join(root, 'outputs/t10'));
    const previous = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(previous.env, env);
    assert.match(previous.prefix, /^xg_t10_\d{13}_[a-f0-9]{6}_$/);
    const allowed = new Set(Object.values(C).map((name) => previous.prefix + name.slice(3)));
    previous.cleanup = [];
    for (const name of previous.created) {
      assert.ok(allowed.has(name));
      const preview = await base.db.collection(name).count();
      if (preview.code === 'DATABASE_COLLECTION_NOT_EXIST') {
        previous.cleanup.push({ collection: name, deleted: true }); continue;
      }
      checked(preview); console.log(`CLEANUP ${name} (${preview.total} synthetic records)`);
      await api('DeleteTable', { TableName: name });
      const code = await base.db.collection(name).limit(1).get().then((r) => r.code, (e) => e.code);
      assert.equal(code, 'DATABASE_COLLECTION_NOT_EXIST');
      previous.cleanup.push({ collection: name, deleted: true, record_count: preview.total });
      writeFileSync(reportPath, JSON.stringify(previous, null, 2) + '\n');
    }
    previous.cleanup_finished_at = new Date().toISOString();
    writeFileSync(reportPath, JSON.stringify(previous, null, 2) + '\n');
    console.log('CLEANUP VERIFIED'); return;
  }
  checked(await base.db.collection('counselors').limit(1).count()); // Read-only connectivity check; no document data.
  console.log(`ENV ${env}; isolated prefix ${prefix}`); persist();
  try {
    for (const name of names.values()) {
      checked(await base.db.createCollection(name));
      report.created.push(name); persist();
      await api('ModifyDatabaseACL', { CollectionName: name, AclTag: 'ADMINONLY' });
      const acl = await api('DescribeDatabaseACL', { CollectionName: name });
      assert.equal(acl.AclTag, 'ADMINONLY'); report.acl[name] = acl.AclTag; persist();
      console.log(`READY ${name}`);
    }
    await createProvenanceRepository(base.store).publishVersions({ ...defaultVersionBundle(), published_by: 't10-synthetic', expected_revision: 0 });
    await base.consent.publishPolicy({ scope: 'assessment', version: 't10-test', title: 'TEST ONLY', content: 'Synthetic integration test; not production consent.', published_by: 't10-synthetic', expected_revision: 0 });
    async function setup(id) {
      const who = actor(id);
      await base.store.transaction((tx) => tx.put(C.visitors, id, { visitor_id: id, provider: 'wechat-cloud' }));
      const state = await base.consent.getStatus(id, 'assessment');
      await base.consent.decide(who, { scope: 'assessment', version: state.required_version, document_hash: state.required_document.content_hash,
        agreed: true, channel: 'web', client_event_id: `grant-${id}`, expected_revision: state.revision });
      await base.repo.createMatch({ match_id: id, visitor_id: id, counselor_id: 'synthetic-c', assessment_id: `intake-${id}` });
      const input = { match_id: id, scale_code: S.baseline, session_no: 0, client_event_id: `start-${id}` };
      return { who, input };
    }
    const count = async (collection, match_id) => checked(await base.db.collection(physical(collection)).where({ match_id }).count()).total;
    await test('ten concurrent identical starts and submissions', async () => {
      const { who, input } = await setup('identical');
      const clients = Array.from({ length: 10 }, () => client());
      const starts = await allSuccessful(clients.map((c) => clientRetry(() => c.flow.start(who, input))));
      assert.equal(starts.filter((r) => !r.replayed).length, 1);
      assert.equal(new Set(starts.map((r) => r.event.event_id)).size, 1);
      const event = starts[0].event;
      const body = { match_id: input.match_id, event_id: event.event_id, request_id: 'submit-identical', answers: answers(event) };
      const submissions = await allSuccessful(clients.map((c) => clientRetry(() => c.flow.submit(who, body))));
      assert.equal(submissions.filter((r) => !r.replayed).length, 1);
      for (const [collection, total] of [[C.events, 1], [C.submissions, 1], [C.baselines, 1], [C.eventTransitions, 2], [C.requestReceipts, 2]]) assert.equal(await count(collection, input.match_id), total);
      await assert.rejects(base.flow.submit(who, { ...body, answers: {} }), { code: 'XG_IDEMPOTENCY_CONFLICT' });
    });
    await test('ten distinct attempts compete for one business slot', async () => {
      const { who, input } = await setup('slot');
      const clients = Array.from({ length: 10 }, () => client());
      const started = await allSuccessful(clients.map((c, i) => clientRetry(() => c.flow.start(who, { ...input, client_event_id: `slot-${i}` }))));
      const outcomes = await Promise.allSettled(clients.map((c, i) => clientRetry(() => c.flow.submit(who, { match_id: input.match_id,
        event_id: started[i].event.event_id, request_id: `submit-slot-${i}`, answers: answers(started[i].event) }))));
      assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
      assert.ok(outcomes.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'XG_ALREADY_SUBMITTED'));
      assert.equal(await count(C.submissions, 'slot'), 1); assert.equal(await count(C.baselines, 'slot'), 1);
    });
    await test('concurrent submit and abandon preserve one terminal state', async () => {
      const { who, input } = await setup('terminal'); const { event } = await base.flow.start(who, input);
      const results = await Promise.allSettled([
        client().flow.submit(who, { match_id: input.match_id, event_id: event.event_id, request_id: 'submit-terminal', answers: answers(event) }),
        client().flow.abandon(who, { match_id: input.match_id, event_id: event.event_id, request_id: 'abandon-terminal' })
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.ok(['XG_ALREADY_SUBMITTED', 'XG_EVENT_ABANDONED'].includes(results.find((r) => r.status === 'rejected').reason.code));
      const saved = await base.store.get(C.events, event.event_id);
      assert.equal(await count(C.submissions, input.match_id), saved.status === 'submitted' ? 1 : 0);
      assert.equal(await count(C.eventTransitions, input.match_id), 2);
    });
    await test('old rejected receipt cannot revert a corrected submission', async () => {
      const { who, input } = await setup('correction'); const { event } = await base.flow.start(who, input);
      const body = { match_id: input.match_id, event_id: event.event_id, request_id: 'bad', answers: {} };
      assert.equal((await base.flow.submit(who, body)).statusCode, 422);
      await base.flow.submit(who, { ...body, request_id: 'good', answers: answers(event) });
      const retry = await client().flow.submit(who, body);
      assert.equal(retry.request_status, 'rejected'); assert.equal(retry.event.status, 'submitted');
      assert.equal(retry.statusCode, 422); assert.equal(await count(C.eventTransitions, input.match_id), 3);
    });
    await test('receipt write failure rolls back all dependent documents', async () => {
      const { who, input } = await setup('rollback'); const { event } = await base.flow.start(who, input);
      const body = { match_id: input.match_id, event_id: event.event_id, request_id: 'rollback', answers: answers(event) };
      await assert.rejects(client({ failReceipt: true }).flow.submit(who, body), { code: 'TEST_RECEIPT_FAILURE' });
      assert.equal((await base.store.get(C.events, event.event_id)).status, 'started');
      assert.equal(await count(C.submissions, input.match_id), 0); assert.equal(await count(C.baselines, input.match_id), 0);
      assert.equal(await count(C.eventTransitions, input.match_id), 1); assert.equal(await count(C.requestReceipts, input.match_id), 1);
      assert.equal((await base.flow.submit(who, body)).event.status, 'submitted');
    });
    await test('real commit with simulated lost response recovers via same-key receipt', async () => {
      const { who, input } = await setup('lost'); const { event } = await base.flow.start(who, input);
      const body = { match_id: input.match_id, event_id: event.event_id, request_id: 'lost', answers: answers(event) };
      await assert.rejects(client({ loseCommit: true }).flow.submit(who, body), { code: 'XG_COMMIT_UNKNOWN' });
      const replay = await client().flow.submit(who, body);
      assert.equal(replay.replayed, true); assert.equal(replay.event.status, 'submitted');
      assert.equal(await count(C.requestReceipts, input.match_id), 2); assert.equal(await count(C.eventTransitions, input.match_id), 2);
    });
    await test('revocation races submit on consent revision anchor', async () => {
      const { who, input } = await setup('revoke'); const { event } = await base.flow.start(who, input);
      const state = await base.consent.getStatus(who.subject, 'assessment');
      const results = await Promise.allSettled([
        client().flow.submit(who, { match_id: input.match_id, event_id: event.event_id, request_id: 'revoke-submit', answers: answers(event) }),
        client().consent.decide(who, { scope: 'assessment', version: state.version, document_hash: state.document_hash,
          agreed: false, channel: 'web', client_event_id: 'revoke', expected_revision: state.revision })
      ]);
      assert.equal(results[1].status, 'fulfilled');
      if (results[0].status === 'rejected') assert.equal(results[0].reason.code, 'XG_CONSENT_REQUIRED');
      const final = await base.store.get(C.events, event.event_id);
      assert.equal(await count(C.submissions, input.match_id), final.status === 'submitted' ? 1 : 0);
      if (final.status === 'submitted') assert.equal(final.submission_consent.document_hash, state.document_hash);
    });
    assert.ok(report.transaction_events.conflict > 0, 'Must exercise actual database conflict retry');
    report.passed = true;
  } finally {
    // Remove only collections successfully created by THIS execution. Never existing collections.
    for (const name of report.created) {
      assert.ok(name.startsWith(prefix) && [...names.values()].includes(name));
      const preview = checked(await base.db.collection(name).count());
      console.log(`CLEANUP ${name} (${preview.total} synthetic records)`);
      try {
        await api('DeleteTable', { TableName: name });
        const remaining = await base.db.collection(name).limit(1).get().then((r) => r.code, (e) => e.code);
        assert.ok(['DATABASE_COLLECTION_NOT_EXIST', 'DATABASE_COLLECTION_NOT_FOUND'].includes(remaining), 'Verify collection deletion');
        report.cleanup.push({ collection: name, deleted: true, record_count: preview.total });
      } catch (error) { report.cleanup.push({ collection: name, deleted: false, code: safeCode(error) }); }
      persist();
    }
    report.finished_at = new Date().toISOString(); persist();
  }
  assert.equal(report.cleanup.filter((r) => !r.deleted).length, 0, 'Cleanup must complete');
  console.log(`REPORT ${output}`);
}
main().catch((error) => {
  report.passed = false; report.error = { code: safeCode(error), phase: report.tests.length }; persist();
  // No raw SDK/CLI error objects, command strings or credentials in logs/reports.
  console.error(`FAIL ${safeCode(error)} after ${report.tests.length} passed tests; report ${output}`);
  if (error.code === 'ERR_ASSERTION') console.error(error.message);
  process.exitCode = 1;
});
