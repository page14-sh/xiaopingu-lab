const { randomUUID } = require('node:crypto');
const { COLLECTIONS: C, AssessmentError, documentKey } = require('../assessment/model');
const { deny } = require('../assessment/authorization');

const ACTIVE = new Set(['awaiting_counselor_confirmation', 'confirmed', 'feedback_pending', 'payment_mismatch']);
const MINUTE = 60 * 1000;

function fail(code, message, status = 409) {
  throw new AssessmentError(code, message, status);
}

function iso(value, field) {
  if (typeof value !== 'string' || !value) fail('XPG_BAD_PARAM', `${field} 必须是 ISO 时间`, 400);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail('XPG_BAD_PARAM', `${field} 无效`, 400);
  return date.toISOString();
}

function weekOf(value) {
  const date = new Date(value);
  const local = new Date(date.getTime() + 8 * 60 * MINUTE);
  const day = (local.getUTCDay() + 6) % 7;
  local.setUTCDate(local.getUTCDate() - day);
  return local.toISOString().slice(0, 10);
}

function safeSlots(slots, now) {
  if (!Array.isArray(slots) || slots.length > 120) fail('XPG_BAD_PARAM', '可预约时段格式不正确', 400);
  const seen = new Set();
  return slots.map((slot) => {
    if (!slot || typeof slot !== 'object') fail('XPG_BAD_PARAM', '可预约时段格式不正确', 400);
    const start_at = iso(slot.start_at, 'start_at');
    const end_at = iso(slot.end_at, 'end_at');
    const duration = new Date(end_at).getTime() - new Date(start_at).getTime();
    if (duration < 30 * MINUTE || duration > 3 * 60 * MINUTE || duration % (10 * MINUTE) !== 0) {
      fail('XPG_BAD_PARAM', '每个时段须为 30–180 分钟且按 10 分钟对齐', 400);
    }
    if (new Date(start_at).getTime() <= now.getTime()) fail('XPG_BAD_PARAM', '不能维护过去的时段', 400);
    const key = `${start_at}|${end_at}`;
    if (seen.has(key)) fail('XPG_BAD_PARAM', '可预约时段重复', 400);
    seen.add(key);
    return { start_at, end_at };
  }).sort((a, b) => a.start_at.localeCompare(b.start_at));
}

function stateOf(row, now) {
  if (!row || !ACTIVE.has(row.status)) return row?.status || 'cancelled';
  if (row.status === 'awaiting_counselor_confirmation' || new Date(row.end_at).getTime() > now.getTime()) return row.status;
  if (row.visitor_feedback && row.counselor_feedback) {
    return Number(row.visitor_feedback.amount) === Number(row.counselor_feedback.amount) ? 'completed' : 'payment_mismatch';
  }
  return 'feedback_pending';
}

function visible(row, principal, now) {
  const status = stateOf(row, now);
  const shared = {
    appointment_id: row.appointment_id,
    assessment_id: row.assessment_id,
    counselor_id: row.counselor_id,
    start_at: row.start_at,
    end_at: row.end_at,
    status,
    visitor_confirmed_at: row.visitor_confirmed_at,
    counselor_confirmed_at: row.counselor_confirmed_at || null,
    cancellation: row.cancellation || null,
    override: row.override || null
  };
  if (principal.role === 'admin') return { ...shared, visitor_id: row.visitor_id, visitor_feedback: row.visitor_feedback || null, counselor_feedback: row.counselor_feedback || null };
  const ownFeedback = principal.role === 'visitor' ? row.visitor_feedback : row.counselor_feedback;
  const peerFeedback = principal.role === 'visitor' ? row.counselor_feedback : row.visitor_feedback;
  return {
    ...shared,
    submitted_feedback: Boolean(ownFeedback),
    other_party_submitted_feedback: Boolean(peerFeedback),
    confirmed_amount: ownFeedback?.amount ?? null,
    other_party_confirmed_amount: peerFeedback?.amount ?? null,
    amount_confirmed: Boolean(ownFeedback && peerFeedback && Number(ownFeedback.amount) === Number(peerFeedback.amount))
  };
}

