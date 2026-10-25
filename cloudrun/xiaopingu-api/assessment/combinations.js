const { COLLECTIONS: C, AssessmentError, requireId, requireSession, documentKey, scopeOf, assertScope } = require('./model');
const { requireMatch } = require('./event-storage');
const { contentHash } = require('./provenance');
const { evaluateCombinations, RELEVANT } = require('./combination-engine');
const { enqueueAlerts } = require('./notification-source');

function pending() { return new AssessmentError('XG_COMBINATION_PENDING', '作答已保存，组合判读待重试，请沿用原request_id', 503); }
async function enqueueCombination(tx, match, event) {
  if (!RELEVANT.includes(event.scale_code)) return;
  const current = await tx.get(C.combinationJobs, match.match_id); assertScope(current, match);
  await tx.put(C.combinationJobs, match.match_id, { ...scopeOf(match), generation: (current?.generation || 0) + 1,
    completed_generation: current?.completed_generation || 0, status: 'pending',
    last_event_id: event.event_id, requested_at: event.submitted_at });
}
function createCombinationRepository(store, { now = () => new Date().toISOString() } = {}) {
  async function refresh(matchId) {
    requireId(matchId, 'match_id');
    // Persist a small session result per transaction; never put an entire case's
    // potentially unbounded history into one CloudBase transaction.
    for (let attempt = 0; attempt < 3; attempt++) {
      const match = await requireMatch(store, matchId);
      const job = await store.get(C.combinationJobs, matchId); assertScope(job, match);
      if (!job || job.completed_generation === job.generation) return;
      const events = await store.eventsForMatch(matchId);
      if ((await requireMatch(store, matchId)).version !== match.version) continue;
      const results = evaluateCombinations(match, events);
      let changed = false;
      for (const result of results) {
        const accepted = await store.transaction(async (tx) => {
          const live = await requireMatch(tx, matchId), currentJob = await tx.get(C.combinationJobs, matchId);
          assertScope(currentJob, live);
          if (live.version !== match.version || currentJob?.generation !== job.generation) return false;
          const id = documentKey(matchId, result.session_no);
          const old = await tx.get(C.combinations, id); assertScope(old, match);
          const oldRaw = await tx.get(C.rawSignals, id); assertScope(oldRaw, match);
          const fingerprint = contentHash(result);
          if (old?.fingerprint === fingerprint && oldRaw?.fingerprint === fingerprint && oldRaw.revision === old.revision) {
            await enqueueAlerts(tx, match, result, old.computed_at);
            return true;
          }
          const revision = (old?.revision || 0) + 1, timestamp = now();
          const meta = { ...scopeOf(match), session_no: result.session_no, revision, fingerprint,
            generation: job.generation, computed_at: timestamp };
          const historyId = documentKey(matchId, result.session_no, revision);
          if (await tx.get(C.combinationHistory, historyId)) throw new AssessmentError('XG_COMBINATION_HISTORY_CONFLICT', '组合修订历史已存在', 503);
          await tx.put(C.rawSignals, id, { ...meta, ...result.raw });
          await tx.put(C.combinations, id, { ...meta, ...result.combined });
          await tx.put(C.combinationHistory, historyId, { ...meta, cause_event_id: job.last_event_id,
            previous_fingerprint: old?.fingerprint || null, raw: result.raw, combined: result.combined });
          await enqueueAlerts(tx, match, result, timestamp);
          return true;
        });
        if (!accepted) { changed = true; break; }
      }
      if (changed) continue;
      const done = await store.transaction(async (tx) => {
        const live = await requireMatch(tx, matchId), current = await tx.get(C.combinationJobs, matchId);
        assertScope(current, live);
        if (live.version !== match.version || current?.generation !== job.generation) return false;
        if (current.completed_generation !== current.generation) await tx.put(C.combinationJobs, matchId,
          { ...current, completed_generation: job.generation, status: 'complete', completed_at: now() });
        return true;
      });
      if (done) return;
    }
    throw pending();
  }
  return {
    refresh,
    async read(matchId, sessionNo, revision) {
      requireId(matchId, 'match_id'); requireSession(sessionNo);
      if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new AssessmentError('XG_BAD_PARAM', '修订号不合法', 400);
      if (revision === undefined) await refresh(matchId);
      return store.transaction(async (tx) => {
        const match = await requireMatch(tx, matchId);
        if (revision !== undefined) {
          const history = await tx.get(C.combinationHistory, documentKey(matchId, sessionNo, revision));
          assertScope(history, match);
          if (history && contentHash({ session_no: sessionNo, raw: history.raw, combined: history.combined }) !== history.fingerprint) throw pending();
          return history ? { session_no: sessionNo, revision, historical: true, raw: history.raw, combined: history.combined } : null;
        }
        const job = await tx.get(C.combinationJobs, matchId); assertScope(job, match);
        if (job && job.completed_generation !== job.generation) throw pending();
        const combined = await tx.get(C.combinations, documentKey(matchId, sessionNo));
        const raw = await tx.get(C.rawSignals, documentKey(matchId, sessionNo));
        assertScope(combined, match); assertScope(raw, match);
        if (!combined && !raw) return null;
        if (!combined || !raw || combined.revision !== raw.revision || combined.fingerprint !== raw.fingerprint) throw pending();
        // Explicit DTOs: never spread database records into public responses.
        const { signals, policy } = raw;
        const fields = ['status', 'missing_cards', 'reference_event_id', 'baseline_pending', 'event_ids', 'source_bases',
          'original_level', 'display_level', 'diff_post', 'alliance_stable', 'downgraded', 'reason', 'signal_ids'];
        const result = { session_no: sessionNo, raw: { policy, signals }, combined: Object.fromEntries(fields.map((key) => [key, combined[key]])) };
        if (contentHash(result) !== combined.fingerprint) throw pending();
        return { ...result, revision: combined.revision, historical: false };
      });
    }
  };
}

module.exports = { createCombinationRepository, enqueueCombination, pending };
