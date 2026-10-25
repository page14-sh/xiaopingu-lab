const { COLLECTIONS: C, SCALES: S, AssessmentError, documentKey, scopeOf, assertScope } = require('./model');
const ROUNDS = Object.freeze({ '1m': 1, '3m': 3 });
const VERSION = 'calendar-shanghai-v1';
const jobId = (matchId, round) => documentKey('followup', matchId, round);
function addCalendarMonths(iso, months) {
  const time = Date.parse(iso);
  if (typeof iso !== 'string' || !Number.isFinite(time) || ![1,3].includes(months)) throw new AssessmentError('XG_FOLLOWUP_DATE_INVALID', '随访日期参数不合法');
  const local = new Date(time + 8 * 3600000), target = local.getUTCMonth() + months;
  const day = Math.min(local.getUTCDate(), new Date(Date.UTC(local.getUTCFullYear(), target + 1, 0)).getUTCDate());
  return new Date(Date.UTC(local.getUTCFullYear(), target, day, local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds()) - 8 * 3600000).toISOString();
}
async function scheduleFollowups(tx, closed) {
  const due = {};
  for (const [round, months] of Object.entries(ROUNDS)) {
    const id = jobId(closed.match_id, round);
    if (await tx.get(C.followupJobs, id)) throw new AssessmentError('XG_FOLLOWUP_SCHEDULE_CONFLICT', '该周期随访计划已存在');
    due[round] = addCalendarMonths(closed.closed_at, months);
    await tx.put(C.followupJobs, id, { ...scopeOf(closed), job_id: id, follow_round: round,
      session_no: closed.closing_session_no, closed_at: closed.closed_at, schedule_version: VERSION,
      due_at: due[round], next_check_at: due[round], status: 'scheduled', checked_at: null, blocked_reason: null });
  }
  return due;
}
async function requireScheduledJob(tx, match, round) {
  if (!Object.hasOwn(ROUNDS, round)) throw new AssessmentError('XG_BAD_PARAM', '随访轮次不合法', 400);
  const job = await tx.get(C.followupJobs, jobId(match.match_id, round)); assertScope(job, match);
  if (!job || job.job_id !== jobId(match.match_id, round) || match.status !== 'closed' ||
      job.follow_round !== round || job.session_no !== match.closing_session_no || job.closed_at !== match.closed_at ||
      job.schedule_version !== VERSION || job.due_at !== addCalendarMonths(match.closed_at, ROUNDS[round]) ||
      match.followup_due?.[round] !== job.due_at) {
    throw new AssessmentError('XG_FOLLOWUP_SCHEDULE_MISSING', '随访计划缺失或不一致，请核对周期', 503);
  }
  return job;
}
async function requireFollowupDue(tx, match, event, time) {
  if (event.scale_code !== S.follow) return;
  const job = await requireScheduledJob(tx, match, event.follow_round);
  if (time < Date.parse(job.due_at)) throw new AssessmentError('XG_FOLLOWUP_NOT_DUE', '本轮随访尚未到期');
}
async function completeFollowup(tx, match, event) {
  if (event.scale_code !== S.follow) return;
  const job = await requireScheduledJob(tx, match, event.follow_round);
  await tx.put(C.followupJobs, job.job_id, { ...job, status: 'completed', next_check_at: null, completed_at: event.submitted_at, event_id: event.event_id });
  const task = await readFollowupTask(tx, match, job);
  if (task && !['sent','cancelled'].includes(task.status)) await tx.put(C.notificationTasks, job.job_id,
    { ...task, status: 'cancelled', cancellation_reason: 'followup_completed', updated_at: event.submitted_at, revision: task.revision + 1 });
}
async function readFollowupTask(tx, match, job) {
  const task = await tx.get(C.notificationTasks, job.job_id); assertScope(task, match);
  if (task && (task.task_id !== job.job_id || task.kind !== 'followup' || task.follow_round !== job.follow_round ||
      task.session_no !== job.session_no || task.due_at !== job.due_at)) {
    throw new AssessmentError('XG_SCOPE_MISMATCH', '通知任务与随访计划不一致');
  }
  return task;
}
module.exports = { ROUNDS, VERSION, jobId, addCalendarMonths, scheduleFollowups, requireScheduledJob, requireFollowupDue, completeFollowup, readFollowupTask };
