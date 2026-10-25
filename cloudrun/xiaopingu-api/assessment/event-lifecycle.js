const { COLLECTIONS: C, SCALES: S, AssessmentError, requireId, documentKey, eventPosition, scopeOf, assertScope } = require('./model');
const { requirePrincipal, authorizeMatch, deny } = require('./authorization');
const { scopeForCard } = require('./consent');
const { captureBasisInTransaction, verifyEventBasis } = require('./provenance');
const { requestHash } = require('./request-hash');
const { answerConstraints } = require('./answer-validation');
const { processAnswers } = require('./answer-processor');
const { requireMatch, ensurePosition, persistSubmitted, touchMatch } = require('./event-storage');
const { requireRecheckEligible } = require('./baseline-reference');
const { requestIdentity, readReceipt, replayReceipt, saveReceipt } = require('./request-receipts');
const { createCombinationRepository, enqueueCombination, pending } = require('./combinations');
const { requireCollectionOpen } = require('./rollout');
const { requireFollowupDue, completeFollowup } = require('./followup-schedule');
const { enqueueLlm } = require('./llm-contract');
const {assertInScope,requireRiskDue,completeRisk}=require('./risk-recheck');

function author(principal, match, event) {
  requirePrincipal(principal); authorizeMatch(principal, match);
  const role = event.scale_code === S.pro ? 'counselor' : 'visitor';
  if (principal.role !== role || (event.actor_id && (event.actor_id !== principal.subject || event.actor_role !== role))) deny('只能操作本人角色的作答');
}
function ensureBasis(event) {
  const basis = verifyEventBasis(event);
  if (!basis) throw new AssessmentError('XG_BASIS_REQUIRED', '缺少历史题目依据，请重新开始填卡');
  return basis;
}
function elapsed(event, time) {
  const start = Date.parse(event.started_at || event.created_at);
  if (!Number.isFinite(start) || !Number.isFinite(time)) throw new AssessmentError('XG_EVENT_TIME_INVALID', '事件计时数据不合法');
  return Math.max(0, time - start);
}
function expired(event, time) {
  if (!event.expires_at) return false;
  const expiry = Date.parse(event.expires_at);
  if (!Number.isFinite(expiry)) throw new AssessmentError('XG_EVENT_TIME_INVALID', '事件到期时间不合法');
  return time >= expiry;
}

