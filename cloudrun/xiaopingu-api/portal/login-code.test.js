const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const {
  LOGIN_CODE_LENGTH, isLoginCodeShape, randomLoginCode, generateUniqueLoginCode,
  findCounselorByCredential, LoginRateLimiter
} = require('./login-code');
const { createRequestHandler, signSession } = require('../app');
const { fixture } = require('../../../scripts/fixtures/v2-portal.cjs');

const counselors = [
  { id: 'c1', edit_token: 'edit-token-alpha', login_code: '100001' },
  { id: 'c2', edit_token: 'edit-token-bravo', login_code: '100002' },
  { id: 'c3', edit_token: 'edit-token-charlie' } // 存量未生成短码
];

test('short login codes are six digits without leading zero', () => {
  assert.equal(LOGIN_CODE_LENGTH, 6);
  for (let i = 0; i < 200; i += 1) {
    const code = randomLoginCode();
    assert.match(code, /^[1-9]\d{5}$/);
    assert.ok(Number(code) >= 100000 && Number(code) <= 999999);
  }
  assert.ok(isLoginCodeShape('482913'));
  assert.ok(!isLoginCodeShape('48291'));
  assert.ok(!isLoginCodeShape('4829134'));
  assert.ok(!isLoginCodeShape('48a913'));
  // 首尾空白先 Trim 再判形状（用户粘贴带空格是常态，Trim 后应匹配）
  assert.ok(isLoginCodeShape(' 482913 '));
  assert.ok(!isLoginCodeShape('edit-token-alpha'));
  assert.ok(!isLoginCodeShape(''));
});

test('generateUniqueLoginCode avoids collisions and always returns six digits', async () => {
  const taken = new Set(['100000', '200000']);
  const code = await generateUniqueLoginCode(async (candidate) => taken.has(candidate));
  assert.match(code, /^[1-9]\d{5}$/);
  assert.ok(!taken.has(code));
  let calls = 0;
  await assert.rejects(
    generateUniqueLoginCode(async () => { calls += 1; return true; }),
    /无法生成唯一登录码/
  );
  assert.equal(calls, 50);
});

test('credential lookup prefers the full edit token, then the short code', () => {
  assert.deepEqual(
    findCounselorByCredential(counselors, 'edit-token-bravo'),
    { counselor: counselors[1], via: 'edit-token' }
  );
  assert.deepEqual(
    findCounselorByCredential(counselors, '100002'),
    { counselor: counselors[1], via: 'login-code' }
  );
  // 短码形状守卫：非 6 位数字绝不按短码匹配
  assert.deepEqual(findCounselorByCredential(counselors, '10000'), { counselor: null, via: null });
  assert.deepEqual(findCounselorByCredential(counselors, '999999'), { counselor: null, via: null });
  assert.deepEqual(findCounselorByCredential(counselors, 'edit-token-charlie'), { counselor: counselors[2], via: 'edit-token' });
  assert.deepEqual(findCounselorByCredential(counselors, ''), { counselor: null, via: null });
  assert.deepEqual(findCounselorByCredential(counselors, undefined), { counselor: null, via: null });
});

test('rate limiter counts only failures, clears on success, and blocks after five misses', () => {
  const limiter = new LoginRateLimiter();
  const ip = '1.2.3.4';
  const code = '100001';
  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.allowed(ip, code), true);
    limiter.recordFailure(ip, code);
  }
  assert.equal(limiter.allowed(ip, code), false);
  // 同一 IP 换一个码仍可试（凭证维度独立计数）
  assert.equal(limiter.allowed(ip, '100002'), true);
  // 成功后清除该凭证计数，本人可立即再登
  limiter.reset(code);
  assert.equal(limiter.allowed(ip, code), true);
  // 凭证计数不影响 IP 维度；IP 阈值 30
  for (let i = 0; i < 30; i += 1) limiter.recordFailure('9.9.9.9', 'code-' + i);
  assert.equal(limiter.allowed('9.9.9.9', 'another-code'), false);
});

