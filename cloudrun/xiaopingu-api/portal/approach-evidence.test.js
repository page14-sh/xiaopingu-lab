const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { createCounselorPhotos, LINK_TTL } = require('./photos');
const { createRequestHandler, signSession } = require('../app');
const { fixture } = require('../../../scripts/fixtures/v2-portal.cjs');

const namespace = 'xg_preview_evidtest_';
const secret = 'synthetic-evidence-tests-only';
async function picture() {
  const bytes = await sharp({ create: { width: 32, height: 20, channels: 3, background: '#123456' } }).jpeg().toBuffer();
  return 'data:image/jpeg;base64,' + bytes.toString('base64');
}
function fakeStorage() {
  const objects = new Map(), signed = [], removed = [];
  return { objects, signed, removed,
    async uploadFile({ cloudPath, fileContent }) {
      const fileID = 'cloud://synthetic.bucket/' + cloudPath;
      objects.set(fileID, fileContent); return { fileID };
    },
    async deleteFile({ fileList }) {
      fileList.forEach(id => { objects.delete(id); removed.push(id); });
      return { fileList: fileList.map(fileID => ({ fileID, code: 'SUCCESS' })) };
    },
    async getTempFileURL({ fileList }) {
      signed.push(...fileList);
      return { fileList: fileList.map(({ fileID }) => ({ fileID, code: 'SUCCESS', tempFileURL: 'https://private.example/' + encodeURIComponent(fileID) + '?sign=synthetic' })) };
    }
  };
}
async function setup(t) {
  const f = await fixture(), storage = fakeStorage();
  const photos = createCounselorPhotos({ storage, namespace });
  const server = http.createServer(createRequestHandler({ store: f.store, photos, portalEnabled: true, sessionSecret: secret }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const token = (role, subject, overrides = {}) => signSession({ role, subject, aud: 'xg-assessment', demo: false,
    auth_method: role === 'admin' ? 'admin-password' : role === 'counselor' ? 'counselor-edit' : 'intake-receipt', exp: Date.now() + 60000, ...overrides }, secret);
  async function request(method, path, body, auth) {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer ' + auth } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    let parsed = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, body: parsed };
  }
  return { ...f, storage, photos, token, request, admin: token('admin', 'admin'),
    pathOf: id => '/rest/v1/counselors?id=eq.' + id, ownerOf: id => token('counselor', id) };
}
async function register(f, body) {
  const r = await f.request('POST', '/rest/v1/counselors', body);
  return r;
}
async function approveProfile(f, id) {
  await f.request('PATCH', f.pathOf(id), { review_status: 'approved', is_active: true }, f.admin);
}

test('注册勾选流派须传受训证明：pending 不计入 approaches_verified；匿名只见认证集合不见证明', async t => {
  const f = await setup(t), image = await picture(), id = randomUUID();
  const reg = await register(f, { id, name: '流派证据注册', approaches: ['EMDR', 'CBT'],
    approach_evidence: [{ approach: 'EMDR', photo: image }, { approach: 'CBT', photo: image }] });
  assert.equal(reg.status, 201);
  const saved = await f.source.get('counselors', id);
  assert.equal(saved.approach_evidence.length, 2);
  assert.ok(saved.approach_evidence.every(e => e.status === 'pending' && /photo_training/.test(e.photo_ref)));
  assert.equal(saved.approach_evidence.some(e => e.reviewed_by), false);
  await approveProfile(f, id);
  for (const auth of [undefined, f.ownerOf(id), f.admin]) {
    f.storage.signed.length = 0;
    const r = await f.request('GET', f.pathOf(id) + '&select=*', null, auth);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body[0].approaches_verified, []);
    if (auth === undefined) {
      assert.equal(r.body[0].approach_evidence, undefined);
      assert.ok(f.storage.signed.every(x => !x.fileID.includes('photo_training')));
    } else if (auth === f.ownerOf(id)) {
      assert.equal(r.body[0].approach_evidence.length, 2);
      assert.ok(f.storage.signed.some(x => x.fileID.includes('photo_training')));
    } else {
      assert.match(r.body[0].approach_evidence[0].photo.url, /^https:/);
      assert.equal(r.body[0].approach_evidence[0].photo_ref, saved.approach_evidence[0].photo_ref);
    }
  }
  assert.ok(f.storage.signed.every(x => x.maxAge === LINK_TTL));
});

test('管理员审核通过进入 approaches_verified；本人无法自审；重新上传回到 pending', async t => {
  const f = await setup(t), image = await picture(), id = randomUUID();
  await register(f, { id, name: '审核流转', approaches: ['EMDR', 'CBT'],
    approach_evidence: [{ approach: 'EMDR', photo: image }, { approach: 'CBT', photo: image }] });
  const owner = f.ownerOf(id), ref = (await f.source.get('counselors', id)).approach_evidence[0].photo_ref;
  // 本人试图自审：强制回 pending
  const selfReview = await f.request('PATCH', f.pathOf(id), { approach_evidence: [{ approach: 'EMDR', status: 'verified', photo_ref: ref }] }, owner);
  assert.equal(selfReview.status, 200);
  assert.equal((await f.source.get('counselors', id)).approach_evidence[0].status, 'pending');
  // 管理员审核通过 EMDR，CBT 不提交条目则保持无证据
  const reviewed = await f.request('PATCH', f.pathOf(id), { approach_evidence: [{ approach: 'EMDR', status: 'verified', photo_ref: ref, note: '证书核验通过' }] }, f.admin);
  assert.equal(reviewed.status, 200);
  let row = await f.source.get('counselors', id);
  assert.equal(row.approach_evidence.length, 2);
  const emdr = row.approach_evidence.find(e => e.approach === 'EMDR');
  assert.equal(emdr.status, 'verified');
  assert.equal(emdr.reviewed_by, 'admin');
  assert.ok(emdr.reviewed_at);
  assert.equal(emdr.note, '证书核验通过');
  assert.equal(row.approach_evidence.find(e => e.approach === 'CBT').status, 'pending');
  await approveProfile(f, id);
  assert.deepEqual((await f.request('GET', f.pathOf(id) + '&select=*', null, f.admin)).body[0].approaches_verified, ['EMDR']);
  // 重新上传新证明 → 回到 pending，旧文件清理、新文件入库
  const before = f.storage.objects.size;
  const reupload = await f.request('PATCH', f.pathOf(id), { approach_evidence: [{ approach: 'EMDR', photo: await picture() }] }, owner);
  assert.equal(reupload.status, 200);
  row = await f.source.get('counselors', id);
  assert.equal(row.approach_evidence[0].status, 'pending');
  assert.notEqual(row.approach_evidence[0].photo_ref, ref);
  assert.equal(f.storage.objects.size, before);
  assert.equal(f.storage.objects.has(ref), false);
  assert.deepEqual((await f.request('GET', f.pathOf(id) + '&select=*', null, f.admin)).body[0].approaches_verified, []);
});

test('引用不可伪造：跨流派冒用、跨人冒用、重复条目一律拒绝', async t => {
  const f = await setup(t), image = await picture(), id = randomUUID(), other = randomUUID();
  await register(f, { id, name: '防伪', approaches: ['EMDR', 'CBT'], approach_evidence: [{ approach: 'EMDR', photo: image }] });
  await register(f, { id: other, name: '另一位', approaches: ['CBT'], approach_evidence: [{ approach: 'CBT', photo: image }] });
  const row = await f.source.get('counselors', id), otherRow = await f.source.get('counselors', other);
  const emdrRef = row.approach_evidence[0].photo_ref, otherRef = otherRow.approach_evidence[0].photo_ref;
  // CBT 无历史证据，冒用本人 EMDR 的证明文件 → 拒绝
  assert.equal((await f.request('PATCH', f.pathOf(id), { approach_evidence: [{ approach: 'CBT', photo_ref: emdrRef }] }, f.ownerOf(id))).status, 400);
  // 冒用他人证明 → 拒绝
  assert.equal((await f.request('PATCH', f.pathOf(id), { approach_evidence: [{ approach: 'CBT', photo: image }, { approach: 'EMDR', photo_ref: otherRef }] }, f.ownerOf(id))).status, 400);
  // 同一流派重复条目 → 拒绝
  assert.equal((await f.request('PATCH', f.pathOf(id), { approach_evidence: [{ approach: 'CBT', photo: image }, { approach: 'CBT', photo: image }] }, f.ownerOf(id))).status, 400);
  // 新流派不传证明直接提交条目（无 photo）→ 拒绝
  assert.equal((await f.request('PATCH', f.pathOf(id), { approach_evidence: [{ approach: 'CBT' }] }, f.ownerOf(id))).status, 400);
  // 正常补齐 CBT → 成功
  assert.equal((await f.request('PATCH', f.pathOf(id), { approach_evidence: [{ approach: 'CBT', photo: image }] }, f.ownerOf(id))).status, 200);
  assert.equal((await f.source.get('counselors', id)).approach_evidence.length, 2);
});

test('移除流派时旧证据与文件一并清理；is_demo 演示数据全部声明流派视为已认证', async t => {
  const f = await setup(t), image = await picture(), id = randomUUID(), demoId = randomUUID();
  await register(f, { id, name: '裁剪', approaches: ['EMDR', 'CBT'], approach_evidence: [{ approach: 'EMDR', photo: image }, { approach: 'CBT', photo: image }] });
  const ref = (await f.source.get('counselors', id)).approach_evidence[0].photo_ref;
  const pruned = await f.request('PATCH', f.pathOf(id), { approaches: ['CBT'] }, f.ownerOf(id));
  assert.equal(pruned.status, 200);
  const row = await f.source.get('counselors', id);
  assert.deepEqual(row.approach_evidence.map(e => e.approach), ['CBT']);
  assert.equal(f.storage.objects.has(ref), false);
  await f.source.transaction(async tx => {
    await tx.put('counselors', demoId, { id: demoId, name: '演示合成', approaches: ['EMDR', 'CBT'], is_demo: true, is_active: true, review_status: 'approved', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  });
  const demo = await f.request('GET', f.pathOf(demoId) + '&select=*', null, f.admin);
  assert.equal(demo.status, 200);
  assert.deepEqual(demo.body[0].approaches_verified, ['EMDR', 'CBT']);
  assert.equal(demo.body[0].approach_evidence, undefined);
});

test('未认证流派不贡献匹配分：认证集合是唯一入口，声明与认证可以不同', async t => {
  const f = await setup(t), image = await picture(), id = randomUUID();
  await register(f, { id, name: '集合语义', approaches: ['EMDR', 'CBT', 'EFT'], approach_evidence: [{ approach: 'EMDR', photo: image }] });
  await approveProfile(f, id);
  await f.request('PATCH', f.pathOf(id), { approach_evidence: [{ approach: 'EMDR', status: 'verified', photo_ref: (await f.source.get('counselors', id)).approach_evidence[0].photo_ref }] }, f.admin);
  const r = await f.request('GET', f.pathOf(id) + '&select=*', null, undefined);
  assert.deepEqual(r.body[0].approaches, ['EMDR', 'CBT', 'EFT']);
  assert.deepEqual(r.body[0].approaches_verified, ['EMDR']);
});
