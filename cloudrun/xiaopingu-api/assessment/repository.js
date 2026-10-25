const { isDeepStrictEqual } = require('node:util');
const { captureBasisInTransaction, verifyEventBasis } = require('./provenance');
const { requireMatch, readProfile, emptyEnd, ensurePosition, persistSubmitted, touchMatch } = require('./event-storage');
const { referenceBaseline } = require('./baseline-reference');
const { replayEventScores } = require('./score-replay');
const { createCombinationRepository } = require('./combinations');
const { createRolloutRepository } = require('./rollout');
const { createReminderRepository } = require('./reminders');
const { scheduleFollowups, requireScheduledJob } = require('./followup-schedule');
const {
  COLLECTIONS: C, SCALES, SCORE_FIELDS, AssessmentError, requireId, requireSession,
  documentKey, eventPosition, scopeOf, assertScope, scoreSnapshot
} = require('./model');

function conflict(code, message) { throw new AssessmentError(code, message); }

function jsonObject(value, field) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new AssessmentError('XG_BAD_PARAM', `${field} must be a JSON object`, 400);
  }
  const copy = JSON.parse(JSON.stringify(value));
  if (!isDeepStrictEqual(copy, value)) {
    throw new AssessmentError('XG_BAD_PARAM', `${field} must contain JSON values`, 400);
  }
  return copy;
}

function buildEvent(input) {
  if (['basis', 'basis_hash', 'item_version', 'rule_version', 'optional_enabled', 'focus_text'].some((key) => Object.hasOwn(input, key))) {
    throw new AssessmentError('XG_BAD_PARAM', '计分依据只能由服务端生成', 400);
  }
  requireId(input.event_id, 'event_id');
  const position = eventPosition(input);
  if (!['started', 'submitted', 'rejected', 'abandoned'].includes(input.status)) {
    throw new AssessmentError('XG_BAD_PARAM', 'Invalid event status', 400);
  }
  const scores = jsonObject(input.scores ?? {}, 'scores');
  if (Object.entries(scores).some(([key, value]) =>
    !SCORE_FIELDS.includes(key) || (value !== null && !Number.isFinite(value)))) {
    throw new AssessmentError('XG_BAD_PARAM', 'Invalid computed scores', 400);
  }
  if (input.status !== 'submitted' && Object.keys(scores).length) {
    throw new AssessmentError('XG_BAD_PARAM', 'Unsubmitted attempts cannot have scores', 400);
  }
  return {
    event_id: input.event_id, match_id: input.match_id, scale_code: input.scale_code,
    session_no: input.session_no, follow_round: position.follow_round,
    submission_id: position.submission_id, status: input.status,
    raw_answers: jsonObject(input.raw_answers ?? {}, 'raw_answers'), scores
  };
}

/** Internal persistence API, NOT an authorization or scoring service.
 * Callers must authenticate/authorize and validate/compute answers before writing.
 * T04 keeps this API inaccessible through the generic REST collection gateway.
 */
