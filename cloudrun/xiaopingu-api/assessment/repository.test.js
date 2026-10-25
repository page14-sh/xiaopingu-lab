const test = require('node:test');
const assert = require('node:assert/strict');
const { createAssessmentRepository } = require('./repository');
const { COLLECTIONS: C, SCALES: S, documentKey } = require('./model');
const { memoryAssessmentStore } = require('./test-support');

const timestamp = '2026-10-25T10:00:00.000Z';
function fixture(store = memoryAssessmentStore()) {
  return { store, repo: createAssessmentRepository(store, { now: () => timestamp }) };
}
function match(matchId, counselor = 'counselor-a', visitor = 'visitor-1', extra = {}) {
  return { match_id: matchId, visitor_id: visitor, counselor_id: counselor, assessment_id: 'assessment-1', ...extra };
}
function event(matchId, eventId, scale = S.state, session = 2, extra = {}) {
  return { match_id: matchId, event_id: eventId, scale_code: scale, session_no: session,
    status: 'submitted', raw_answers: {}, scores: { total: 42 }, ...extra };
}
const hasCode = (code) => (error) => error.code === code;

test('a second counselor/cycle starts fresh; old follow-up updates only the closed cycle', async () => {
  const { repo } = fixture();
  await repo.createMatch(match('cycle-a'));
  await repo.insertEvent(event('cycle-a', 'a-m0', S.baseline, 0, { scores: { total: 49, supp_total: 18 } }));
  await repo.insertEvent(event('cycle-a', 'a-m2', S.feel, 1));
  await repo.insertEvent(event('cycle-a', 'a-m1', S.state, 2, { scores: { total: 35 } }));
  await repo.closeMatch('cycle-a', 5);
  await repo.insertEvent(event('cycle-a', 'a-end', S.end, 5));

  await repo.createMatch(match('cycle-b', 'counselor-b', 'visitor-1', { previous_match_id: 'cycle-a' }));
  await repo.insertEvent(event('cycle-b', 'b-m0', S.baseline, 0, { scores: { total: 56, supp_total: 24 } }));
  await repo.insertEvent(event('cycle-b', 'b-m2', S.feel, 1));
  await repo.insertEvent(event('cycle-b', 'b-m1', S.state, 2, { scores: { total: 63 } }));
  const beforeB = await repo.getProfiles('cycle-b');

  await repo.insertEvent(event('cycle-a', 'a-follow-1m', S.follow, 5,
    { follow_round: '1m', scores: { total: 46, supp_total: 23 } }));
  const a = await repo.getProfiles('cycle-a');
  assert.equal(a.end.follow_1m.event_id, 'a-follow-1m');
  assert.equal(a.end.follow_1m.total, 46);
  assert.equal(a.end.follow_3m, null);
  assert.equal(a.baseline.original.total, 49);
  assert.deepEqual(await repo.getProfiles('cycle-b'), beforeB);
  assert.deepEqual((await repo.getTrend('cycle-a')).points.map((row) => row.total), [35]);
  assert.deepEqual((await repo.getTrend('cycle-b')).points.map((row) => row.total), [63]);
  assert.ok((await repo.listEvents('cycle-a')).every((row) => row.counselor_id === 'counselor-a'));
  assert.ok((await repo.listEvents('cycle-b')).every((row) => row.counselor_id === 'counselor-b'));
});

test('returning to the same counselor creates a fresh baseline without replacing old history', async () => {
  const { repo } = fixture();
  const first = match('old');
  await repo.createMatch(first);
  await repo.insertEvent(event('old', 'old-base', S.baseline, 0));
  await assert.rejects(repo.createMatch(match('new')), hasCode('XG_ACTIVE_MATCH_EXISTS'));
  await repo.closeMatch('old', 1);
  await repo.createMatch(match('new', 'counselor-a', 'visitor-1', { previous_match_id: 'old' }));
  await repo.insertEvent(event('new', 'new-base', S.baseline, 0, { scores: { total: 60 } }));
  await repo.insertEvent(event('new', 'new-first-session', S.feel, 1));
  assert.equal((await repo.getProfiles('old')).baseline.original.total, 42);
  assert.equal((await repo.getProfiles('new')).baseline.original.total, 60);
  assert.equal((await repo.createMatch(first)).status, 'closed');
});

