const { createHash } = require('node:crypto');
const { AssessmentError } = require('./model');

// JSON.parse accepts numeric overflow (e.g. 1e400 -> Infinity). Fingerprint it
// without coercing it to null, so validation can persist a normal 422 receipt.
// For finite JSON inputs this encoding is byte-identical to T10 contentHash.
// Nonfinite tokens are unquoted, hence distinct from all valid JSON values.
function encode(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : String(value);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${encode(value[key])}`).join(',')}}`;
  }
  throw new AssessmentError('XG_BAD_PARAM', '请求须为JSON数据', 400);
}
function requestHash(value) { return createHash('sha256').update(encode(value)).digest('hex'); }

module.exports = { requestHash };