function createAssessmentRepository(store, { now = () => new Date().toISOString() } = {}) {
  return {
    async createMatch(input) {
      const identity = Object.fromEntries(['match_id', 'visitor_id', 'counselor_id', 'assessment_id']
        .map((field) => [field, requireId(input[field], field)]));
      identity.previous_match_id = input.previous_match_id == null
        ? null : requireId(input.previous_match_id, 'previous_match_id');
      if (identity.previous_match_id === identity.match_id) {
        conflict('XG_SCOPE_MISMATCH', 'A cycle cannot be its own predecessor');
      }
      const timestamp = now();
      return store.transaction(async (tx) => {
        const existing = await tx.get(C.matches, identity.match_id);
        if (existing) {
          if (Object.entries(identity).some(([key, value]) => existing[key] !== value)) {
            conflict('XG_SCOPE_MISMATCH', 'Cannot change the identity of a consultation cycle');
          }
          return existing;
        }
        if (identity.previous_match_id) {
          const previous = await requireMatch(tx, identity.previous_match_id);
          if (previous.visitor_id !== identity.visitor_id || previous.status !== 'closed') {
            conflict('XG_SCOPE_MISMATCH', 'Predecessor must be a closed cycle for the same visitor');
          }
        }
        const pairId = documentKey(identity.visitor_id, identity.counselor_id);
        const active = await tx.get(C.activeMatches, pairId);
        if (active?.match_id) conflict('XG_ACTIVE_MATCH_EXISTS', 'This pair already has an active cycle');
        const match = {
          ...identity, status: 'active', version: 1,
          opened_at: timestamp, closed_at: null, closing_session_no: null
        };
        await tx.put(C.matches, match.match_id, match);
        await tx.put(C.activeMatches, pairId, scopeOf(match));
        return match;
      });
    },

    async closeMatch(matchId, sessionNo) {
      requireId(matchId, 'match_id');
      requireSession(sessionNo, 1);
      const timestamp = now();
      return store.transaction(async (tx) => {
        const match = await requireMatch(tx, matchId);
        if (match.status === 'closed') {
          if (match.closing_session_no !== sessionNo) {
            conflict('XG_ALREADY_CLOSED', 'Cannot change the final session of a closed cycle');
          }
          await requireScheduledJob(tx, match, '1m'); await requireScheduledJob(tx, match, '3m');
          return match;
        }
        if ((match.last_session_no || 0) > sessionNo) {
          conflict('XG_BAD_SESSION', 'Closing session precedes existing events');
        }
        const pairId = documentKey(match.visitor_id, match.counselor_id);
        const active = await tx.get(C.activeMatches, pairId);
        assertScope(active, match);
        const end = await readProfile(tx, C.ends, match) || emptyEnd(match);
        if ([end.end, end.evaluation].some((card) => card && card.session_no !== sessionNo)) {
          conflict('XG_BAD_SESSION', 'Closing session does not match the existing end cards');
        }
        const closed = {
          ...match, status: 'closed', closed_at: timestamp,
          closing_session_no: sessionNo, version: match.version + 1
        };
        closed.followup_due = await scheduleFollowups(tx, closed);
        await tx.put(C.matches, matchId, closed);
        await tx.put(C.ends, matchId, {
          ...end, closed_at: timestamp, closing_session_no: sessionNo, updated_at: timestamp,
          follow_1m_due_at: closed.followup_due['1m'], follow_3m_due_at: closed.followup_due['3m'],
          follow_1m_queued_at: null, follow_3m_queued_at: null,
          follow_1m_sent_at: null, follow_3m_sent_at: null, follow_1m_result: null, follow_3m_result: null
        });
        // Preserve the lock document; a future cycle can claim this pair again.
        await tx.put(C.activeMatches, pairId, {
          visitor_id: match.visitor_id, counselor_id: match.counselor_id, match_id: null
        });
        return closed;
      });
    },

    // Low-level import/test primitive. Public clients must use the guarded lifecycle service.
    // Scores are supplied by the trusted scoring service (T11/T12), never a public body.
    async insertEvent(input) {
      const data = buildEvent(input);
      const timestamp = now();
      return store.transaction(async (tx) => {
        const match = await requireMatch(tx, data.match_id);
        for (const field of ['visitor_id', 'counselor_id']) {
          if (input[field] !== undefined && input[field] !== match[field]) {
            conflict('XG_SCOPE_MISMATCH', 'Event identity does not match its cycle');
          }
        }
        const existing = await tx.get(C.events, data.event_id);
        if (existing) {
          assertScope(existing, match);
          if (Object.entries(data).some(([key, value]) => !isDeepStrictEqual(existing[key], value))) {
            conflict('XG_EVENT_CONFLICT', 'An event cannot be reassigned or overwritten');
          }
          verifyEventBasis(existing);
          return existing;
        }
        ensurePosition(match, data);
        const event = {
          ...data, ...scopeOf(match), created_at: timestamp,
          actor_id: data.scale_code === SCALES.pro ? match.counselor_id : match.visitor_id,
          actor_role: data.scale_code === SCALES.pro ? 'counselor' : 'visitor',
          submitted_at: data.status === 'submitted' ? timestamp : null,
          basis: await captureBasisInTransaction(tx, match, data, timestamp)
        };
        if (data.status === 'submitted') await persistSubmitted(tx, match, event);
        await tx.put(C.events, data.event_id, event);
        await touchMatch(tx, match, event);
        return event;
      });
    },

    getMatch(matchId) { return requireMatch(store, matchId); },

    async getEvent(matchId, eventId) {
      requireId(eventId, 'event_id');
      const match = await requireMatch(store, matchId);
      const event = await store.get(C.events, eventId);
      assertScope(event, match);
      if (event) verifyEventBasis(event);
      return event;
    },

    getRollout() { return createRolloutRepository(store).get(); },
    updateRollout(principal, input, options) { return createRolloutRepository(store).update(principal, input, options); },
    rolloutHistory(principal, scope, matchId, revision) { return createRolloutRepository(store).readHistory(principal, scope, matchId, revision); },
    collectionPaused() { return createRolloutRepository(store).collectionPaused(); },
    reminderInbox(principal, matchId, options) { return createReminderRepository(store).inbox(principal, matchId, options); },

    getCombination(matchId, sessionNo, revision) {
      return createCombinationRepository(store).read(matchId, sessionNo, revision);
    },

    async replayScores(matchId, eventId) {
      requireId(eventId, 'event_id');
      return store.transaction(async (tx) => {
        const match = await requireMatch(tx, matchId);
        const event = await tx.get(C.events, eventId);
        if (!event) throw new AssessmentError('XG_NOT_FOUND', '作答记录不存在', 404);
        assertScope(event, match);
        return replayEventScores(event);
      });
    },

    async getProfiles(matchId) {
      return store.transaction(async (tx) => {
        const match = await requireMatch(tx, matchId);
        return {
          match_id: matchId,
          baseline: await readProfile(tx, C.baselines, match),
          end: await readProfile(tx, C.ends, match)
        };
      });
    },

    async listEvents(matchId) {
      const match = await requireMatch(store, matchId);
      const events = await store.eventsForMatch(matchId);
      for (const event of events) { assertScope(event, match); verifyEventBasis(event); }
      return events;
    },

    // T19 writes versioned advisory results separately from deterministic scores.
    async listLlmResults(matchId, { eventId, limit = 50, offset = 0 } = {}) {
      const match = await requireMatch(store, matchId);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) {
        throw new AssessmentError('XG_BAD_PARAM', 'Invalid pagination', 400);
      }
      let rows;
      if (eventId) {
        requireId(eventId, 'event_id');
        // Check the event even when no result exists: never accept a cross-cycle event id.
        const event = await store.get(C.events, eventId);
        assertScope(event, match);
        rows = [await store.get(C.llmResults, eventId)].filter(Boolean).slice(offset, offset + limit);
      } else {
        rows = await store.llmResultsForMatch(matchId, { limit, offset });
      }
      const results = [];
      for (const result of rows) {
        assertScope(result, match);
        requireId(result.event_id, 'event_id');
        if (result._id !== result.event_id) conflict('XG_SCOPE_MISMATCH', 'LLM result event key mismatch');
        const event = await store.get(C.events, result.event_id);
        assertScope(event, match);
        if (event?.status === 'submitted') results.push({ ...result, session_no: event.session_no });
      }
      return results;
    },

    async getTrend(matchId) {
      // Baseline and event pages must represent the same cycle revision.
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await requireMatch(store, matchId);
        const baseline = await readProfile(store, C.baselines, before);
        const events = await store.eventsForMatch(matchId);
        for (const event of events) { assertScope(event, before); verifyEventBasis(event); }
        const after = await requireMatch(store, matchId);
        if (before.version !== after.version) continue;
        return {
          match_id: matchId, baseline, reference_baseline: referenceBaseline(baseline),
          points: events.filter((event) => event.status === 'submitted' && event.scale_code === SCALES.state && event.session_no >= 2)
            .sort((a, b) => a.session_no - b.session_no)
            .map(scoreSnapshot)
        };
      }
      throw new AssessmentError('XG_RETRY_READ', 'Cycle changed during trend read; retry', 503);
    }
  };
}

module.exports = { createAssessmentRepository };
