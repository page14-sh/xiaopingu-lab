const {closeRiskTrigger}=require('./risk-recheck');
const { isDeepStrictEqual } = require('node:util');
const { COLLECTIONS: C, AssessmentError, requireId, documentKey, assertScope } = require('./model');
const { requirePrincipal, authorizeMatch, deny } = require('./authorization');
const { requireMatch } = require('./event-storage');
const { notificationGate, recipientId, currentAlert, alertTaskId } = require('./notification-source');
const { projectReminder } = require('./reminder-view');
const { policyIn } = require('./rollout');
const { contentHash } = require('./provenance');
function revision(n) { if (!Number.isSafeInteger(n) || n < 0) throw new AssessmentError('XG_BAD_PARAM', '修订号不合法', 400); }
function text(value, max = 2000, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new AssessmentError('XG_BAD_PARAM', '文本内容不合法', 400);
  return value;
}
function actionView(a) { return Object.fromEntries(['alert_id','status','revision','cst_step','acked_at','handled_at','phone_followup_required','phone_followup_done'].map((k) => [k, a[k] ?? null])); }
function createNotificationService(store, { now = Date.now, validateCounselor } = {}) {
  const iso = () => new Date(now()).toISOString();
  async function audit(tx, kind, id, rev, record) {
    const key = documentKey(kind, id, rev);
    if (await tx.get(C.notificationAudit, key)) throw new AssessmentError('XG_NOTIFICATION_AUDIT_CONFLICT', '审计修订已存在', 503);
    await tx.put(C.notificationAudit, key, { kind, entity_id: id, revision: rev, recorded_at: iso(), ...record });
  }
  return {
    async messages(principal, { limit = 50, offset = 0 } = {}) {
      requirePrincipal(principal); if (!['visitor','counselor'].includes(principal.role)) deny();
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new AssessmentError('XG_BAD_PARAM', '分页不合法', 400);
      const messages = [];
      for (let cursor = 0; messages.length < offset + limit; cursor += 100) {
        const rows = await store.messagesForRecipient(principal.role, principal.subject, { limit: 100, offset: cursor });
        for (const row of rows) {
          const view = await store.transaction(async (tx) => {
            if (row.recipient_role !== principal.role || row.recipient_id !== principal.subject) deny();
            const task = await tx.get(C.notificationTasks, row.task_id);
            if (!task || task.recipient_role !== principal.role || task.recipient_id !== principal.subject) deny();
            try { const gate = await notificationGate(store, tx, task, { lock: false, now }); assertScope(row,gate.match); }
            catch (error) { if (['XG_CONSENT_REQUIRED','XG_CONSENT_NOT_CONFIGURED','XG_FORBIDDEN','XG_COLLECTION_PAUSED','XG_REMINDER_DISABLED','XG_NOTIFICATION_OBSOLETE','XG_ALERT_INACTIVE'].includes(error.code)) return null; throw error; }
            return { message_id: row.message_id, match_id: row.match_id, kind: row.kind,
              title: text(row.title,100), body: text(row.body,500), created_at: row.created_at, read_at: row.read_at || null };
          });
          if (view) messages.push(view);
        }
        if (rows.length < 100) break;
      }
      return { messages: messages.slice(offset,offset+limit) };
    },
    async markRead(principal, id) {
      requirePrincipal(principal); requireId(id,'message_id');
      return store.transaction(async (tx) => {
        const row = await tx.get(C.notificationInbox,id);
        if (!row || row.recipient_role !== principal.role || row.recipient_id !== principal.subject) deny();
        const task = await tx.get(C.notificationTasks,row.task_id);
        if (!task || task.recipient_role !== principal.role || task.recipient_id !== principal.subject) deny();
        const gate = await notificationGate(store,tx,task,{lock:false,now}); assertScope(row,gate.match);
        const readAt = row.read_at || iso();
        if (!row.read_at) await tx.put(C.notificationInbox,id,{...row,read_at:readAt});
        return { message_id: id, read_at: readAt };
      });
    },
    async act(principal, alertId, operation, input) {
      requirePrincipal(principal); if (principal.role !== 'counselor') deny();
      requireId(alertId,'alert_id'); requireId(input.match_id,'match_id'); revision(input.expected_revision);
      if (!['ack','cst'].includes(operation)) throw new AssessmentError('XG_BAD_PARAM','操作不合法',400);
      const note = text(input.note ?? '',2000,operation === 'cst');
      if (operation === 'cst' && (!Number.isInteger(input.cst_step) || input.cst_step < 1 || input.cst_step > 3 ||
          (input.close !== undefined && typeof input.close !== 'boolean') || (input.phone_followup_done !== undefined && typeof input.phone_followup_done !== 'boolean'))) throw new AssessmentError('XG_BAD_PARAM','CST字段不合法',400);
      const change = { operation, actor_id: principal.subject, expected_revision: input.expected_revision, note,
        cst_step: input.cst_step ?? null, close: input.close ?? false, phone_followup_done: input.phone_followup_done ?? false };
      return store.transaction(async (tx) => {
        const match = await requireMatch(tx,input.match_id); authorizeMatch(principal,match);
        const action = await tx.get(C.alertActions,alertId); assertScope(action,match);
        if (!action) throw new AssessmentError('XG_NOT_FOUND','提醒不存在',404);
        if (isDeepStrictEqual(action.last_change,change)) return actionView(action);
        if (action.revision !== input.expected_revision) throw new AssessmentError('XG_ALERT_CONFLICT','提醒已变化，请重新读取');
        if (action.status === 'closed') throw new AssessmentError('XG_ALERT_CLOSED','提醒已经关闭');
        const source = await currentAlert(tx,match,action), effective = await policyIn(tx,match,{lock:true});
        const item = projectReminder(source.signal,source.combination,source.source,effective);
        if (!item) throw new AssessmentError('XG_REMINDER_DISABLED','当前提醒不可操作');
        const next = { ...action, revision: action.revision+1, last_change: change, updated_at: iso() };
        if (operation === 'ack') { next.status = 'acked'; next.acked_at = action.acked_at || iso(); }
        else {
          if (!item.cst.enabled) throw new AssessmentError('XG_CST_DISABLED','当前CST未开放');
          if (input.cst_step < action.cst_step || input.cst_step > action.cst_step+1) throw new AssessmentError('XG_CST_ORDER','请按顺序完成CST步骤');
          next.cst_step = input.cst_step; next.status = 'acked'; next.acked_at = action.acked_at || iso();
          next.cst_started_at = action.cst_started_at || iso();
          if (input.phone_followup_done) { next.phone_followup_done = true; next.phone_followup_at = iso(); }
          if (input.close) {
            if (input.cst_step !== 3 || (action.phone_followup_required && !next.phone_followup_done)) throw new AssessmentError('XG_CST_INCOMPLETE','须完成全部步骤及所需电话跟进');
            next.status = 'closed'; next.handled_at = iso();
          }
        }
        await audit(tx,'alert',alertId,next.revision,{match_id:match.match_id,actor_id:principal.subject,change});
        await tx.put(C.alertActions,alertId,next);
        if (next.status === 'closed') {
          await closeRiskTrigger(tx,match,alertId);
          const task = await tx.get(C.notificationTasks,alertTaskId(alertId)); assertScope(task,match);
          if (task && ['queued','retry_wait','blocked','processing'].includes(task.status)) await tx.put(C.notificationTasks,task.task_id,
            {...task,status:'cancelled',cancellation_reason:'alert_closed',lease_token:null,lease_until:null,next_attempt_at:null,
              revision:task.revision+1,updated_at:iso()});
        }
        return actionView(next);
      });
    },
    async task(principal,id) {
      requirePrincipal(principal); if (principal.role !== 'admin') deny(); requireId(id,'task_id');
      const task = await store.get(C.notificationTasks,id); if (!task) throw new AssessmentError('XG_NOT_FOUND','任务不存在',404);
      const attempts = await store.notificationAttempts(id);
      const keys = ['task_id','match_id','kind','status','revision','attempt_count','send_attempt_count','sent_at','notified_at','delivered_channel','delivery_result','fallback_inapp','last_result','next_attempt_at','blocked_reason'];
      return { task: Object.fromEntries(keys.map((k)=>[k,task[k]??null])), attempts: attempts.map((a)=>Object.fromEntries(['attempt_id','number','channel','state','code','provider_receipt_id','started_at','finished_at','late_result'].map((k)=>[k,a[k]??null]))) };
    },
    async resolve(principal,id,{expected_revision,outcome,reason,evidence_reference}) {
      requirePrincipal(principal); if (principal.role !== 'admin') deny(); requireId(id,'task_id'); revision(expected_revision);
      text(reason,500,true); text(evidence_reference,200,true);
      if (!['accepted','not_sent'].includes(outcome)) throw new AssessmentError('XG_BAD_PARAM','核对结果不合法',400);
      return store.transaction(async (tx)=>{
        const task = await tx.get(C.notificationTasks,id); if (!task) throw new AssessmentError('XG_NOT_FOUND','任务不存在',404);
        if (task.revision !== expected_revision || task.status !== 'uncertain') throw new AssessmentError('XG_NOTIFICATION_CONFLICT','任务状态已变化');
        const next = {...task, revision:task.revision+1, status:outcome==='accepted'?'sent':'retry_wait',
          next_attempt_at:outcome==='not_sent'?iso():null, resolved_at:iso(), delivery_result:outcome==='accepted'?'operator_confirmed':'verified_not_sent',
          ...(outcome==='accepted'?{notified_at:iso(),delivered_channel:task.channels[0]}:{})};
        await audit(tx,'notification',id,next.revision,{match_id:task.match_id,actor_id:principal.subject,outcome,reason,evidence_reference});
        await tx.put(C.notificationTasks,id,next);
        if (task.kind==='followup') {
          const profile=await tx.get(C.ends,task.match_id); const match=await requireMatch(tx,task.match_id); assertScope(profile,match);
          if (profile) await tx.put(C.ends,task.match_id,{...profile,[`follow_${task.follow_round}_result`]:outcome==='accepted'?'sent':'failed',
            ...(outcome==='accepted'?{[`follow_${task.follow_round}_notified_at`]:iso(),[`follow_${task.follow_round}_notify_channel`]:task.channels[0]}:{})});
        }
        return { task_id:id,status:next.status,revision:next.revision };
      });
    },
    async bindRecipient(principal,input) {
      requirePrincipal(principal); if (principal.role!=='admin') deny();
      requireId(input.counselor_id,'counselor_id'); revision(input.expected_revision); text(input.reason,500,true);
      if (!validateCounselor || !await validateCounselor(input.counselor_id)) throw new AssessmentError('XG_BAD_PARAM','咨询师账号不可用',400);
      if (typeof input.disabled!=='boolean' || (input.phone_e164 !== undefined && input.phone_e164 !== null &&
          (typeof input.phone_e164!=='string' || !/^\+[1-9]\d{6,14}$/.test(input.phone_e164) || input.phone_verified!==true)) ||
          ((input.openid != null || input.appid != null) && (typeof input.openid!=='string' || typeof input.appid!=='string' ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(input.openid) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.appid)))) throw new AssessmentError('XG_BAD_PARAM','通知地址须由管理员核验',400);
      const id=recipientId('counselor',input.counselor_id);
      return store.transaction(async(tx)=>{
        const old=await tx.get(C.notificationRecipients,id);
        if ((old?.revision||0)!==input.expected_revision) throw new AssessmentError('XG_NOTIFICATION_CONFLICT','地址版本已变化');
        const row={...(old||{openid:null,appid:null,phone_e164:null,phone_verified:false}),recipient_role:'counselor',recipient_id:input.counselor_id,
          ...(input.openid !== undefined || input.appid !== undefined ? {openid:input.openid||null,appid:input.appid||null}:{}),
          ...(input.phone_e164 !== undefined ? {phone_e164:input.phone_e164,phone_verified:!!input.phone_e164}:{}),
          disabled:input.disabled,revision:(old?.revision||0)+1,updated_at:iso()};
        await audit(tx,'recipient',id,row.revision,{actor_id:principal.subject,reason:input.reason,record_hash:contentHash(row)});
        await tx.put(C.notificationRecipients,id,row);
        return {recipient_id:input.counselor_id,revision:row.revision,disabled:row.disabled,has_wechat:!!row.openid,has_phone:!!row.phone_e164};
      });
    }
  };
}
module.exports={createNotificationService};
