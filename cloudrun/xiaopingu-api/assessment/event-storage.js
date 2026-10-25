const { COLLECTIONS: C, SCALES: S, AssessmentError, requireId, scopeOf, assertScope, scoreSnapshot } = require('./model');

async function requireMatch(tx, matchId) {
  requireId(matchId, 'match_id');
  const match = await tx.get(C.matches, matchId);
  if (!match) throw new AssessmentError('XG_NOT_FOUND', 'Consultation cycle not found', 404);
  if (match.match_id !== matchId) throw new AssessmentError('XG_SCOPE_MISMATCH', 'Invalid stored consultation cycle');
  return match;
}
async function readProfile(tx, collection, match) {
  const record = await tx.get(collection, match.match_id);
  assertScope(record, match);
  return record;
}
function emptyEnd(match) {
  return { ...scopeOf(match), closed_at: match.closed_at, closing_session_no: match.closing_session_no,
    end: null, evaluation: null, follow_1m: null, follow_3m: null };
}
function ensurePosition(match, event) {
  if (event.scale_code === S.follow) {
    if (match.status !== 'closed' || event.session_no !== match.closing_session_no) {
      throw new AssessmentError('XG_BAD_SESSION', 'Follow-up must refer to the closed cycle and its final session');
    }
  } else if (![S.end, S.evaluation].includes(event.scale_code) && match.status !== 'active') {
    throw new AssessmentError('XG_RELATION_CLOSED', 'Regular cards cannot be added to a closed cycle');
  } else if (match.status === 'closed' && event.session_no !== match.closing_session_no) {
    throw new AssessmentError('XG_BAD_SESSION', 'End cards must refer to the final session');
  }
}
async function persistSubmitted(tx, match, event) {
  if (await tx.get(C.submissions, event.submission_id)) throw new AssessmentError('XG_ALREADY_SUBMITTED', 'This card position is already submitted');
  await tx.put(C.submissions, event.submission_id, { ...scopeOf(match), event_id: event.event_id,
    scale_code: event.scale_code, session_no: event.session_no, follow_round: event.follow_round });
  const snapshot = scoreSnapshot(event);
  if (event.scale_code === S.baseline) {
    if (await readProfile(tx, C.baselines, match)) throw new AssessmentError('XG_ALREADY_SUBMITTED', 'Original baseline already exists');
    await tx.put(C.baselines, match.match_id, { ...scopeOf(match), original: snapshot, recheck: null, updated_at: event.submitted_at });
  } else if (event.scale_code === S.state && event.session_no === 1) {
    const baseline = await readProfile(tx, C.baselines, match);
    if (!baseline) throw new AssessmentError('XG_BASELINE_REQUIRED', 'Recheck requires this cycle’s baseline');
    await tx.put(C.baselines, match.match_id, { ...baseline, recheck: snapshot, updated_at: event.submitted_at });
  } else if ([S.end, S.evaluation, S.follow].includes(event.scale_code)) {
    const end = await readProfile(tx, C.ends, match) || emptyEnd(match);
    const field = event.scale_code === S.end ? 'end' : event.scale_code === S.evaluation ? 'evaluation' : `follow_${event.follow_round}`;
    await tx.put(C.ends, match.match_id, { ...end, [field]: snapshot, updated_at: event.submitted_at });
  }
}
async function touchMatch(tx, match, event) {
  await tx.put(C.matches, match.match_id, { ...match, version: match.version + 1,
    last_session_no: event.status === 'submitted' ? Math.max(match.last_session_no || 0, event.session_no) : match.last_session_no || 0 });
}

module.exports = { requireMatch, readProfile, emptyEnd, ensurePosition, persistSubmitted, touchMatch };
