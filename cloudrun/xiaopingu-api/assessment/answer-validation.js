const { AssessmentError } = require('./model');

// The xg-core-t03-v1 contract: every applicable question in the frozen form is
// required. Optional modules are selected when the form is captured, not here.
function answerConstraints(basis, item) {
  if (typeof item.applicable !== 'boolean' || item.required !== item.applicable) {
    throw new AssessmentError('XG_BASIS_INVALID', '题目必填与适用状态不一致');
  }
  switch (item.item_type) {
    case 'slider':
      return { min: basis.rules.answer_range.min, max: basis.rules.answer_range.max, integer: true };
    case 'single_choice':
      return { values: item.options.map((option) => option.value) };
    case 'text':
      // Preserve T09's JS string-length limit; do not silently change historical
      // acceptance rules for emoji/surrogate pairs or trim stored user feedback.
      return { max_length: 2000, non_blank: true, length_unit: 'utf16' };
    default:
      throw new AssessmentError('XG_BASIS_INVALID', '不支持的题目类型');
  }
}

function validateAnswers(basis, input) {
  const reject = (code, field, message) => ({ valid: false, error: { code, field, message } });
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) {
    return reject('XG_BAD_ANSWERS', 'answers', '答案必须为题号与作答值组成的对象');
  }
  const known = new Set(basis.items.map((item) => item.code));
  if (Object.keys(input).some((code) => !known.has(code))) {
    return reject('XG_UNKNOWN_ITEM', 'answers', '答案包含本次卡片以外的题目');
  }
  const answers = {};
  for (const item of basis.items) {
    const constraints = answerConstraints(basis, item);
    const value = Object.hasOwn(input, item.code) ? input[item.code] : undefined;
    if (!item.applicable) {
      if (value !== undefined && value !== null) return reject('XG_ITEM_NOT_APPLICABLE', item.code, '该题本次不适用');
      continue;
    }
    if (value === undefined || value === null) return reject('XG_MISSING_ITEM', item.code, '请完成该必答项');
    if (item.item_type === 'text') {
      if (typeof value !== 'string' || !value.trim() || value.length > constraints.max_length) {
        return reject('XG_VALUE_RANGE', item.code, '请填写非空文本，内容过长时请缩短后重试');
      }
    } else if (item.item_type === 'single_choice') {
      if (!constraints.values.includes(value)) return reject('XG_VALUE_RANGE', item.code, '请选择本题提供的选项');
    } else if (!Number.isInteger(value) || value < constraints.min || value > constraints.max) {
      return reject('XG_VALUE_RANGE', item.code, '请提供范围内的整数');
    }
    answers[item.code] = value;
  }
  return { valid: true, answers };
}

module.exports = { validateAnswers, answerConstraints };
