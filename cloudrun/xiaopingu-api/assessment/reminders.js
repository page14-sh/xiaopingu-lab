const { COLLECTIONS: C, AssessmentError, requireId, requireSession, assertScope } = require('./model');
const { requirePrincipal, authorizeMatch, deny } = require('./authorization');
const { requireMatch } = require('./event-storage');
const { createCombinationRepository, pending } = require('./combinations');
const { policyIn } = require('./rollout');
const { TYPES, projectReminder } = require('./reminder-view');
function createReminderRepository(store) {
  const combinations = createCombinationRepository(store);
  return {
    async inbox(principal, matchId, { session_no, alert_type, status = 'pending', limit = 50, offset = 0 } = {}) {
      requirePrincipal(principal); if (!['counselor','admin'].includes(principal.role)) deny();
      requireId(matchId, 'match_id');
      if (session_no !== undefined) requireSession(session_no);
      if (alert_type !== undefined && !TYPES.includes(alert_type)) throw new AssessmentError('XG_BAD_PARAM', '提醒类型不合法', 400);
      if (!['pending','open','acked','closed','all'].includes(status)) throw new AssessmentError('XG_BAD_PARAM', '提醒状态不合法', 400);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new AssessmentError('XG_BAD_PARAM', '分页参数不合法', 400);
      for (let attempt = 0; attempt < 3; attempt++) {
        const match = await requireMatch(store, matchId); authorizeMatch(principal, match);
        await combinations.refresh(matchId);
        const before = await store.get(C.combinationJobs, matchId); assertScope(before, match);
        const events = await store.eventsForMatch(matchId);
        for (const e of events) assertScope(e, match);
        const sources = new Map(events.map((e) => [e.event_id, e]));
        const sessions = [...new Set(events.filter((e) => e.status === 'submitted').map((e) => e.session_no))].sort((a,b) => a-b);
        const candidates = [];
        for (const session of sessions) {
          const result = await combinations.read(matchId, session);
          if (result) for (const signal of result.raw.signals) candidates.push({ signal, result });
        }
        const snapshot = await store.transaction(async (tx) => {
          const live = await requireMatch(tx, matchId); authorizeMatch(principal, live);
          const job = await tx.get(C.combinationJobs, matchId); assertScope(job, live);
          if ((job?.generation || 0) !== (before?.generation || 0) || (job && job.completed_generation !== job.generation)) return null;
          // Fetch global and case gates AFTER computing candidates, together in
          // this read snapshot. A rollback during recompute cannot use old gates.
          const effective = await policyIn(tx, live), dedup = new Map();
          for (const { signal, result } of candidates) {
            const source = sources.get(signal.event_id);
            if (!source || source.status !== 'submitted') throw pending();
            const item = projectReminder(signal, result, source, effective);
            const action = await tx.get(C.alertActions, signal.signal_id); assertScope(action, live);
            if (item && !dedup.has(item.alert_id)) dedup.set(item.alert_id, { ...item,
              status: action?.status || 'open', action_revision: action?.revision ?? 0, cst_step: action?.cst_step || 0,
              phone_followup_required: action?.phone_followup_required === true, phone_followup_done: action?.phone_followup_done === true });
          }
          const items = [...dedup.values()].filter((item) => (session_no === undefined || item.session_no === session_no) &&
            (alert_type === undefined || item.alert_type === alert_type) && (status === 'all' || (status === 'pending' ? item.status !== 'closed' : item.status === status))).sort((a,b) => b.session_no-a.session_no || a.alert_id.localeCompare(b.alert_id));
          // No hidden-item count, raw grades, scores, answers or version payloads.
          return { match_id: matchId, policy: effective, items: items.slice(offset, offset + limit) };
        });
        if (snapshot) return snapshot;
      }
      throw pending();
    }
  };
}
module.exports = { createReminderRepository, projectReminder };