test('identity cannot be overwritten and a predecessor must belong to the same visitor', async () => {
  const { repo } = fixture();
  await repo.createMatch(match('a'));
  for (const update of [{ visitor_id: 'visitor-other' }, { counselor_id: 'counselor-other' }, { assessment_id: 'another' }]) {
    await assert.rejects(repo.createMatch({ ...match('a'), ...update }), hasCode('XG_SCOPE_MISMATCH'));
  }
  await assert.rejects(repo.createMatch(match('b', 'counselor-b', 'visitor-1', { previous_match_id: 'a' })),
    hasCode('XG_SCOPE_MISMATCH'));
  await repo.closeMatch('a', 1);
  await assert.rejects(repo.createMatch(match('b', 'counselor-b', 'visitor-other', { previous_match_id: 'a' })),
    hasCode('XG_SCOPE_MISMATCH'));
});

test('every read requires match_id and cannot retrieve another cycle’s event by id', async () => {
  const { repo } = fixture();
  await repo.createMatch(match('a'));
  await repo.createMatch(match('b', 'counselor-b'));
  await repo.insertEvent(event('a', 'private-event'));
  for (const read of [() => repo.getProfiles(), () => repo.getTrend(), () => repo.listEvents(), () => repo.getEvent(undefined, 'private-event')]) {
    await assert.rejects(read(), hasCode('XG_BAD_PARAM'));
  }
  await assert.rejects(repo.getEvent('b', 'private-event'), hasCode('XG_SCOPE_MISMATCH'));
  await assert.rejects(repo.insertEvent(event('b', 'private-event')), hasCode('XG_SCOPE_MISMATCH'));
  await assert.rejects(repo.insertEvent(event('b', 'forged', S.state, 2, { counselor_id: 'counselor-a' })),
    hasCode('XG_SCOPE_MISMATCH'));
  assert.equal(await repo.getEvent('b', 'missing'), null);
});

test('failed attempts do not occupy successful submission slots; duplicates cannot overwrite scores', async () => {
  const { repo, store } = fixture();
  await repo.createMatch(match('a'));
  for (const status of ['started', 'rejected', 'abandoned']) {
    await repo.insertEvent(event('a', status, S.baseline, 0, { status, scores: {} }));
  }
  const valid = event('a', 'accepted', S.baseline, 0);
  await repo.insertEvent(valid);
  assert.equal((await repo.insertEvent(valid)).event_id, 'accepted');
  await assert.rejects(repo.insertEvent({ ...valid, scores: { total: 65 } }), hasCode('XG_EVENT_CONFLICT'));
  await assert.rejects(repo.insertEvent({ ...valid, event_id: 'another-attempt' }), hasCode('XG_ALREADY_SUBMITTED'));
  assert.equal((await repo.listEvents('a')).length, 4);
  assert.equal(store.snapshot()[C.submissions].size, 1);
});

test('recheck changes only its own cycle reference and preserves the original baseline', async () => {
  const { repo } = fixture();
  await repo.createMatch(match('a'));
  await repo.createMatch(match('b', 'counselor-b'));
  await assert.rejects(repo.insertEvent(event('a', 'early-recheck', S.state, 1)), hasCode('XG_BASELINE_REQUIRED'));
  await repo.insertEvent(event('a', 'a-base', S.baseline, 0, { scores: { total: 49 } }));
  await repo.insertEvent(event('b', 'b-base', S.baseline, 0, { scores: { total: 56 } }));
  await repo.insertEvent(event('a', 'a-recheck', S.state, 1, { scores: { total: 35 } }));
  const a = (await repo.getProfiles('a')).baseline;
  const b = (await repo.getProfiles('b')).baseline;
  assert.equal(a.original.total, 49);
  assert.equal(a.recheck.total, 35);
  assert.equal(b.original.total, 56);
  assert.equal(b.recheck, null);
});

test('1m/3m follow-up slots are separate and cannot be duplicated by changing session number', async () => {
  const { repo } = fixture();
  await repo.createMatch(match('a'));
  await assert.rejects(repo.insertEvent(event('a', 'premature', S.follow, 5, { follow_round: '1m' })), hasCode('XG_BAD_SESSION'));
  await repo.closeMatch('a', 5);
  for (const round of ['1m', '3m']) {
    await repo.insertEvent(event('a', round, S.follow, 5, { follow_round: round }));
  }
  await assert.rejects(repo.insertEvent(event('a', 'again', S.follow, 5, { follow_round: '1m' })), hasCode('XG_ALREADY_SUBMITTED'));
  await assert.rejects(repo.insertEvent(event('a', 'wrong-session', S.follow, 6, { follow_round: '1m' })), hasCode('XG_BAD_SESSION'));
  const end = (await repo.getProfiles('a')).end;
  assert.equal(end.follow_1m.event_id, '1m');
  assert.equal(end.follow_3m.event_id, '3m');
});

