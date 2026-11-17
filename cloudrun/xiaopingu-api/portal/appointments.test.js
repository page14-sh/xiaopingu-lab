const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture } = require('../../../scripts/fixtures/v2-portal.cjs');
const { COLLECTIONS: C } = require('../assessment/model');

function monday(value) {
  const date = new Date(new Date(value).getTime() + 8 * 3600000);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function principal(role, subject) {
  return { role, subject, aud: 'xg-assessment', auth_method: role === 'visitor' ? 'intake-receipt' : 'counselor-edit', demo: false, exp: Date.now() + 60000 };
}

test('appointment claim is atomic and counselor confirmation opens the match', async () => {
  const f = await fixture();
  const id = randomUUID();
  const intake = await f.store.portal.createIntake({ id, view_token: id, client_claim_secret: 'xpg2_' + Buffer.alloc(32, 8).toString('base64url') });
  const visitor = principal('visitor', intake.visitor_user_id), counselor = principal('counselor', f.cid);
  const requested = await f.store.portal.patchIntake(intake, { match_request_cid: f.cid }, { role: 'visitor', principal: visitor });
  const start = new Date(Date.now() + 2 * 86400000); start.setUTCHours(2, 0, 0, 0);
  const end = new Date(start.getTime() + 50 * 60000);
  await f.store.portal.appointments.setAvailability(counselor, { week_start: monday(start), slots: [{ start_at: start.toISOString(), end_at: end.toISOString() }] });
  const appointment = await f.store.portal.appointments.request(visitor, { assessment_id: requested.id, counselor_id: f.cid, start_at: start.toISOString() });
  await assert.rejects(() => f.store.portal.appointments.request(visitor, { assessment_id: requested.id, counselor_id: f.cid, start_at: start.toISOString() }), { code: 'XPG_SLOT_TAKEN' });
  const confirmed = await f.store.portal.appointments.confirm(counselor, appointment.appointment_id,
    (row, caller) => f.store.portal.patchIntake(row, { match_request_status: 'approved' }, { role: 'counselor', principal: caller }));
  assert.equal(confirmed.status, 'confirmed');
  assert.ok((await f.source.get('assessments', requested.id)).match_id);
});

test('both parties must submit an equal amount before an appointment completes', async () => {
  const f = await fixture();
  const appointmentId = randomUUID(), start = new Date(Date.now() - 2 * 3600000), end = new Date(Date.now() - 3600000);
  const visitorId = (await f.source.get('assessments', f.asid)).visitor_user_id;
  await f.source.transaction((tx) => tx.put(C.appointments, appointmentId, { appointment_id: appointmentId, assessment_id: f.asid, visitor_id: visitorId, counselor_id: f.cid,
    start_at: start.toISOString(), end_at: end.toISOString(), status: 'confirmed', created_at: start.toISOString(), updated_at: start.toISOString() }));
  const visitorResult = await f.store.portal.appointments.feedback(principal('visitor', visitorId), appointmentId, { amount: 500, feedback: '有帮助' });
  assert.equal(visitorResult.status, 'feedback_pending');
  const counselorResult = await f.store.portal.appointments.feedback(principal('counselor', f.cid), appointmentId, { amount: 500, feedback: '已完成' });
  assert.equal(counselorResult.status, 'completed');
});

test('three overdue missing counselor feedback items block future matches', async () => {
  const f = await fixture();
  const visitorId = (await f.source.get('assessments', f.asid)).visitor_user_id;
  await f.source.transaction(async (tx) => {
    for (let i = 0; i < 3; i++) {
      const id = randomUUID(), end = new Date(Date.now() - (i + 1) * 3600000);
      await tx.put(C.appointments, id, { appointment_id: id, assessment_id: f.asid, visitor_id: visitorId, counselor_id: f.cid,
        start_at: new Date(end.getTime() - 50 * 60000).toISOString(), end_at: end.toISOString(), status: 'confirmed', created_at: end.toISOString(), updated_at: end.toISOString() });
    }
  });
  assert.equal(await f.store.portal.appointments.isCounselorBlocked(f.cid), true);
});
