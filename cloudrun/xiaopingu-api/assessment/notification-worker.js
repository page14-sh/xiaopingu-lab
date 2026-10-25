const { randomUUID } = require('node:crypto');
const { COLLECTIONS: C, AssessmentError, documentKey, requireId, assertScope } = require('./model');
const { notificationGate, recipientId } = require('./notification-source');
const { requireMatch } = require('./event-storage');
const TERMINAL = ['sent','cancelled','failed','uncertain'];
const safeCode = (s) => typeof s === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(s) ? s : 'UNKNOWN';
const safeReceipt = (s) => typeof s === 'string' && /^[A-Za-z0-9_:.-]{1,160}$/.test(s) ? s : null;
function createNotificationWorker(store, { now = Date.now, provider = { async send() { return { kind: 'rejected', code: 'PROVIDER_NOT_CONFIGURED' }; } }, leaseMs = 60000, maxAttempts = 3 } = {}) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 30000 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error('Invalid notification worker settings');
  const iso = () => new Date(now()).toISOString();
  function resultView(task) { return { task_id: task.task_id, status: task.status, revision: task.revision }; }
  function blockedStatus(error) { return ['XG_NOTIFICATION_OBSOLETE','XG_ALERT_INACTIVE'].includes(error.code) ? 'cancelled' : error.code === 'XG_SCOPE_MISMATCH' ? 'failed' : 'blocked'; }
  async function block(tx, task, error, attempt) {
    const status = blockedStatus(error), next = { ...task, status, blocked_reason: safeCode(error.code), revision: task.revision + 1,
      lease_token: null, lease_until: null, next_attempt_at: status === 'blocked' ? new Date(now()+60000).toISOString() : null, updated_at: iso() };
    if (attempt) await tx.put(C.notificationAttempts, attempt.attempt_id, { ...attempt, state: status, finished_at: iso(), code: safeCode(error.code) });
    await tx.put(C.notificationTasks, task.task_id, next); return resultView(next);
  }
  async function inapp(tx, task, gate) {
    if (!await tx.get(C.notificationInbox, task.task_id)) await tx.put(C.notificationInbox, task.task_id, {
      message_id: task.task_id, task_id: task.task_id, match_id: task.match_id, visitor_id: task.visitor_id, counselor_id: task.counselor_id,
      recipient_role: task.recipient_role, recipient_id: task.recipient_id, kind: task.kind,
      title: gate.title, body: gate.body, created_at: iso(), read_at: null
    });
  }
  async function phoneRequired(tx, task) {
    if (task.kind !== 'alert' || task.channels[0] !== 'sms') return;
    const action = await tx.get(C.alertActions, task.alert_id);
    const match = await requireMatch(tx, task.match_id); assertScope(action, match);
    if (action && !action.phone_followup_required && action.status !== 'closed') {
      const revision = action.revision + 1, id = documentKey('alert', task.alert_id, revision);
      if (await tx.get(C.notificationAudit,id)) throw new AssessmentError('XG_NOTIFICATION_AUDIT_CONFLICT','审计修订已存在',503);
      await tx.put(C.notificationAudit,id,{kind:'alert',entity_id:task.alert_id,match_id:task.match_id,revision,
        actor_id:'notification-worker',recorded_at:iso(),change:{operation:'phone_followup_required',task_id:task.task_id}});
      await tx.put(C.alertActions, task.alert_id, { ...action, phone_followup_required: true, revision });
    }
  }
  async function profileResult(tx, task, status, channel, at) {
    if (task.kind !== 'followup') return;
    const match = await requireMatch(tx, task.match_id), profile = await tx.get(C.ends, task.match_id); assertScope(profile, match);
    if (!profile) throw new AssessmentError('XG_FOLLOWUP_SCHEDULE_MISSING', '结案档案缺失', 503);
    await tx.put(C.ends, task.match_id, { ...profile,
      [`follow_${task.follow_round}_sent_at`]: profile[`follow_${task.follow_round}_sent_at`] || at,
      [`follow_${task.follow_round}_result`]: status,
      [`follow_${task.follow_round}_notify_channel`]: channel,
      ...(status === 'sent' ? { [`follow_${task.follow_round}_notified_at`]: at } : {}) });
  }
  async function settle(tx, task, attempt, rawResult) {
    const result = { kind: ['accepted','rejected','retryable','unknown'].includes(rawResult?.kind) ? rawResult.kind : 'unknown',
      code: safeCode(rawResult?.code), provider_receipt_id: safeReceipt(rawResult?.provider_receipt_id) };
    const recorded = { ...attempt, state: result.kind, code: result.code, provider_receipt_id: result.provider_receipt_id, finished_at: iso() };
    await tx.put(C.notificationAttempts, attempt.attempt_id, recorded);
    const next = { ...task, revision: task.revision + 1, lease_token: null, lease_until: null, updated_at: iso(),
      last_result: result, next_attempt_at: null };
    if (result.kind === 'accepted') {
      Object.assign(next, { status: 'sent', delivery_result: 'provider_accepted', delivered_channel: attempt.channel, notified_at: iso() });
      await profileResult(tx, task, 'sent', attempt.channel, iso());
    } else if (result.kind === 'retryable' && task.send_attempt_count < maxAttempts) {
      Object.assign(next, { status: 'retry_wait', next_attempt_at: new Date(now()+Math.min(900000,60000*2**(task.send_attempt_count-1))).toISOString() });
      if (attempt.channel === 'sms') {
        let gate;
        try { gate = await notificationGate(store, tx, task, { now }); }
        catch (error) { return block(tx, next, error); }
        await inapp(tx,task,gate); await phoneRequired(tx,task); next.fallback_inapp = true;
      }
      await profileResult(tx, task, 'failed', attempt.channel, iso());
    } else {
      let gate;
      try { gate = await notificationGate(store, tx, task, { now }); }
      catch (error) {
        if (result.kind !== 'unknown') { await profileResult(tx, task, 'failed', attempt.channel, iso()); return block(tx, next, error); }
      }
      if (gate) await inapp(tx, task, gate);
      await phoneRequired(tx, task);
      Object.assign(next, result.kind === 'unknown'
        ? { status: 'uncertain', delivery_result: 'unknown', fallback_inapp: !!gate }
        : { status: 'sent', delivery_result: 'inapp_stored', delivered_channel: 'inapp', notified_at: iso(), primary_failed: true });
      await profileResult(tx, task, result.kind === 'unknown' ? 'unknown' : 'sent', gate ? 'inapp' : attempt.channel, iso());
    }
    await tx.put(C.notificationTasks, task.task_id, next); return resultView(next);
  }
  async function claim(id) {
    requireId(id, 'task_id');
    return store.transaction(async (tx) => {
      const task = await tx.get(C.notificationTasks, id);
      if (!task) throw new AssessmentError('XG_NOT_FOUND', '通知任务不存在', 404);
      if (task.task_id !== id || !Number.isSafeInteger(task.attempt_count) || task.attempt_count < 0 ||
          !['queued','retry_wait','blocked','processing',...TERMINAL].includes(task.status)) throw new AssessmentError('XG_NOTIFICATION_STATE_INVALID','通知任务结构不合法',503);
      if (TERMINAL.includes(task.status)) return resultView(task);
      if (task.status === 'processing') {
        if (Date.parse(task.lease_until) > now()) return { task_id: id, status: 'busy' };
        const attempt = await tx.get(C.notificationAttempts, task.current_attempt_id);
        if (!attempt) throw new AssessmentError('XG_NOTIFICATION_STATE_INVALID', '通知尝试记录缺失', 503);
        if (attempt.state === 'dispatching') return settle(tx, task, attempt, { kind: 'unknown', code: 'LEASE_EXPIRED_AFTER_DISPATCH' });
        await tx.put(C.notificationAttempts, attempt.attempt_id, { ...attempt, state: 'expired_before_dispatch', finished_at: iso() });
      } else if (task.next_attempt_at && Date.parse(task.next_attempt_at) > now()) return { task_id: id, status: 'not_due' };
      try { await notificationGate(store, tx, task, { lock: false, now }); }
      catch (error) { return block(tx, task, error); }
      const channel = task.channels?.[0];
      if (!['miniprogram','sms'].includes(channel)) throw new AssessmentError('XG_NOTIFICATION_STATE_INVALID', '发送通道不合法', 503);
      const token = randomUUID(), number = task.attempt_count + 1, attemptId = documentKey(id, number);
      const until = new Date(now()+leaseMs).toISOString();
      await tx.put(C.notificationAttempts, attemptId, { attempt_id: attemptId, task_id: id, match_id: task.match_id,
        number, channel, state: 'prepared', prepared_at: iso() });
      await tx.put(C.notificationTasks, id, { ...task, status: 'processing', attempt_count: number, current_attempt_id: attemptId,
        lease_token: token, lease_until: until, next_attempt_at: until, revision: task.revision + 1, updated_at: iso() });
      return { task_id: id, attempt_id: attemptId, lease_token: token, channel, status: 'claimed' };
    });
  }
  async function begin(claimed) {
    return store.transaction(async (tx) => {
      const task = await tx.get(C.notificationTasks, claimed.task_id);
      if (!task || task.status !== 'processing' || task.lease_token !== claimed.lease_token || Date.parse(task.lease_until) <= now()) return null;
      const attempt = await tx.get(C.notificationAttempts, claimed.attempt_id);
      if (!attempt || attempt.state !== 'prepared') return null;
      let gate;
      try { gate = await notificationGate(store, tx, task, { now }); }
      catch (error) { await block(tx, task, error, attempt); return null; }
      if (claimed.channel === 'sms' && !gate.safety) throw new AssessmentError('XG_NOTIFICATION_CHANNEL_INVALID', '短信仅用于安全线', 503);
      const recipient = await tx.get(C.notificationRecipients, recipientId(task.recipient_role, task.recipient_id));
      if (recipient && (recipient.recipient_role !== task.recipient_role || recipient.recipient_id !== task.recipient_id)) {
        await block(tx, task, new AssessmentError('XG_SCOPE_MISMATCH', '通知地址归属不一致'), attempt); return null;
      }
      await tx.put(C.notificationAttempts, claimed.attempt_id, { ...attempt, state: 'dispatching', started_at: iso() });
      await tx.put(C.notificationTasks, task.task_id, { ...task, send_attempt_count: (task.send_attempt_count || 0) + 1,
        sent_at: task.sent_at || iso(), updated_at: iso(), revision: task.revision + 1 });
      await profileResult(tx, task, 'pending', claimed.channel, iso());
      return { task, recipient: recipient?.disabled ? null : recipient, gate };
    });
  }
  async function finish(claimed, result) {
    return store.transaction(async (tx) => {
      const task = await tx.get(C.notificationTasks, claimed.task_id), attempt = await tx.get(C.notificationAttempts, claimed.attempt_id);
      if (!task || !attempt) throw new AssessmentError('XG_NOTIFICATION_STATE_INVALID', '通知状态缺失', 503);
      if (['accepted','rejected','retryable','unknown'].includes(attempt.state) && attempt.state === result?.kind &&
          attempt.code === safeCode(result?.code) && attempt.provider_receipt_id === safeReceipt(result?.provider_receipt_id)) return { task_id: task.task_id, status: 'already_recorded' };
      if (task.status !== 'processing' || task.lease_token !== claimed.lease_token) {
        if (!attempt.late_result) await tx.put(C.notificationAttempts, attempt.attempt_id, { ...attempt,
          late_result: { kind: ['accepted','rejected','retryable','unknown'].includes(result?.kind) ? result.kind : 'unknown', code: safeCode(result?.code),
            provider_receipt_id: safeReceipt(result?.provider_receipt_id), recorded_at: iso() } });
        return { task_id: task.task_id, status: 'stale_lease' };
      }
      if (attempt.state !== 'dispatching') throw new AssessmentError('XG_NOTIFICATION_STATE_INVALID', '通知尚未发起', 409);
      return settle(tx, task, attempt, result);
    });
  }
  async function processTask(id) {
    const claimed = await claim(id); if (claimed.status !== 'claimed') return claimed;
    const sending = await begin(claimed); if (!sending) return { task_id: id, status: 'not_sent' };
    let result;
    try { result = await provider.send({ channel: claimed.channel, attempt_id: claimed.attempt_id, task: sending.task, recipient: sending.recipient,
      title: sending.gate.title, body: sending.gate.body, safety: sending.gate.safety }); }
    catch { result = { kind: 'unknown', code: 'PROVIDER_RESPONSE_UNKNOWN' }; }
    // Never treat persistence failure as a provider failure or retry its send.
    return finish(claimed, result);
  }
  return { claim, begin, finish, processTask,
    async runBatch({ limit = 20 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AssessmentError('XG_BAD_PARAM', '批量须为1至100', 400);
      const rows = await store.dueNotifications(iso(), limit), results = [], errors = [];
      for (const row of rows) {
        try { results.push(await processTask(requireId(row._id, 'task_id'))); }
        catch (error) { errors.push({ task_id: typeof row._id === 'string' ? row._id : null, code: safeCode(error.code) }); }
      }
      return { scanned: rows.length, results, errors, more_possible: rows.length === limit };
    }
  };
}
module.exports = { createNotificationWorker };
