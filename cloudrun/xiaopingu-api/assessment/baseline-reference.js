const { COLLECTIONS: C, SCALES: S, AssessmentError } = require('./model');
const { readProfile } = require('./event-storage');

function referenceBaseline(profile) {
  if (!profile) return null;
  const source = profile.recheck ? 'late_recheck' : 'original';
  const snapshot = profile.recheck || profile.original;
  if (!snapshot || snapshot.session_no !== (source === 'late_recheck' ? 1 : 0) ||
      !Number.isInteger(snapshot.total) || snapshot.total < 0 || snapshot.total > 70) {
    throw new AssessmentError('XG_BASELINE_INVALID', '参照基线记录不完整，请核对历史数据');
  }
  return { ...snapshot, source };
}

async function requireRecheckEligible(tx, match, event, time) {
  if (event.scale_code !== S.state || event.session_no !== 1) return;
  const profile = await readProfile(tx, C.baselines, match);
  const baselineTime = Date.parse(profile?.original?.submitted_at);
  const days = event.basis.rules.timing.late_recheck_days;
  if (!profile || (match.last_session_no || 0) > 0 || !Number.isFinite(baselineTime) ||
      time - baselineTime <= days * 86400000) {
    throw new AssessmentError('XG_RECHECK_NOT_DUE', '仅首节前且原始基线超过规定天数时可重测');
  }
}

module.exports = { referenceBaseline, requireRecheckEligible };