test('end/evaluation are one-per-cycle even if an active cycle supplies another session number', async () => {
  const { repo } = fixture();
  await repo.createMatch(match('a'));
  for (const scale of [S.end, S.evaluation]) {
    await repo.insertEvent(event('a', scale, scale, 5));
    await assert.rejects(repo.insertEvent(event('a', `${scale}-again`, scale, 6)), hasCode('XG_ALREADY_SUBMITTED'));
  }
  const end = (await repo.getProfiles('a')).end;
  assert.equal(end.end.event_id, S.end);
  assert.equal(end.evaluation.event_id, S.evaluation);
  await assert.rejects(repo.closeMatch('a', 6), hasCode('XG_BAD_SESSION'));
  assert.equal((await repo.getMatch('a')).status, 'active');
  await repo.closeMatch('a', 5);
});

test('failure rolls back event, successful slot, profile and cycle version together', async () => {
  const { repo, store } = fixture();
  await repo.createMatch(match('a'));
  const before = store.snapshot();
  store.failNextWriteTo(C.events);
  await assert.rejects(repo.insertEvent(event('a', 'base', S.baseline, 0)), /Injected storage failure/);
  assert.deepEqual(store.snapshot(), before);
  await repo.insertEvent(event('a', 'base', S.baseline, 0));
  assert.equal((await repo.getProfiles('a')).baseline.original.event_id, 'base');
});

test('local transaction model admits only one concurrent successful answer for a card position', async () => {
  const { repo } = fixture();
  await repo.createMatch(match('a'));
  const attempts = await Promise.allSettled(Array.from({ length: 10 }, (_, index) =>
    repo.insertEvent(event('a', `attempt-${index}`, S.baseline, 0))));
  assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
  assert.ok(attempts.filter((item) => item.status === 'rejected').every((item) => item.reason.code === 'XG_ALREADY_SUBMITTED'));
  assert.equal((await repo.listEvents('a')).length, 1);
});

test('concurrent local follow-up writes preserve both rounds of the same end profile', async () => {
  const { repo } = fixture();
  await repo.createMatch(match('a'));
  await repo.closeMatch('a', 2);
  await Promise.all(['1m', '3m'].map((round) => repo.insertEvent(event('a', round, S.follow, 2, { follow_round: round }))));
  const end = (await repo.getProfiles('a')).end;
  assert.equal(end.follow_1m.event_id, '1m');
  assert.equal(end.follow_3m.event_id, '3m');
});

test('malformed positions, non-JSON input and non-submitted scores fail without writes', async () => {
  const { repo, store } = fixture();
  await repo.createMatch(match('a'));
  const before = store.snapshot();
  for (const patch of [
    { match_id: undefined }, { session_no: -1 }, { session_no: 1.5 }, { scale_code: 'unknown' },
    { follow_round: '1m' }, { follow_round: null }, { raw_answers: [] },
    { scores: { total: NaN } }, { scores: { secret: 5 } }, { status: 'rejected' }
  ]) {
    await assert.rejects(repo.insertEvent({ ...event('a', 'bad'), ...patch }), hasCode('XG_BAD_PARAM'));
  }
  assert.deepEqual(store.snapshot(), before);
});

test('closing validates final session and cannot reopen or move the active-pair lock', async () => {
  const { repo, store } = fixture();
  await repo.createMatch(match('a'));
  await repo.insertEvent(event('a', 'session-5', S.feel, 5));
  await assert.rejects(repo.closeMatch('a', 4), hasCode('XG_BAD_SESSION'));
  await repo.closeMatch('a', 5);
  await repo.createMatch(match('b'));
  await repo.closeMatch('a', 5);
  assert.equal((await store.get(C.activeMatches, documentKey('visitor-1', 'counselor-a'))).match_id, 'b');
  await assert.rejects(repo.closeMatch('a', 6), hasCode('XG_ALREADY_CLOSED'));
  await assert.rejects(repo.insertEvent(event('a', 'late-state', S.state, 6)), hasCode('XG_RELATION_CLOSED'));
});

test('trend retries when the cycle revision changes during pagination', async () => {
  const store = memoryAssessmentStore();
  const { repo } = fixture(store);
  await repo.createMatch(match('a'));
  const originalRead = store.eventsForMatch.bind(store);
  let reads = 0;
  store.eventsForMatch = async (id) => {
    const result = await originalRead(id);
    if (++reads === 1) await repo.insertEvent(event('a', 'new-state'));
    return result;
  };
  assert.equal((await repo.getTrend('a')).points[0].event_id, 'new-state');
  assert.equal(reads, 2);
});
