// Explicit preview-only smoke test. All credentials remain in process memory.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const root = path.resolve(__dirname, '..'), sdk = require(root + '/cloudrun/xiaopingu-api/node_modules/@cloudbase/node-sdk');
const { COLLECTIONS: C } = require(root + '/cloudrun/xiaopingu-api/assessment/model');
async function main() {
  assert.ok(process.argv.includes('--preview'), 'Use --preview to explicitly allow a synthetic account test');
  const config = JSON.parse(fs.readFileSync(root + '/.env.preview-runtime.json', 'utf8'));
  const spec = JSON.parse(fs.readFileSync(root + '/specs/test-chain/config.json', 'utf8'));
  assert.equal(config.TCB_ENV, 'xpg-demo-d3gzsswtcc3233ea0'); assert.equal(config.TCB_ENV, spec.env);
  assert.equal(config.XPG_PREVIEW_MODE, '1'); assert.equal(config.XPG_COLLECTION_PREFIX, spec.prefix); assert.equal(spec.synthetic_only, true);
  const db = sdk.init({ env: spec.env, accessKey: config.CLOUDBASE_APIKEY }).database();
  const physical = name => spec.prefix + name.replace(/^xg_/, '');
  const id = randomUUID(), phone = '1990000' + randomInt(1000, 10000);
  const collision = await db.collection(physical('counselors')).where({ contact_phone: phone }).limit(1).get();
  assert.ok(!collision.code && collision.data.length === 0, 'Synthetic phone collision: rerun with another value');
  let attempted = false, step = 'start';
  async function request(route, body, token, method = body ? 'POST' : 'GET') {
    const r = await fetch(spec.api_url + route, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(65000) });
    return { status: r.status, body: await r.json() };
  }
  try {
    step = 'admin-login'; const admin = await request('/auth/admin', { password: config.XPG_ADMIN_PASSWORD }); assert.equal(admin.status, 200);
    step = 'create-synthetic'; attempted = true;
    const created = await request('/rest/v1/counselors', { id, name: '合成账号验收', contact_phone: phone, bio_short: 'synthetic access check', is_active: true, review_status: 'approved' }, admin.body.token);
    assert.equal(created.status, 201);
    step = 'default-password'; const initial = await request('/auth/counselor/phone', { phone, password: phone.slice(-6) });
    assert.equal(initial.status, 200); assert.ok(initial.body.token); assert.equal(initial.body.setup_token, undefined);
    assert.equal(initial.body.must_change_password, false);
    step = 'workspace'; assert.equal((await request('/v1/xg/me', null, initial.body.token)).status, 200);
    assert.equal((await request('/auth/counselor/phone', { phone, password: 'wrong-password' })).status, 401);
    assert.equal((await request('/auth/counselor/phone', { phone, password: phone.slice(-6) })).status, 200);
    step = 'issue-share'; const issued = await request('/v1/xg/portal/counselor-access', { action: 'issue', counselor_id: id }, admin.body.token); assert.equal(issued.status, 200);
    const invite = await request('/auth/counselor/invite', { invite: issued.body.invite }); assert.equal(invite.status, 200);
    step = 'profile-read'; const profile = await request('/v1/xg/portal/shared-profile', null, invite.body.token); assert.equal(profile.status, 200);
    assert.equal(profile.body[0].id, id); assert.equal(profile.body[0].edit_token, undefined); assert.equal(profile.body[0].login_code, undefined);
    step = 'profile-save'; assert.equal((await request('/v1/xg/portal/shared-profile', { bio_short: '合成资料保存成功' }, invite.body.token, 'PATCH')).status, 200);
    assert.equal((await request('/rest/v1/assessments', null, invite.body.token)).status, 403);
    step = 'revoke-share'; assert.equal((await request('/v1/xg/portal/counselor-access', { action: 'revoke', counselor_id: id }, admin.body.token)).status, 200);
    assert.equal((await request('/v1/xg/portal/shared-profile', null, invite.body.token)).status, 401);
    step = 'reset-phone'; assert.equal((await request('/v1/xg/portal/counselor-access', { action: 'reset_phone', counselor_id: id }, admin.body.token)).status, 200);
    assert.equal((await request('/v1/xg/me', null, initial.body.token)).status, 401);
    console.log(JSON.stringify({ service: spec.service, phone_direct_login: 'passed', incorrect_password_rejected: true, default_relogin: 'passed',
      share_read_save: 'passed', credential_redaction: 'passed', scope_isolation: 'passed', revocation: 'passed', phone_reset: 'passed' }));
  } catch (error) { throw Object.assign(new Error('Live synthetic access check failed'), { code: error.code || 'CHECK_FAILED', step }); }
  finally {
    if (attempted) {
      for (const name of [C.counselorInvites, C.counselorAccounts, 'counselors']) {
        const result = await db.collection(physical(name)).doc(id).remove(); assert.ok(!result.code);
        const check = await db.collection(physical(name)).doc(id).get(); assert.ok(!check.code && Array.isArray(check.data) && check.data.length === 0);
      }
      console.log(JSON.stringify({ synthetic_cleanup: 'passed', production_records_touched: false }));
    }
  }
}
main().catch(error => { console.error(JSON.stringify({ check: 'failed', step: error.step, code: error.code || 'CLEANUP_FAILED' })); process.exitCode = 1; });
