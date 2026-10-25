const { AssessmentError } = require('./model');
const TYPES = ['outcome', 'alliance', 'stability', 'dissociation','risk'];
const STEPS = ['核对填答与近期情况', '与来访共同查看并核对', '协商后续安排并记录'];
function typeOf(rule) {
  if (rule === 'RISK-RECHECK') return 'risk';
  if (rule === 'DISSOC') return 'dissociation';
  if (rule.startsWith('OUT-')) return 'outcome';
  if (rule.startsWith('ALL-')) return 'alliance';
  if (rule.startsWith('STAB-')) return 'stability';
  throw new AssessmentError('XG_REMINDER_INVALID', '提醒来源不受支持', 503);
}
function projectReminder(signal, combination, source, effective) {
  const type = typeOf(signal.rule_id), safety = ['dissociation','risk'].includes(type);
  const level = signal.rule_id === 'OUT-DROP' && combination.combined.downgraded ? 'L1' : signal.level;
  if (!['L1','L2','L3'].includes(level)) throw new AssessmentError('XG_REMINDER_INVALID', '提醒等级不合法', 503);
  if (!safety && !effective[`${level.toLowerCase()}_visible`]) return null;
  const cst = effective.cst_enabled && ['L2','L3'].includes(level);
  return { alert_id: signal.signal_id, match_id: source.match_id, session_no: source.session_no, event_id: signal.event_id,
    alert_type: type, alert_level: level, is_safety: safety, source_submitted_at: source.submitted_at,
    combination_revision: combination.revision,
    suggest_text: safety ? '请结合已有信息及时核对这条安全提示' : '这几节的数据值得一起看看',
    cst: { enabled: cst, steps: cst ? STEPS.slice() : [] } };
}

module.exports = { TYPES, projectReminder };