test('rate limiter window expires old failures', () => {
  const limiter = new LoginRateLimiter({ windowMs: 1000 });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.allowed('ip', 'code'), true);
    limiter.recordFailure('ip', 'code');
  }
  assert.equal(limiter.allowed('ip', 'code'), false);
  // 把计数记录的首次失败时间拨回窗口之前 → 视为已过期，放行
  limiter.failures.set('cred:code', { first: Date.now() - 5000, count: 5 });
  assert.equal(limiter.allowed('ip', 'code'), true);
  limiter.failures.set('ip:ip', { first: Date.now() - 5000, count: 30 });
  assert.equal(limiter.allowed('ip', 'code'), true);
});

// ---------- 集成：注册生成短码 → /auth/counselor 三种凭证 → 限流 ----------
const secret = 'synthetic-login-code-tests-only';
async function integrationSetup(t) {
  const f = await fixture();
  const server = http.createServer(createRequestHandler({ store: f.store, portalEnabled: true, sessionSecret: secret }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(method, path, body) {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    let data = null; try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, body: data };
  }
  return { ...f, request };
}

test('registration issues a unique six-digit code; short code, full edit token both log in', async t => {
  const f = await integrationSetup(t);
  const id = randomUUID();
  const reg = await f.request('POST', '/rest/v1/counselors', { id, name: '短码注册测试' });
  assert.equal(reg.status, 201);
  assert.match(reg.body[0].login_code, /^[1-9]\d{5}$/);
  const editToken = reg.body[0].edit_token;
  const saved = await f.source.get('counselors', id);
  assert.equal(saved.login_code, reg.body[0].login_code);

  // 6 位短码登录
  const byCode = await f.request('POST', '/auth/counselor', { credential: saved.login_code, password: '' });
  assert.equal(byCode.status, 200);
  assert.ok(byCode.body.token);
  assert.equal(byCode.body.counselor.id, id);
  assert.equal(byCode.body.counselor.login_code, saved.login_code);

  // 完整编辑码登录（老用法照常）
  const byToken = await f.request('POST', '/auth/counselor', { credential: editToken, password: '' });
  assert.equal(byToken.status, 200);
  assert.equal(byToken.body.counselor.id, id);

  // 短码带首尾空格也能登（用户粘贴容错）
  const padded = await f.request('POST', '/auth/counselor', { credential: '  ' + saved.login_code + ' ', password: '' });
  assert.equal(padded.status, 200);

  // 错误凭证 401，且响应不回显任何凭证
  const wrong = await f.request('POST', '/auth/counselor', { credential: '999999', password: '' });
  assert.equal(wrong.status, 401);
  assert.doesNotMatch(JSON.stringify(wrong.body), /login_code|edit_token/);
  // 非 6 位形状不当短码匹配
  const short = await f.request('POST', '/auth/counselor', { credential: saved.login_code.slice(0, 5), password: '' });
  assert.equal(short.status, 401);
});

test('failures lock the retried credential; the IP cap stops sweeping; success clears the count', async t => {
  const f = await integrationSetup(t);
  const id = randomUUID();
  const reg = await f.request('POST', '/rest/v1/counselors', { id, name: '限流测试' });
  const code = reg.body[0].login_code;

  // 同一候选码重试 5 次后，该候选码被锁（防已知短码的定向重试）
  for (let i = 0; i < 5; i += 1) {
    const miss = await f.request('POST', '/auth/counselor', { credential: '000000', password: '' });
    assert.equal(miss.status, 401);
  }
  const lockedSame = await f.request('POST', '/auth/counselor', { credential: '000000', password: '' });
  assert.equal(lockedSame.status, 429);
  assert.match(lockedSame.body.message, /登录尝试过多/);
  // 被锁的只是这个候选码，本人正确短码不受影响
  const ok = await f.request('POST', '/auth/counselor', { credential: code, password: '' });
  assert.equal(ok.status, 200);

  // IP 维度才是防横扫的底线：同一 IP 累计 30 次失败后，任何凭证都先过限流关。
  // 横扫用互不相同的候选码（每次换码，绕开按凭证锁定，只累计 IP 失败数）。
  // 前面 '000000' 已记 5 次失败，本条 IP 额度还能再失败 25 次
  for (let i = 0; i < 25; i += 1) {
    const candidate = String(200000 + i);
    const miss = await f.request('POST', '/auth/counselor', { credential: candidate, password: '' });
    assert.equal(miss.status, 401);
  }
  const swept = await f.request('POST', '/auth/counselor', { credential: code, password: '' });
  assert.equal(swept.status, 429);
});
