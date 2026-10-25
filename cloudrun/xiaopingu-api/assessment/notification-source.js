const {assertInScope}=require('./risk-recheck');
const { COLLECTIONS: C, AssessmentError, documentKey, scopeOf, assertScope, eventPosition, SCALES: S } = require('./model');
const { contentHash } = require('./provenance');
const { requireMatch } = require('./event-storage');
const { createConsentRepository } = require('./consent');
const { requireScheduledJob, readFollowupTask } = require('./followup-schedule');
const { policyIn, requireCollectionOpen, collectionPausedIn } = require('./rollout');
const { projectReminder } = require('./reminder-view');
const alertTaskId = (id) => documentKey('alert-notification', id);
const recipientId = (role, id) => documentKey(role, id);
const COMBINED_FIELDS = ['status','missing_cards','reference_event_id','baseline_pending','event_ids','source_bases','original_level','display_level','diff_post','alliance_stable','downgraded','reason','signal_ids'];

async function enqueueAlerts(tx, match, result, timestamp) {
  for (const signal of result.raw.signals) {
    const anchor = signal.evidence.find((e) => e.event_id === signal.event_id);
    if (!anchor) throw new AssessmentError('XG_ALERT_SOURCE_INVALID', '提醒来源缺失', 503);
    let action = await tx.get(C.alertActions, signal.signal_id); assertScope(action, match);
    if (!action) {
      action = { ...scopeOf(match), alert_id: signal.signal_id, event_id: signal.event_id, session_no: anchor.session_no,
        initial_level: signal.level, triggered_at: timestamp,
        alert_type: signal.rule_id === 'RISK-RECHECK' ? 'risk' : signal.rule_id === 'DISSOC' ? 'dissociation' : signal.rule_id.startsWith('OUT-') ? 'outcome' : signal.rule_id.startsWith('ALL-') ? 'alliance' : 'stability',
        status: 'open', revision: 0, cst_step: 0, phone_followup_required: false, phone_followup_done: false, created_at: timestamp };
      await tx.put(C.alertActions, signal.signal_id, action);
    }
    const id = alertTaskId(signal.signal_id), existing = await tx.get(C.notificationTasks, id); assertScope(existing, match);
    if (!existing && action.status !== 'closed') await tx.put(C.notificationTasks, id, {
      ...scopeOf(match), task_id: id, kind: 'alert', alert_id: signal.signal_id, event_id: signal.event_id, session_no: anchor.session_no,
      recipient_role: 'counselor', recipient_id: match.counselor_id,
      channels: ['DISSOC','RISK-RECHECK'].includes(signal.rule_id) ? ['sms','inapp'] : ['miniprogram','inapp'],
      status: 'queued', attempt_count: 0, revision: 1, next_attempt_at: timestamp, created_at: timestamp, updated_at: timestamp
    });
  }
}

async function currentAlert(tx, match, action) {
  assertScope(action, match);
  const job = await tx.get(C.combinationJobs, match.match_id); assertScope(job, match);
  if (job && job.generation !== job.completed_generation) throw new AssessmentError('XG_COMBINATION_PENDING', '组合结果待更新', 503);
  const id = documentKey(match.match_id, action.session_no);
  const raw = await tx.get(C.rawSignals, id), saved = await tx.get(C.combinations, id);
  assertScope(raw, match); assertScope(saved, match);
  if (!raw || !saved) throw new AssessmentError('XG_ALERT_INACTIVE', '提醒来源已失效', 409);
  const combined = Object.fromEntries(COMBINED_FIELDS.map((key) => [key, saved[key]]));
  if (raw.fingerprint !== saved.fingerprint || raw.revision !== saved.revision ||
      contentHash({ session_no: action.session_no, raw: { policy: raw.policy, signals: raw.signals }, combined }) !== saved.fingerprint) {
    throw new AssessmentError('XG_ALERT_SOURCE_INVALID', '提醒依据不一致', 503);
  }
  const signal = raw.signals.find((s) => s.signal_id === action.alert_id);
  if (!signal || signal.event_id !== action.event_id) throw new AssessmentError('XG_ALERT_INACTIVE', '提醒来源已失效', 409);
  const source = await tx.get(C.events, action.event_id); assertScope(source, match);
  if (!source || source.status !== 'submitted') throw new AssessmentError('XG_ALERT_SOURCE_INVALID', '提醒答卷不存在', 503);
  return { signal, source, combination: { revision: saved.revision, combined } };
}

async function notificationGate(store, tx, task, { lock = true, now = Date.now } = {}) {
  const match = await requireMatch(tx, task.match_id); assertScope(task, match);
  if (task.kind === 'followup') {
    await assertInScope(tx,match);
    const job = await requireScheduledJob(tx, match, task.follow_round); await readFollowupTask(tx, match, job);
    if (task.recipient_role !== 'visitor' || task.recipient_id !== match.visitor_id) throw new AssessmentError('XG_SCOPE_MISMATCH', '通知收件人不匹配');
    const position = eventPosition({ match_id: match.match_id, scale_code: S.follow, session_no: job.session_no, follow_round: job.follow_round });
    const slot = await tx.get(C.submissions, position.submission_id); assertScope(slot, match);
    if (slot) throw new AssessmentError('XG_NOTIFICATION_OBSOLETE', '随访已完成');
    if (Date.parse(job.due_at) > now()) throw new AssessmentError('XG_FOLLOWUP_NOT_DUE', '随访尚未到期');
    if (lock) await requireCollectionOpen(tx);
    else if (await collectionPausedIn(tx)) throw new AssessmentError('XG_COLLECTION_PAUSED', '采集暂停');
    const consent = await createConsentRepository(store).requireInTransaction(tx, match.visitor_id, 'followup', { lock });
    return { match, consent, safety: false, title: '随访填写提示', body: '有一份随访卡片可以填写，请按实际情况作答。' };
  }
  if (task.kind !== 'alert' || task.recipient_role !== 'counselor' || task.recipient_id !== match.counselor_id) throw new AssessmentError('XG_SCOPE_MISMATCH', '通知收件人不匹配');
  const action = await tx.get(C.alertActions, task.alert_id);
  if (!action) throw new AssessmentError('XG_ALERT_INACTIVE', '提醒不存在');
  if (action.status === 'closed') throw new AssessmentError('XG_NOTIFICATION_OBSOLETE', '提醒已处理');
  const current = await currentAlert(tx, match, action);
  const effective = await policyIn(tx, match, { lock });
  const item = projectReminder(current.signal, current.combination, current.source, effective);
  if (!item) throw new AssessmentError('XG_REMINDER_DISABLED', '当前阶段未开放提醒');
  return { match, action, item, safety: item.is_safety, title: item.is_safety ? '安全核对提示' : '咨询复核提示', body: item.suggest_text };
}
module.exports = { enqueueAlerts, alertTaskId, recipientId, currentAlert, notificationGate };