function createEventLifecycle(store, consent, { now = Date.now, timeoutMs = 30 * 60 * 1000 } = {}) {
  const combinations = createCombinationRepository(store, { now: () => new Date(now()).toISOString() });
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid attempt timeout');
  async function writeTransition(tx, match, previous, event, action, error = null, metadata = {}) {
    const id = documentKey(event.event_id, event.event_revision);
    if (await tx.get(C.eventTransitions, id)) throw new AssessmentError('XG_EVENT_CONFLICT', '事件修订历史已存在');
    await tx.put(C.eventTransitions, id, {
      ...scopeOf(match), event_id: event.event_id, revision: event.event_revision, action,
      from_status: previous?.status || null, to_status: event.status, actor_id: event.actor_id,
      actor_role: event.actor_role, occurred_at: event.updated_at, basis_hash: event.basis?.basis_hash || null,
      error: error ? { code: error.code, field: error.field } : null, ...metadata
    });
    await tx.put(C.events, event.event_id, event);
    await touchMatch(tx, match, event);
  }
  async function load(tx, principal, input) {
    const match = await requireMatch(tx, input.match_id);
    requireId(input.event_id, 'event_id');
    const event = await tx.get(C.events, input.event_id);
    if (!event) throw new AssessmentError('XG_NOT_FOUND', '作答记录不存在', 404);
    assertScope(event, match); author(principal, match, event);
    if (event.basis) verifyEventBasis(event);
    for (const key of ['scale_code', 'session_no', 'follow_round', 'client_event_id']) {
      if (input[key] !== undefined && input[key] !== event[key]) deny('不能更改作答归属或开始标识');
    }
    return { match, event };
  }
  async function abandonIn(tx, match, event, reason, time, metadata = {}) {
    const timestamp = new Date(time).toISOString();
    const next = { ...event, status: 'abandoned', abandoned_at: timestamp, updated_at: timestamp,
      abandon_reason: reason, duration_ms: elapsed(event, reason === 'timeout' && expired(event, time) ? Date.parse(event.expires_at) : time), event_revision: (event.event_revision || 0) + 1 };
    await writeTransition(tx, match, event, next, 'abandoned', null, metadata);
    return next;
  }

  return {
    async reapExpired({ limit = 50 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AssessmentError('XG_BAD_PARAM', '回收批量须为1至100', 400);
      const rows = await store.expiredEvents(new Date(now()).toISOString(), limit), results = [], errors = [];
      for (const row of rows) {
        try {
          const id = requireId(row._id, 'event_id');
          const outcome = await store.transaction(async (tx) => {
            const event = await tx.get(C.events, id), time = now();
            if (!event || !['started','rejected'].includes(event.status) || !expired(event,time)) return 'skipped';
            if (event.event_id !== id) throw new AssessmentError('XG_SCOPE_MISMATCH', '作答标识不一致');
            const match = await requireMatch(tx,event.match_id); assertScope(event,match);
            if (event.basis) verifyEventBasis(event);
            await abandonIn(tx,match,event,'timeout',time,{initiator:'scheduler'});
            return 'reaped';
          });
          results.push({event_id:id,outcome});
        } catch (error) {
          errors.push({event_id:typeof row._id==='string'?row._id:null,
            code:typeof error.code==='string'&&/^[A-Za-z0-9_.-]{1,80}$/.test(error.code)?error.code:'XG_REAP_FAILED'});
        }
      }
      return {scanned:rows.length,results,errors,more_possible:rows.length===limit};
    },
    async start(principal, input) {
      requirePrincipal(principal);
      const position = eventPosition(input);
      requireId(input.client_event_id, 'client_event_id');
      const identity = requestIdentity(principal, 'start', input);
      const eventId = documentKey('attempt', principal.role, principal.subject, input.client_event_id);
      return store.transaction(async (tx) => {
        const time = now();
        const timestamp = new Date(time).toISOString();
        const match = await requireMatch(tx, input.match_id);
        author(principal, match, input);
        const existing = await tx.get(C.events, eventId);
        const receipt = await readReceipt(tx, identity, existing);
        if (receipt) {
          assertScope(existing, match); author(principal, match, existing); ensureBasis(existing);
          if (['submitted', 'abandoned'].includes(existing.status)) return replayReceipt(receipt, existing);
          if (expired(existing, time)) return replayReceipt(receipt, await abandonIn(tx, match, existing, 'timeout', time));
          await assertInScope(tx,match);await requireRiskDue(tx,match,existing);
          ensurePosition(match, existing);
          await consent.requireInTransaction(tx, match.visitor_id, scopeForCard(existing.scale_code), { lock: false });
          await requireRecheckEligible(tx, match, existing, time);
          await requireFollowupDue(tx, match, existing, time);
          return replayReceipt(receipt, existing);
        }
        const complete = (result) => saveReceipt(tx, identity, match, result, timestamp);
        if (existing) {
          if (existing.match_id !== input.match_id || existing.scale_code !== input.scale_code ||
              existing.session_no !== input.session_no || existing.follow_round !== position.follow_round) {
            throw new AssessmentError('XG_IDEMPOTENCY_CONFLICT', '该开始标识已用于其他卡片');
          }
          assertScope(existing, match); author(principal, match, existing); ensureBasis(existing);
          if (['submitted', 'abandoned'].includes(existing.status)) return complete({ event: existing, duplicated: true });
          if (expired(existing, time)) return complete({ event: await abandonIn(tx, match, existing, 'timeout', time), duplicated: false, statusCode: 200 });
          await assertInScope(tx,match);await requireRiskDue(tx,match,existing);
          ensurePosition(match, existing);
          await consent.requireInTransaction(tx, match.visitor_id, scopeForCard(existing.scale_code));
          await requireRecheckEligible(tx, match, existing, time);
          await requireFollowupDue(tx, match, existing, time);
          return complete({ event: existing, duplicated: true });
        }
        await assertInScope(tx,match);
        await requireCollectionOpen(tx);
        ensurePosition(match, { ...input, follow_round: position.follow_round });
        const consentRef = await consent.requireInTransaction(tx, match.visitor_id, scopeForCard(input.scale_code));
        if (await tx.get(C.submissions, position.submission_id)) throw new AssessmentError('XG_ALREADY_SUBMITTED', '该卡片已提交');
        const event = {
          ...scopeOf(match), event_id: eventId, scale_code: input.scale_code, session_no: input.session_no,
          follow_round: position.follow_round, submission_id: position.submission_id, client_event_id: input.client_event_id,
          actor_id: principal.subject, actor_role: principal.role, status: 'started', event_revision: 1,
          raw_answers: {}, scores: {}, started_at: timestamp, created_at: timestamp, updated_at: timestamp,
          submitted_at: null, expires_at: new Date(time + timeoutMs).toISOString(), start_consent: consentRef
        };
        event.basis = await captureBasisInTransaction(tx, match, event, timestamp);
        await requireRiskDue(tx,match,event);
        await requireRecheckEligible(tx, match, event, time);
        await requireFollowupDue(tx, match, event, time);
        await writeTransition(tx, match, null, event, 'started');
        return complete({ event, duplicated: false });
      });
    },

    async submit(principal, input) {
      requirePrincipal(principal);
      if (input.duration_ms !== undefined && (!Number.isSafeInteger(input.duration_ms) || input.duration_ms < 0)) {
        throw new AssessmentError('XG_BAD_PARAM', 'duration_ms 不合法', 400);
      }
      const fingerprint = requestHash({ answers: input.answers ?? null });
      const outcome = await store.transaction(async (tx) => {
        const time = now();
        const { match, event } = await load(tx, principal, input);
        const basis = ensureBasis(event);
        const identity = requestIdentity(principal, 'submit', input, event);
        const receipt = await readReceipt(tx, identity, event);
        if (receipt) return replayReceipt(receipt, event);
        const complete = (result) => saveReceipt(tx, identity, match, result, new Date(time).toISOString());
        if (event.status === 'submitted') {
          if (event.submission_fingerprint === fingerprint) return complete({ event, duplicated: true });
          throw new AssessmentError('XG_ALREADY_SUBMITTED', '已提交答案不可改写');
        }
        if (event.status === 'abandoned') throw new AssessmentError('XG_EVENT_ABANDONED', '本次填卡已放弃，请重新开始');
        if (!['started', 'rejected'].includes(event.status)) throw new AssessmentError('XG_EVENT_STATE', '当前状态不可提交');
        if (expired(event, time)) {
          const abandoned = await abandonIn(tx, match, event, 'timeout', time);
          return complete({ event: abandoned, error: { code: 'XG_EVENT_EXPIRED', message: '本次填卡已超时，请重新开始' }, statusCode: 409 });
        }
        await assertInScope(tx,match);
        await requireRiskDue(tx,match,event);
        ensurePosition(match, event);
        const consentRef = await consent.requireInTransaction(tx, match.visitor_id, scopeForCard(event.scale_code));
        if (await tx.get(C.submissions, event.submission_id)) throw new AssessmentError('XG_ALREADY_SUBMITTED', '该卡片已由另一次填卡提交');
        await requireRecheckEligible(tx, match, event, time);
        await requireFollowupDue(tx, match, event, time);
        if (event.status === 'rejected' && event.submission_fingerprint === fingerprint) {
          return complete({ event, duplicated: true, error: event.validation_error, statusCode: 422 });
        }
        const duration = elapsed(event, time);
        const result = processAnswers(basis, input.answers, duration);
        const timestamp = new Date(time).toISOString();
        if (!result.valid) {
          const rejected = { ...event, status: 'rejected', scores: {}, raw_answers: {},
            validation_error: result.error, submission_fingerprint: fingerprint, rejected_at: timestamp,
            updated_at: timestamp, duration_ms: duration, event_revision: (event.event_revision || 0) + 1 };
          await writeTransition(tx, match, event, rejected, 'rejected', result.error);
          // Return the rejection out of the transaction; throwing here would erase the audit trail.
          return complete({ event: rejected, error: result.error, statusCode: 422, duplicated: false });
        }
        const submitted = { ...event, status: 'submitted', raw_answers: result.answers, scores: result.scores,
          quality_flag: result.quality_flag, duration_ms: duration, client_duration_ms: input.duration_ms ?? null,
          submitted_at: timestamp, updated_at: timestamp, validation_error: null,
          submission_fingerprint: fingerprint, submission_consent: consentRef, event_revision: (event.event_revision || 0) + 1 };
        await persistSubmitted(tx, match, submitted);
        await completeRisk(tx,match,submitted);
        await completeFollowup(tx, match, submitted);
        await writeTransition(tx, match, event, submitted, 'submitted');
        await enqueueCombination(tx, match, submitted);
        await enqueueLlm(tx, match, submitted, timestamp);
        return complete({ event: submitted, duplicated: false });
      });
      if (outcome.event.status === 'submitted') {
        // The answer + receipt + dirty generation are already durable. Retrying
        // the same request after a failure also resumes this work, without scoring twice.
        try { await combinations.refresh(outcome.event.match_id); }
        catch { throw pending(); }
      }
      return outcome;
    },

    async abandon(principal, input) {
      requirePrincipal(principal);
      const reason = input.reason ?? 'user_exit';
      if (!['timeout', 'user_exit', 'page_leave'].includes(reason)) throw new AssessmentError('XG_BAD_PARAM', '放弃原因不合法', 400);
      return store.transaction(async (tx) => {
        const { match, event } = await load(tx, principal, input);
        const identity = requestIdentity(principal, 'abandon', input, event);
        const receipt = await readReceipt(tx, identity, event);
        if (receipt) return replayReceipt(receipt, event);
        const complete = (result) => saveReceipt(tx, identity, match, result, new Date(now()).toISOString());
        if (event.status === 'submitted') throw new AssessmentError('XG_ALREADY_SUBMITTED', '已提交记录不可放弃');
        if (event.status === 'abandoned') return complete({ event, duplicated: true });
        if (!['started', 'rejected'].includes(event.status)) throw new AssessmentError('XG_EVENT_STATE', '当前状态不可放弃');
        if (reason === 'timeout' && !expired(event, now())) throw new AssessmentError('XG_EVENT_NOT_EXPIRED', '服务器到期时间尚未到达');
        return complete({ event: await abandonIn(tx, match, event, reason, now()), duplicated: false });
      });
    }
  };
}

function formView(event) {
  if (!['started', 'rejected'].includes(event.status)) return null;
  const basis = ensureBasis(event);
  return { scale_code: basis.card.scale_code, name: basis.card.name, intro_text: basis.card.intro_text,
    items: basis.items.map((item) => ({ ...Object.fromEntries(['code', 'label', 'dim', 'text', 'anchor_low', 'anchor_high', 'item_type',
      'options', 'required', 'applicable', 'not_applicable_reason', 'sort_order'].map((key) => [key, item[key]])),
      validation: answerConstraints(basis, item) })) };
}

module.exports = { createEventLifecycle, formView };
