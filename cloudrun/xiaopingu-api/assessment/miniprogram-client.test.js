const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createXgClient } = require('../../../miniprogram/utils/xg-api');
const { verifyAssertion } = require('./authorization');

test('cloud function entry uses the installed SDK public parser and per-call context', async () => {
  const entry = path.resolve(__dirname, '../../../cloudfunctions/xg-identity/index.js');
  const wxContext = { SOURCE: 'wx_client', OPENID: 'real-user', APPID: 'wx-real' };
  const exports = {};
  const bridge = { secret: 'test-bridge-secret-with-32-characters', appId: wxContext.APPID, audience: 'xpg-api:env' };
  const cloud = { DYNAMIC_CURRENT_ENV: Symbol('current'), init: (arg) => assert.equal(arg.env, cloud.DYNAMIC_CURRENT_ENV), getWXContext: () => wxContext };
  vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
    exports,
    process: { env: { XPG_IDENTITY_BRIDGE_SECRET: bridge.secret, XPG_MINIPROGRAM_APPID: bridge.appId, XPG_IDENTITY_AUDIENCE: bridge.audience } },
    require(name) {
      if (name === 'wx-server-sdk') return cloud;
      if (name === '@cloudbase/node-sdk') return require('@cloudbase/node-sdk');
      return require(path.resolve(path.dirname(entry), name));
    }
  });
  const context = { environment: JSON.stringify({ WX_OPENID: 'real-user', WX_APPID: 'wx-real' }) };
  const result = await exports.main({ OPENID: 'forged' }, context);
  assert.equal(verifyAssertion(result.assertion, bridge).openid, 'real-user');
  await assert.rejects(exports.main({}, { environment: '{}' }), /Verified Mini Program/);
});

test('mini program requests use native identity exchange and never the old demo visitor cache', async () => {
  const calls = [];
  let assertions = 0;
  const wx = {
    cloud: {
      init(options) { calls.push({ init: options }); },
      async callFunction(options) { assert.deepEqual(options.data, {}); assertions++; return { result: { assertion: 'signed-native-identity' } }; }
    },
    request(options) {
      calls.push(options);
      options.success({ statusCode: 200, data: options.url.endsWith('/auth/visitor')
        ? { token: 'verified-token', expires_at: Date.now() + 60000, visitor: { id: 'verified-visitor' } }
        : { ok: true } });
    },
    getStorageSync() { throw new Error('Do not read demo identity'); },
    login() { throw new Error('Do not use demo login'); }
  };
  const client = createXgClient(wx, { cloudEnv: 'test-env', apiBase: 'https://api.example' });
  await Promise.all([client.request('/me'), client.request('/me')]);
  assert.equal(assertions, 1);
  assert.deepEqual(calls[0].init, { env: 'test-env', traceUser: true });
  assert.deepEqual(calls.find((item) => item.url?.endsWith('/auth/visitor')).data, { assertion: 'signed-native-identity' });
  assert.equal(calls.find((item) => item.url?.endsWith('/v1/xg/me')).header.Authorization, 'Bearer verified-token');
});

test('native login failure never falls back to demo and can retry after configuration recovery', async () => {
  let failing = true;
  let sends = 0;
  const wx = {
    cloud: { init() {}, async callFunction() { if (failing) throw new Error('Function unavailable'); return { result: { assertion: 'real' } }; } },
    request(options) { sends++; options.success({ statusCode: 200, data: { token: 'ok', visitor: { id: 'v' }, expires_at: Date.now() + 60000 } }); }
  };
  const client = createXgClient(wx, { cloudEnv: 'test', apiBase: 'https://api.example' });
  await assert.rejects(client.ensureSession(), /Function unavailable/);
  assert.equal(sends, 0);
  failing = false;
  assert.equal((await client.ensureSession()).visitor.id, 'v');
});

test('expired or rejected mini program sessions are not reused', async () => {
  let time = 1000;
  let assertions = 0;
  const wx = {
    cloud: { init() {}, async callFunction() { assertions++; return { result: { assertion: 'real' } }; } },
    request(options) {
      if (options.url.endsWith('/auth/visitor')) options.success({ statusCode: 200, data: { token: 'ok', visitor: { id: 'v' }, expires_at: time + 20000 } });
      else options.success({ statusCode: 401, data: { error: { message: 'Expired' } } });
    }
  };
  const client = createXgClient(wx, { cloudEnv: 'test', apiBase: 'https://api.example' }, () => time);
  await client.ensureSession();
  time += 20000;
  await client.ensureSession();
  assert.equal(assertions, 2);
  await assert.rejects(client.request('/me'), /Expired/);
  await client.ensureSession();
  assert.equal(assertions, 3);
});

test('T17 subscription prompt is synchronous with the user action and does not claim consent or quota', async () => {
  const { createXgClient } = require('../../../miniprogram/utils/xg-api');
  let called = false;
  const client = createXgClient({ requestSubscribeMessage(options) { called = true; assert.deepEqual(options.tmplIds, ['template-test']); options.success({ 'template-test': 'accept', private: 'ignored' }); } }, {});
  const promise = client.requestSubscription('template-test'); assert.equal(called, true);
  assert.deepEqual(await promise, { accepted: true });
  await assert.rejects(client.requestSubscription(''), /尚未配置/);
});
