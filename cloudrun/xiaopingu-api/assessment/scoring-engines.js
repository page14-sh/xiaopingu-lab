const { SCALES: S, AssessmentError } = require('./model');

// Immutable implementation for frozen xg-core-t03-v1 events. Future algorithms
// must register a new engine ID instead of changing the meaning of this ID.
function scoreT03V1(basis, answers, durationMs) {
  const sum = (codes) => codes.reduce((total, code) => total + answers[code], 0);
  const code = basis.card.scale_code;
  const rules = basis.rules;
  const primaryUnavailable = basis.context.not_applicable_codes.length > 0;
  const total = primaryUnavailable ? null : sum(rules.primary_groups[code]);
  const scores = { total, pct: total === null ? null : Math.round(total / rules.primary_max[code] * 10000) / 100 };
  if ([S.baseline, S.state].includes(code)) {
    scores.ors_total = Math.round(sum(rules.ors.mean_items) / rules.ors.mean_items.length + sum(rules.ors.sum_items));
    scores.add_total = answers[rules.additional.item];
  }
  if (rules.supplement_groups[code]) scores.supp_total = sum(rules.supplement_groups[code]);
  if (code === S.baseline) {
    scores.resource_total = sum(rules.resource_group);
    scores.dissoc_level = answers[rules.dissociation.item];
  }
  if (code === S.state) scores.stability_total = basis.context.enabled_optional_codes.length ? sum(basis.context.enabled_optional_codes) : null;
  const numeric = Object.values(answers).filter((value) => typeof value === 'number');
  const qualityLow = durationMs < Object.keys(answers).length * rules.quality.duration_ms_per_answer ||
    (numeric.length > 0 && numeric.every((value) => value === numeric[0]));
  return { valid: true, answers, scores, quality_flag: qualityLow ? 'low' : 'ok' };
}

const ENGINES = Object.freeze({ 'xg-core-t03-v1': scoreT03V1 });
function scoringEngine(id) {
  if (!Object.hasOwn(ENGINES, id)) throw new AssessmentError('XG_RULE_ENGINE_UNAVAILABLE', '该历史规则引擎尚不支持', 503);
  return ENGINES[id];
}

module.exports = { scoringEngine };
