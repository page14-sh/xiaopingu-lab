const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createRequestHandler, signSession } = require('../app');
const { fixture } = require('../../../scripts/fixtures/v2-portal.cjs');

// 规则：来访者只有在匹配成功（approved/contacted）后，才能看到咨询师勾选「允许对外公布」的联系方式；
// 未匹配、审批中、换一位咨询师、匿名浏览，都只能看到基本情况。
const secret = 'synthetic-visitor-contact-tests-only';

async function setup(t) {
  const f = await fixture();
  const server = http.createServer(createRequestHandler({ store: f.store, portalEnabled: true, sessionSecret: secret }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const admin = signSession({ role: 'admin', subject: 'admin', aud: 'xg-assessment', demo: false, auth_method: 'admin-password', exp: Date.now() + 60000 }, secret);
  async function request(method, path, body, headers) {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(headers || {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  }
  return { ...f, request, admin, counselorPath: '/rest/v1/counselors?id=eq.' + f.cid };
}

test('matched visitor sees only contacts the counselor flagged public; hidden items never leak', async t => {
  const f = await setup(t);
  // 咨询师档案：三项联系方式齐全，仅微信与邮箱勾选公开
  const patch = await f.request('PATCH', f.counselorPath, {
    contact_wechat: 'wx-synthetic', contact_wechat_public: true,
    contact_phone: '13900000000', contact_phone_public: false,
    contact_email: 'synthetic@example.invalid', contact_email_public: true
  }, { authorization: 'Bearer ' + f.admin });
  assert.equal(patch.status, 200);

  // 匿名浏览（无凭证）：任何联系方式都不可见
  let r = await f.request('GET', f.counselorPath);
  assert.equal(r.status, 200);
  assert.equal(r.body[0].contact_wechat, undefined);
  assert.equal(r.body[0].contact_phone, undefined);
  assert.equal(r.body[0].contact_email, undefined);

  // 匹配成功的来访者（fixture 已 approved）：只见勾选公开的微信与邮箱
  r = await f.request('GET', f.counselorPath, null, { 'x-assessment-token': f.asid });
  assert.equal(r.status, 200);
  assert.equal(r.body[0].contact_wechat, 'wx-synthetic');
  assert.equal(r.body[0].contact_email, 'synthetic@example.invalid');
  assert.equal(r.body[0].contact_phone, undefined);
  assert.equal(r.body[0].edit_token, undefined);
});

test('pending, other counselor and forged capability never unlock contacts', async t => {
  const f = await setup(t);
  await f.request('PATCH', f.counselorPath, { contact_wechat: 'wx-synthetic', contact_wechat_public: true }, { authorization: 'Bearer ' + f.admin });
  // 第二位已上岗咨询师：同样勾了公开微信
  const other = randomUUID();
  assert.equal((await f.request('POST', '/rest/v1/counselors', { id: other, name: '另一位咨询师' }, { authorization: 'Bearer ' + f.admin })).status, 201);
  assert.equal((await f.request('PATCH', '/rest/v1/counselors?id=eq.' + other, { contact_wechat: 'wx-other', contact_wechat_public: true, review_status: 'approved', is_active: true }, { authorization: 'Bearer ' + f.admin })).status, 200);

  // 审批中的来访者：看不到任何联系方式
  const pendingId = randomUUID();
  const pending = await f.store.portal.createIntake({ id: pendingId, view_token: pendingId, client_claim_secret: 'xpg2_' + Buffer.alloc(32, 3).toString('base64url'), visitor_name: '审批中来访者', crisis_level: 'safe' });
  await f.store.portal.patchIntake(pending, { match_request_cid: f.cid }, { role: 'visitor', principal: { subject: pending.visitor_user_id, role: 'visitor', aud: 'xg-assessment', auth_method: 'intake-receipt', demo: false, exp: Date.now() + 60000 } });
  for (const path of [f.counselorPath, '/rest/v1/counselors?id=eq.' + other]) {
    const r = await f.request('GET', path, null, { 'x-assessment-token': pendingId });
    assert.equal(r.status, 200); assert.equal(r.body[0].contact_wechat, undefined);
  }

  // 配对成功的来访者看另一位咨询师：不解锁
  let r = await f.request('GET', '/rest/v1/counselors?id=eq.' + other, null, { 'x-assessment-token': f.asid });
  assert.equal(r.status, 200); assert.equal(r.body[0].contact_wechat, undefined);

  // 伪造 / 错位的凭证：不解锁
  for (const capability of [randomUUID(), 'not-a-uuid', f.cid]) {
    r = await f.request('GET', f.counselorPath, null, { 'x-assessment-token': capability });
    assert.equal(r.status, 200); assert.equal(r.body[0].contact_wechat, undefined);
  }

  // 已拒绝的匹配同样不解锁
  const rejectedId = randomUUID();
  const rejected = await f.store.portal.createIntake({ id: rejectedId, view_token: rejectedId, client_claim_secret: 'xpg2_' + Buffer.alloc(32, 4).toString('base64url'), visitor_name: '未通过来访者', crisis_level: 'safe' });
  const requested = await f.store.portal.patchIntake(rejected, { match_request_cid: f.cid }, { role: 'visitor', principal: { subject: rejected.visitor_user_id, role: 'visitor', aud: 'xg-assessment', auth_method: 'intake-receipt', demo: false, exp: Date.now() + 60000 } });
  await f.store.portal.patchIntake(requested, { match_request_status: 'rejected' }, { role: 'counselor', principal: { subject: f.cid, role: 'counselor', aud: 'xg-assessment', auth_method: 'counselor-edit', demo: false, exp: Date.now() + 60000 } });
  r = await f.request('GET', f.counselorPath, null, { 'x-assessment-token': rejectedId });
  assert.equal(r.status, 200); assert.equal(r.body[0].contact_wechat, undefined);
});

test('owner still reads full profile and admin sees everything', async t => {
  const f = await setup(t);
  const owner = signSession({ role: 'counselor', subject: f.cid, aud: 'xg-assessment', demo: false, auth_method: 'counselor-edit', exp: Date.now() + 60000 }, secret);
  await f.request('PATCH', f.counselorPath, { contact_wechat: 'wx-synthetic', contact_wechat_public: false }, { authorization: 'Bearer ' + owner });
  const own = await f.request('GET', f.counselorPath, null, { authorization: 'Bearer ' + owner });
  assert.equal(own.status, 200); assert.equal(own.body[0].contact_wechat, 'wx-synthetic');
  const adminRead = await f.request('GET', f.counselorPath, null, { authorization: 'Bearer ' + f.admin });
  assert.equal(adminRead.status, 200); assert.equal(adminRead.body[0].contact_wechat, 'wx-synthetic');
});
