const { validateAnswers } = require('./answer-validation');
const { scoringEngine } = require('./scoring-engines');

function processAnswers(basis, input, durationMs) {
  const score = scoringEngine(basis.rules.engine_id);
  const validation = validateAnswers(basis, input);
  if (!validation.valid) return validation;
  return score(basis, validation.answers, durationMs);
}

module.exports = { processAnswers };