function createAppointments({ source, scan, now = () => new Date() }) {
  async function overdueFeedbackCount(counselorId) {
    const current = now();
    const rows = await scan(C.appointments, { counselor_id: counselorId });
    return rows.filter((row) => new Date(row.end_at).getTime() <= current.getTime() &&
      !['cancelled', 'completed'].includes(stateOf(row, current)) && !row.counselor_feedback).length;
  }

  async function isCounselorBlocked(counselorId) {
    return (await overdueFeedbackCount(counselorId)) >= 3;
  }

  async function setAvailability(principal, input) {
    if (principal.role !== 'counselor') deny('仅咨询师可维护日历');
    const current = now();
    const slots = safeSlots(input.slots, current);
    const week_start = typeof input.week_start === 'string' ? input.week_start : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week_start)) fail('XPG_BAD_PARAM', 'week_start 格式不正确', 400);
    if (slots.some((slot) => weekOf(slot.start_at) !== week_start)) fail('XPG_BAD_PARAM', '时段必须属于同一自然周', 400);
    const id = documentKey('availability', principal.subject, week_start);
    const record = { availability_id: id, counselor_id: principal.subject, week_start, slots, updated_at: current.toISOString() };
    await source.transaction(async (tx) => { await tx.put(C.availability, id, record); });
    return record;
  }

  async function availability(principal, { counselor_id, week_start, assessment_id }) {
    if (!counselor_id || !week_start) fail('XPG_BAD_PARAM', '缺少咨询师或周起始日', 400);
    if (principal.role === 'visitor') {
      const intake = await source.get('assessments', assessment_id);
      if (!intake || intake.visitor_user_id !== principal.subject || intake.match_request_cid !== counselor_id) deny('无权查看该咨询师日程');
    } else if (principal.role !== 'counselor' && principal.role !== 'admin') deny();
    if (principal.role === 'counselor' && principal.subject !== counselor_id) deny('只能查看自己的日历');
    const record = await source.get(C.availability, documentKey('availability', counselor_id, week_start));
    const rows = await scan(C.appointments, { counselor_id });
    const current = now();
    const byStart = new Map(rows.filter((row) => ACTIVE.has(row.status) && stateOf(row, current) !== 'cancelled').map((row) => [row.start_at, row]));
    return {
      counselor_id,
      week_start,
      slots: (record?.slots || []).map((slot) => ({ ...slot, state: byStart.has(slot.start_at) ? 'booked' : 'available' }))
    };
  }

  async function request(principal, input) {
    if (principal.role !== 'visitor') deny('请以来访者身份预约');
    const current = now();
    const start_at = iso(input.start_at, 'start_at');
    const counselor_id = String(input.counselor_id || '');
    const assessment_id = String(input.assessment_id || '');
    if (!counselor_id || !assessment_id) fail('XPG_BAD_PARAM', '缺少预约信息', 400);
    if (await isCounselorBlocked(counselor_id)) fail('XPG_COUNSELOR_FEEDBACK_BLOCKED', '该咨询师正在补齐历史反馈，暂不提供新的匹配', 409);
    const result = await source.transaction(async (tx) => {
      const intake = await tx.get('assessments', assessment_id);
      if (!intake || intake.visitor_user_id !== principal.subject || intake.match_request_cid !== counselor_id || intake.match_id) deny('当前匹配申请不可预约');
      const counselor = await tx.get('counselors', counselor_id);
      if (!counselor || counselor.is_demo || counselor.is_active !== true || counselor.review_status !== 'approved') {
        fail('XPG_COUNSELOR_UNAVAILABLE', '咨询师暂不可预约', 409);
      }
      const availabilityId = documentKey('availability', counselor_id, weekOf(start_at));
      const calendar = await tx.get(C.availability, availabilityId);
      const slot = calendar?.slots?.find((item) => item.start_at === start_at);
      if (!slot) fail('XPG_SLOT_UNAVAILABLE', '该时段不可预约', 409);
      const appointment_id = documentKey('appointment', counselor_id, start_at);
      const existing = await tx.get(C.appointments, appointment_id);
      if (existing && ACTIVE.has(existing.status)) fail('XPG_SLOT_TAKEN', '该时段刚刚被预约，请选择其他时间', 409);
      const appointment = { appointment_id, assessment_id, visitor_id: principal.subject, counselor_id, start_at: slot.start_at, end_at: slot.end_at,
        status: 'awaiting_counselor_confirmation', visitor_confirmed_at: current.toISOString(), counselor_confirmed_at: null,
        visitor_feedback: null, counselor_feedback: null, created_at: current.toISOString(), updated_at: current.toISOString() };
      await tx.put(C.appointments, appointment_id, appointment);
      await tx.put('assessments', assessment_id, { ...intake, appointment_id, match_request_status: 'visitor_confirmed', updated_at: current.toISOString() });
      return appointment;
    });
    return visible(result, principal, current);
  }

  async function confirm(principal, appointmentId, approveMatch) {
    if (principal.role !== 'counselor') deny('仅咨询师可确认预约');
    const current = now();
    const appointment = await source.get(C.appointments, appointmentId);
    if (!appointment || appointment.counselor_id !== principal.subject) deny('无权确认该预约');
    if (appointment.status !== 'awaiting_counselor_confirmation') fail('XPG_APPOINTMENT_STATE', '该预约无法确认', 409);
    if (new Date(appointment.start_at).getTime() <= current.getTime()) fail('XPG_APPOINTMENT_EXPIRED', '预约已过期', 409);
    const intake = await source.get('assessments', appointment.assessment_id);
    const approved = await approveMatch(intake, principal);
    const final = await source.transaction(async (tx) => {
      const latest = await tx.get(C.appointments, appointmentId);
      if (!latest || latest.status !== 'awaiting_counselor_confirmation') fail('XPG_APPOINTMENT_STATE', '预约状态已变化', 409);
      const next = { ...latest, status: 'confirmed', counselor_confirmed_at: current.toISOString(), match_id: approved.match_id || null, updated_at: current.toISOString() };
      await tx.put(C.appointments, appointmentId, next);
      return next;
    });
    return visible(final, principal, current);
  }

  async function cancel(principal, appointmentId) {
    const current = now();
    return source.transaction(async (tx) => {
      const row = await tx.get(C.appointments, appointmentId);
      if (!row || (principal.role !== 'admin' && principal.subject !== row.visitor_id && principal.subject !== row.counselor_id)) deny('无权取消该预约');
      if (!ACTIVE.has(row.status) || new Date(row.start_at).getTime() <= current.getTime()) fail('XPG_APPOINTMENT_CANNOT_CANCEL', '预约开始后不能取消', 409);
      const next = { ...row, status: 'cancelled', cancellation: { by: principal.role, at: current.toISOString() }, updated_at: current.toISOString() };
      await tx.put(C.appointments, appointmentId, next);
      return visible(next, principal, current);
    });
  }

  async function feedback(principal, appointmentId, input) {
    if (!['visitor', 'counselor'].includes(principal.role)) deny('只有来访者或咨询师可提交反馈');
    const current = now();
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1000000 || Math.round(amount * 100) !== amount * 100) fail('XPG_BAD_AMOUNT', '已付金额不正确', 400);
    const text = typeof input.feedback === 'string' ? input.feedback.trim().slice(0, 2000) : '';
    return source.transaction(async (tx) => {
      const row = await tx.get(C.appointments, appointmentId);
      if (!row || principal.subject !== row[`${principal.role}_id`]) deny('无权提交该预约反馈');
      if (new Date(row.end_at).getTime() > current.getTime()) fail('XPG_APPOINTMENT_NOT_FINISHED', '咨询结束后才能反馈', 409);
      if (!ACTIVE.has(row.status) || row.status === 'awaiting_counselor_confirmation') fail('XPG_APPOINTMENT_STATE', '该预约不需要反馈', 409);
      const submission = { amount, feedback: text, submitted_at: current.toISOString() };
      const next = { ...row, [`${principal.role}_feedback`]: submission, updated_at: current.toISOString() };
      next.status = stateOf(next, current);
      await tx.put(C.appointments, appointmentId, next);
      return visible(next, principal, current);
    });
  }

  async function override(principal, appointmentId, input) {
    if (principal.role !== 'admin') deny('仅管理员可纠正预约状态');
    const status = input.status;
    if (!['confirmed', 'feedback_pending', 'completed', 'cancelled'].includes(status) || typeof input.reason !== 'string' || !input.reason.trim()) {
      fail('XPG_BAD_PARAM', '需要填写合法状态和纠正原因', 400);
    }
    const current = now();
    return source.transaction(async (tx) => {
      const row = await tx.get(C.appointments, appointmentId);
      if (!row) fail('XPG_NOT_FOUND', '预约不存在', 404);
      const next = { ...row, status, override: { status, reason: input.reason.trim().slice(0, 500), by: principal.subject, at: current.toISOString() }, updated_at: current.toISOString() };
      await tx.put(C.appointments, appointmentId, next);
      return visible(next, principal, current);
    });
  }

  async function list(principal, { assessment_id } = {}) {
    const filter = principal.role === 'visitor' ? { visitor_id: principal.subject } : principal.role === 'counselor' ? { counselor_id: principal.subject } : {};
    const rows = await scan(C.appointments, filter);
    return rows.filter((row) => !assessment_id || row.assessment_id === assessment_id)
      .sort((a, b) => a.start_at.localeCompare(b.start_at)).map((row) => visible(row, principal, now()));
  }

  return { setAvailability, availability, request, confirm, cancel, feedback, override, list, overdueFeedbackCount, isCounselorBlocked };
}

module.exports = { createAppointments, stateOf };
