const { isDeepStrictEqual } = require('node:util');
const { AssessmentError, SCORE_FIELDS, basisReference } = require('./model');
const { verifyEventBasis } = require('./provenance');
const { processAnswers } = require('./answer-processor');

// Audit only: use the event's historical engine, answers and server duration.
// Never publish a version, read the current release or repair a record here.
function replayEventScores(event) {
  if (event.status !== 'submitted') throw new AssessmentError('XG_REPLAY_NOT_SUBMITTED', '仅已提交事件可复算');
  const basis = verifyEventBasis(event);
  if (!basis) throw new AssessmentError('XG_BASIS_REQUIRED', '缺少历史依据，不能猜测版本复算');
  if (!Number.isSafeInteger(event.duration_ms) || event.duration_ms < 0) {
    throw new AssessmentError('XG_REPLAY_DURATION_MISSING', '缺少可信作答耗时，不能完整复算');
  }
  const result = processAnswers(basis, event.raw_answers, event.duration_ms);
  if (!result.valid) throw new AssessmentError('XG_REPLAY_ANSWERS_INVALID', '历史答案不满足其冻结题面，不能复算');
  if (!event.scores || Object.getPrototypeOf(event.scores) !== Object.prototype ||
      Object.keys(event.scores).some((key) => !SCORE_FIELDS.includes(key)) ||
      Object.values(event.scores).some((value) => value !== null && !Number.isFinite(value))) {
    throw new AssessmentError('XG_REPLAY_SCORES_INVALID', '历史分数结构不完整，请人工核对');
  }
  const differences = SCORE_FIELDS.filter((key) =>
    Object.hasOwn(event.scores, key) !== Object.hasOwn(result.scores, key) ||
    !isDeepStrictEqual(event.scores[key], result.scores[key])).map((key) => `scores.${key}`);
  const storedQuality = ['low', 'ok'].includes(event.quality_flag) ? event.quality_flag : null;
  if (storedQuality !== result.quality_flag) differences.push('quality_flag');
  return { match_id: event.match_id, event_id: event.event_id, engine_id: basis.rules.engine_id,
    basis_ref: basisReference(event), matches: differences.length === 0, differences,
    stored: { scores: { ...event.scores }, quality_flag: storedQuality },
    recomputed: { scores: result.scores, quality_flag: result.quality_flag } };
}

module.exports = { replayEventScores };
