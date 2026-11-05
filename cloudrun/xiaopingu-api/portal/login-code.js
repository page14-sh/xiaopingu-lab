// 咨询师短登录码：6 位数字，注册时生成、全局唯一。
// 与 43 位编辑码并存——编辑码老链接、老输法全部照常可用；
// 短码让咨询师记住/输入 6 位即可登录工作台，不必每次翻 43 位码。
// ⚠️ 6 位数字空间有限，放开短码登录必须配失败限流（见 LoginRateLimiter），
// 这是短码上线的前提，不是可选项。
const crypto = require('node:crypto');

const LOGIN_CODE_LENGTH = 6;

function safeEqual(left, right) {
  const a = Buffer.from(String(left == null ? '' : left));
  const b = Buffer.from(String(right == null ? '' : right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeCredential(value) {
  return String(value == null ? '' : value).trim();
}

// 形状守卫：只有 6 位纯数字才按短码匹配，避免与编辑码/别名混淆
function isLoginCodeShape(value) {
  return new RegExp('^\\d{' + LOGIN_CODE_LENGTH + '}$').test(normalizeCredential(value));
}

function randomLoginCode() {
  // 100000–999999：不用前导零，避免口头传达时丢零
  return String(100000 + crypto.randomInt(0, 900000));
}

async function generateUniqueLoginCode(exists) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = randomLoginCode();
    // eslint-disable-next-line no-await-in-loop
    if (!(await exists(code))) return code;
  }
  throw new Error('无法生成唯一登录码，请重试');
}

// 凭证匹配：完整编辑码优先，其次 6 位短码；返回 { counselor, via }
function findCounselorByCredential(counselors, credential) {
  const value = normalizeCredential(credential);
  if (!value) return { counselor: null, via: null };
  const byEditToken = counselors.find((item) => typeof item.edit_token === 'string'
    && item.edit_token.length > 0 && safeEqual(item.edit_token, value));
  if (byEditToken) return { counselor: byEditToken, via: 'edit-token' };
  if (isLoginCodeShape(value)) {
    const byCode = counselors.find((item) => typeof item.login_code === 'string'
      && item.login_code.length > 0 && safeEqual(item.login_code, value));
    if (byCode) return { counselor: byCode, via: 'login-code' };
  }
  return { counselor: null, via: null };
}

// 内存失败限流：只累计失败，成功即清除该凭证计数（正常登录不消耗配额）。
// CloudRun 单实例部署下有效（与 demo-accounts.js 的同款模式）。
// 多实例横向扩容时需换共享存储，现阶段咨询师规模（数十至数百人）不触发。
class LoginRateLimiter {
  constructor({ windowMs = 15 * 60 * 1000, maxPerCredential = 5, maxPerIp = 30 } = {}) {
    this.windowMs = windowMs;
    this.maxPerCredential = maxPerCredential;
    this.maxPerIp = maxPerIp;
    this.failures = new Map();
  }
  _count(key, now) {
    const record = this.failures.get(key);
    if (!record || now - record.first >= this.windowMs) return 0;
    return record.count;
  }
  _record(key, now) {
    const record = this.failures.get(key);
    if (!record || now - record.first >= this.windowMs) {
      this.failures.set(key, { first: now, count: 1 });
      return;
    }
    record.count += 1;
  }
  allowed(ip, credential) {
    const now = Date.now();
    if (this._count('ip:' + normalizeCredential(ip), now) >= this.maxPerIp) return false;
    if (normalizeCredential(credential)
      && this._count('cred:' + normalizeCredential(credential), now) >= this.maxPerCredential) return false;
    return true;
  }
  recordFailure(ip, credential) {
    const now = Date.now();
    this._record('ip:' + normalizeCredential(ip), now);
    if (normalizeCredential(credential)) this._record('cred:' + normalizeCredential(credential), now);
    this._sweep(now);
  }
  reset(credential) {
    this.failures.delete('cred:' + normalizeCredential(credential));
  }
  _sweep(now) {
    for (const [key, record] of this.failures) {
      if (now - record.first >= this.windowMs) this.failures.delete(key);
    }
  }
}

module.exports = {
  LOGIN_CODE_LENGTH,
  safeEqual,
  normalizeCredential,
  isLoginCodeShape,
  randomLoginCode,
  generateUniqueLoginCode,
  findCounselorByCredential,
  LoginRateLimiter
};
