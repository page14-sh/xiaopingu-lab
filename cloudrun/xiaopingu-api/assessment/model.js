const { createHash } = require('node:crypto');

const COLLECTIONS = Object.freeze({
  matches: 'xg_matches',
  riskStates: 'xg_risk_states',
  activeMatches: 'xg_active_matches',
  events: 'xg_assessment_events',
  submissions: 'xg_submissions',
  baselines: 'xg_baseline_profiles',
  ends: 'xg_end_profiles',
  visitors: 'xg_visitors',
  assertions: 'xg_identity_assertions',
  intakes: 'xg_intake_owners',
  requests: 'xg_match_requests',
  switches: 'xg_case_switches',
  llmResults: 'xg_llm_results',
  llmJobs: 'xg_llm_jobs',
  llmAttempts: 'xg_llm_attempts',
  llmHistory: 'xg_llm_history',
  llmAudit: 'xg_llm_audit',
  tagWeightProposals: 'xg_tag_weight_proposals',
  tagWeights: 'xg_tag_weights',
  consentPolicies: 'xg_consent_policies',
  consentDocuments: 'xg_consent_documents',
  consentStates: 'xg_consent_states',
  consentHistory: 'xg_consent_history',
  itemVersions: 'xg_item_versions',
  ruleVersions: 'xg_rule_versions',
  assessmentRelease: 'xg_assessment_release',
  caseAssessmentConfigs: 'xg_case_assessment_configs',
  eventTransitions: 'xg_event_transitions',
  requestReceipts: 'xg_request_receipts',
  combinationJobs: 'xg_combination_jobs',
  rawSignals: 'xg_raw_signals',
  combinations: 'xg_session_combinations',
  combinationHistory: 'xg_combination_history',
  rollout: 'xg_rollout_policy',
  rolloutHistory: 'xg_rollout_history',
  followupJobs: 'xg_followup_jobs',
  notificationTasks: 'xg_notification_tasks',
  notificationAttempts: 'xg_notification_attempts',
  notificationInbox: 'xg_notification_inbox',
  notificationRecipients: 'xg_notification_recipients',
  notificationAudit: 'xg_notification_audit',
  notificationBridge: 'xg_notification_bridge',
  alertActions: 'xg_alert_actions'
});

const SCALES = Object.freeze({
  baseline: 'xg_m0_baseline', state: 'xg_m1_state', feel: 'xg_m2_feel',
  pro: 'xg_m3_pro', end: 'xg_m4_end', evaluation: 'xg_m4_eval', follow: 'xg_m4_follow'
});
const RISK_SCALE = 'xg_risk_recheck';
const SCALE_CODES = [...Object.values(SCALES), RISK_SCALE];
const SCORE_FIELDS = Object.freeze([
  'total', 'pct', 'ors_total', 'add_total', 'supp_total',
  'resource_total', 'dissoc_level', 'stability_total'
]);

class AssessmentError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = 'AssessmentError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function requireId(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new AssessmentError('XG_BAD_PARAM', `${field} must be a non-empty identifier`, 400);
  }
  return value;
}

function requireSession(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new AssessmentError('XG_BAD_PARAM', 'Invalid session_no', 400);
  }
  return value;
}

// JSON tuples avoid collisions between components containing separators.
function documentKey(...parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function eventPosition(input) {
  requireId(input.match_id, 'match_id');
  if (!SCALE_CODES.includes(input.scale_code)) {
    throw new AssessmentError('XG_BAD_PARAM', 'Unknown scale_code', 400);
  }
  requireSession(input.session_no, input.scale_code === SCALES.baseline ? 0 : 1);
  const round = input.follow_round === undefined ? '' : input.follow_round;
  if (input.scale_code === SCALES.baseline && input.session_no !== 0) {
    throw new AssessmentError('XG_BAD_PARAM', 'M0 belongs to session 0', 400);
  }
  if (input.scale_code === SCALES.follow ? !['1m', '3m'].includes(round) : round !== '') {
    throw new AssessmentError('XG_BAD_PARAM', 'Invalid follow_round for this card', 400);
  }
  // A cycle has one baseline, one end/evaluation and one answer per follow-up round.
  // Changing session_no must not create a second end or follow-up answer.
  const position = [SCALES.baseline, SCALES.end, SCALES.evaluation, SCALES.follow]
    .includes(input.scale_code) ? 'cycle' : input.session_no;
  return {
    follow_round: round,
    submission_id: documentKey(input.match_id, input.scale_code, position, round)
  };
}

function scopeOf(match) {
  return { match_id: match.match_id, visitor_id: match.visitor_id, counselor_id: match.counselor_id };
}

function assertScope(row, match) {
  if (row && Object.entries(scopeOf(match)).some(([key, value]) => row[key] !== value)) {
    throw new AssessmentError('XG_SCOPE_MISMATCH', 'Stored record belongs to a different cycle');
  }
}

function basisReference(event) {
  if (!event.basis) return null;
  return {
    item_version: event.basis.item_version, rule_version: event.basis.rule_version,
    basis_hash: event.basis.basis_hash, config_revision: event.basis.context.config_revision,
    focus_revision: event.basis.context.focus_revision, optional_enabled: event.basis.context.optional_enabled
  };
}

function scoreSnapshot(event) {
  return {
    event_id: event.event_id,
    session_no: event.session_no,
    submitted_at: event.submitted_at,
    basis_ref: basisReference(event),
    ...Object.fromEntries(SCORE_FIELDS.map((field) => [field, event.scores[field] ?? null]))
  };
}

module.exports = {
  COLLECTIONS, SCALES, SCALE_CODES, RISK_SCALE, SCORE_FIELDS, AssessmentError,
  requireId, requireSession, documentKey, eventPosition, scopeOf, assertScope, scoreSnapshot, basisReference
};
