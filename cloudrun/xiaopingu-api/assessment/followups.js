const { isDeepStrictEqual } = require('node:util');
const { COLLECTIONS: C, SCALES: S, AssessmentError, requireId, requireSession, eventPosition, scopeOf, assertScope } = require('./model');
const { requirePrincipal, authorizeMatch, deny } = require('./authorization');
const { requireMatch, readProfile } = require('./event-storage');
const { createConsentRepository } = require('./consent');
const { requireCollectionOpen, collectionPausedIn } = require('./rollout');
const { ROUNDS, requireScheduledJob, readFollowupTask } = require('./followup-schedule');
const { requireRecheckEligible } = require('./baseline-reference');
const { readVersionsInTransaction } = require('./provenance');
const ACTIVE = ['scheduled', 'blocked', 'queued'];
const DAY = 86400000;
const consentBlocks = new Set(['XG_CONSENT_REQUIRED','XG_CONSENT_NOT_CONFIGURED','XG_FORBIDDEN']);
function createFollowupRepository(store, { now = Date.now } = {}) {
  const consent = createConsentRepository(store);
  async function processJob(id) {
    requireId(id, 'job_id');
    return store.transaction(async (tx) => {
      const found = await tx.get(C.followupJobs, id);
      if (!found) throw new AssessmentError('XG_NOT_FOUND', '随访任务不存在', 404);
      const match = await requireMatch(tx, found.match_id);
      const job = await requireScheduledJob(tx, match, found.follow_round);
      if (job.job_id !== id) throw new AssessmentError('XG_SCOPE_MISMATCH', '随访任务标识不一致');
      const time = now(), timestamp = new Date(time).toISOString();
      if (!ACTIVE.includes(job.status)) return { job_id: id, outcome: job.status };
      if (Date.parse(job.due_at) > time || Date.parse(job.next_check_at) > time) return { job_id: id, outcome: 'not_due' };
      const position = eventPosition({ match_id: match.match_id, scale_code: S.follow, session_no: match.closing_session_no, follow_round: job.follow_round });
      const slot = await tx.get(C.submissions, position.submission_id); assertScope(slot, match);
      const task = await readFollowupTask(tx, match, job);
      const update = (patch) => tx.put(C.followupJobs, id, { ...job, checked_at: timestamp, ...patch });
      if (slot) {
        await update({ status: 'completed', next_check_at: null, event_id: slot.event_id, completed_at: timestamp });
        if (task && !['sent','cancelled'].includes(task.status)) await tx.put(C.notificationTasks, id,
          { ...task, status: 'cancelled', cancellation_reason: 'followup_completed', updated_at: timestamp, revision: task.revision + 1 });
        return { job_id: id, outcome: 'completed' };
      }
      if (task?.status === 'sent') {
        await update({ status: 'notified', next_check_at: null });
        return { job_id: id, outcome: 'notified' };
      }
      let blocked = null, consentRef;
      try { await requireCollectionOpen(tx); }
      catch (error) { if (error.code !== 'XG_COLLECTION_PAUSED') throw error; blocked = error.code; }
      if (!blocked) {
        try { consentRef = await consent.requireInTransaction(tx, match.visitor_id, 'followup'); }
        catch (error) { if (!consentBlocks.has(error.code)) throw error; blocked = error.code; }
      }
      const next = new Date(time + DAY).toISOString();
      if (blocked) {
        await update({ status: 'blocked', blocked_reason: blocked, next_check_at: next });
        if (task && ['queued','blocked'].includes(task.status) && (task.status !== 'blocked' || task.blocked_reason !== blocked)) {
          await tx.put(C.notificationTasks, id, { ...task, status: 'blocked', blocked_reason: blocked,
            consent_ref: null, updated_at: timestamp, revision: task.revision + 1 });
        }
        return { job_id: id, outcome: 'blocked', reason: blocked };
      }
      // T17 owns delivery attempts and terminal results. Do not reset a failed,
      // cancelled or in-flight delivery, and never interpret enqueue as sent.
      if (task && !['queued','blocked'].includes(task.status)) {
        await update({ status: 'queued', blocked_reason: null, next_check_at: next });
        return { job_id: id, outcome: 'delivery_owned' };
      }
      const resumed = !task || task.status === 'blocked';
      if (!task || task.status !== 'queued' || !isDeepStrictEqual(task.consent_ref, consentRef)) {
        await tx.put(C.notificationTasks, id, { ...(task || {}), ...scopeOf(match), task_id: id, kind: 'followup',
          follow_round: job.follow_round, session_no: job.session_no, due_at: job.due_at,
          status: 'queued', channels: ['miniprogram','inapp'], consent_ref: consentRef,
          next_attempt_at: resumed ? timestamp : (task.next_attempt_at || timestamp),
          recipient_role: 'visitor', recipient_id: match.visitor_id,
          blocked_reason: null, attempt_count: task?.attempt_count || 0, revision: (task?.revision || 0) + 1,
          created_at: task?.created_at || timestamp, updated_at: timestamp });
      }
      const profile = await readProfile(tx, C.ends, match);
      if (!profile) throw new AssessmentError('XG_FOLLOWUP_SCHEDULE_MISSING', '缺少结案档案', 503);
      const queuedField = `follow_${job.follow_round}_queued_at`;
      if (!profile[queuedField]) await tx.put(C.ends, match.match_id, { ...profile, [queuedField]: timestamp });
      await update({ status: 'queued', queued_at: job.queued_at || timestamp, blocked_reason: null, next_check_at: next });
      return { job_id: id, outcome: resumed ? 'queued' : 'already_queued' };
    });
  }
  return {
    processJob,
    async dispatchDue({ limit = 50 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AssessmentError('XG_BAD_PARAM', '扫描批量须为1至100', 400);
      const rows = await store.dueFollowups(new Date(now()).toISOString(), limit), results = [], errors = [];
      for (const row of rows) {
        try { results.push(await processJob(requireId(row._id, 'job_id'))); }
        catch (error) { errors.push({ job_id: typeof row._id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(row._id) ? row._id : null,
          code: typeof error.code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(error.code) ? error.code : 'XG_FOLLOWUP_DISPATCH_FAILED' }); }
      }
      return { scanned: rows.length, results, errors, more_possible: rows.length === limit };
    },
    async prompts(principal, matchId, { session_no, scope } = {}) {
      requirePrincipal(principal);
      if (session_no !== undefined) requireSession(session_no);
      return store.transaction(async (tx) => {
        const match = await requireMatch(tx, matchId); authorizeMatch(principal, match);
        if (!['visitor','counselor'].includes(principal.role)) deny();
        if (await collectionPausedIn(tx)) return [];
        const purpose = scope ?? (match.status === 'closed' ? 'followup' : 'assessment');
        if (!['assessment','followup'].includes(purpose) || (match.status === 'closed' && purpose !== 'followup')) throw new AssessmentError('XG_BAD_PARAM', '卡片用途与周期状态不一致', 400);
        try { await consent.requireInTransaction(tx, match.visitor_id, purpose, { lock: false }); }
        catch (error) { if (consentBlocks.has(error.code)) return []; throw error; }
        const prompts = [];
        async function add(scale, session, round = '', due = match.opened_at) {
          const position = eventPosition({ match_id: matchId, scale_code: scale, session_no: session, follow_round: round });
          const slot = await tx.get(C.submissions, position.submission_id); assertScope(slot, match);
          if (!slot) prompts.push({ match_id: matchId, scale_code: scale, session_no: session, follow_round: round, due_at: due });
        }
        if (match.status !== 'closed') {
          if (purpose === 'followup') {
            if (principal.role === 'visitor' && session_no > 0) { await add(S.end, session_no); await add(S.evaluation, session_no); }
          } else if (principal.role === 'counselor') {
            if (session_no > 0) await add(S.pro, session_no);
          } else {
            const baseline = await readProfile(tx, C.baselines, match);
            if (!baseline) await add(S.baseline, 0);
            else if (session_no > 0) {
              if (session_no >= 2) await add(S.state, session_no);
              else {
                const { rules } = await readVersionsInTransaction(tx);
                try {
                  await requireRecheckEligible(tx, match, { scale_code: S.state, session_no: 1, basis: { rules: rules.definition } }, now());
                  await add(S.state, 1);
                } catch (error) { if (error.code !== 'XG_RECHECK_NOT_DUE') throw error; }
              }
              await add(S.feel, session_no);
            }
          }
          return prompts;
        }
        if (principal.role !== 'visitor') return [];
        if (session_no !== undefined && session_no !== match.closing_session_no) throw new AssessmentError('XG_BAD_PARAM', '结案后卡片须使用原结案节次', 400);
        for (const scale of [S.end, S.evaluation, S.follow]) {
          for (const round of scale === S.follow ? Object.keys(ROUNDS) : ['']) {
            const job = scale === S.follow ? await requireScheduledJob(tx, match, round) : null;
            if (job && Date.parse(job.due_at) > now()) continue;
            await add(scale, match.closing_session_no, round, job?.due_at || match.closed_at);
          }
        }
        return prompts;
      });
    }
  };
}
module.exports = { createFollowupRepository, ACTIVE };
