const { AssessmentError } = require('./model');

// Bounds follow the fixed T03 score ranges. Window sizes are safe integers,
// with no arbitrary small maximum: the evaluator never allocates missing rows.
const PARAMETERS = Object.freeze({
  outcome_drop_abs: { min: 0, exclusive_min: true, max: 70, unit: 'points' },
  outcome_drop_consecutive: { min: 2, max: Number.MAX_SAFE_INTEGER, integer: true, unit: 'sessions' },
  outcome_flat_delta: { min: 0, exclusive_min: true, max: 70, unit: 'points' },
  outcome_flat_consecutive: { min: 2, max: Number.MAX_SAFE_INTEGER, integer: true, unit: 'sessions' },
  stability_item_max: { min: 0, max: 10, unit: 'points' },
  stability_consecutive: { min: 2, max: Number.MAX_SAFE_INTEGER, integer: true, unit: 'sessions' },
  alliance_total_max: { min: 0, max: 40, unit: 'points' },
  alliance_dim_max: { min: 0, max: 10, unit: 'points' },
  alliance_consecutive: { min: 2, max: Number.MAX_SAFE_INTEGER, integer: true, unit: 'sessions' },
  diff_post_warn: { min: 0, exclusive_min: true, max: 100, unit: 'percentage_points' },
  l3_consecutive: { min: 3, max: Number.MAX_SAFE_INTEGER, integer: true, unit: 'sessions' },
  l3_low_pct: { min: 0, exclusive_min: true, max: 100, unit: 'percent' }
});
const RULE_PARAMETERS = Object.freeze({
  'OUT-LOW': ['l3_low_pct'], 'OUT-DROP': ['outcome_drop_abs', 'outcome_drop_consecutive'],
  'OUT-MONO': ['outcome_drop_abs', 'outcome_drop_consecutive', 'l3_consecutive'],
  'OUT-ACCEL': ['outcome_drop_abs', 'outcome_drop_consecutive', 'l3_consecutive'],
  'OUT-FLAT': ['outcome_flat_delta', 'outcome_flat_consecutive'], 'OUT-SINGLE': ['outcome_drop_abs'],
  'ALL-TOTAL': ['alliance_total_max', 'alliance_consecutive'], 'ALL-DIM': ['alliance_dim_max', 'alliance_consecutive'],
  'ALL-GAP': ['diff_post_warn'], 'STAB-SELF': ['stability_item_max', 'stability_consecutive'],
  'STAB-PRO': ['stability_item_max', 'stability_consecutive'], DISSOC: []
});
function validateThresholds(value, { partial = false } = {}) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || !Object.keys(value).length ||
      (!partial && Object.keys(value).length !== Object.keys(PARAMETERS).length)) {
    throw new AssessmentError('XG_RULE_PARAMETERS_INVALID', '阈值配置结构不完整', 400);
  }
  for (const [key, number] of Object.entries(value)) {
    const spec = Object.hasOwn(PARAMETERS, key) ? PARAMETERS[key] : null;
    if (!spec || !Number.isFinite(number) || (spec.integer && !Number.isSafeInteger(number)) ||
        (spec.exclusive_min ? number <= spec.min : number < spec.min) || (spec.max !== undefined && number > spec.max)) {
      throw new AssessmentError('XG_RULE_PARAMETERS_INVALID', `阈值参数不合法：${spec ? key : '未知字段'}`, 400);
    }
  }
  return structuredClone(value);
}
function parameterSchema() { return structuredClone(PARAMETERS); }

module.exports = { validateThresholds, parameterSchema, RULE_PARAMETERS };
