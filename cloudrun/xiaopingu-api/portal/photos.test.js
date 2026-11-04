const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { createCounselorPhotos, normalizePhoto, LINK_TTL } = require('./photos');
const { createRequestHandler, signSession } = require('../app');
const { fixture } = require('../../../scripts/fixtures/v2-portal.cjs');

const namespace = 'xg_preview_phototest_';
const secret = 'synthetic-photo-tests-only';
async function picture() {
  const bytes = await sharp({ create: { width: 32, height: 20, channels: 3, background: '#345678' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
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
    return { status: res.status, body: await res.json(), headers: res.headers };
  }
  return { ...f, storage, photos, token, request, path: '/rest/v1/counselors?id=eq.' + f.cid, owner: token('counselor', f.cid), admin: token('admin', 'admin') };
}

test('server decodes raster content and strips metadata; rejects disguised files, SVG and oversized input', async () => {
  const source = await picture();
  assert.ok((await sharp(Buffer.from(source.split(',')[1], 'base64')).metadata()).exif);
  const meta = await sharp(await normalizePhoto(source)).metadata();
  assert.equal(meta.exif, undefined); assert.equal(meta.icc, undefined); assert.equal(meta.orientation, undefined);
  for (const value of ['data:image/jpeg;base64,' + Buffer.from('<svg/>').toString('base64'), 'data:image/svg+xml;base64,PHN2Zy8+', 'https://example.com/file.jpg', source + 'A'.repeat(260000)]) {
    await assert.rejects(normalizePhoto(value), { code: 'XPG_INVALID_PHOTO' });
  }
});

test('registration uploads privately and returns no signed certificate; failed upload never creates a profile', async t => {
  const f = await setup(t), image = await picture(), id = randomUUID();
  const r = await f.request('POST', '/rest/v1/counselors', { id, name: '合成资料', photo_daily: [image], photo_license: [image], photo_diploma: [image], photo_ethics: [image] });
  assert.equal(r.status, 201); assert.ok(r.body[0].edit_token); assert.equal(r.body[0].photo_license, undefined); assert.equal(r.body[0].photo_diploma, undefined); assert.equal(r.body[0].photo_ethics, undefined);
  const saved = await f.source.get('counselors', id);
  assert.match(saved.photo_daily[0], /^cloud:\/\//); assert.match(saved.photo_license[0], /photo_license/); assert.match(saved.photo_diploma[0], /photo_diploma/); assert.match(saved.photo_ethics[0], /photo_ethics/);
  assert.equal(saved.review_status, 'pending'); assert.equal(f.storage.signed.length, 0);
  f.storage.uploadFile = async () => { throw new Error('secret provider error'); };
  const next = randomUUID(), failed = await f.request('POST', '/rest/v1/counselors', { id: next, photo_daily: [image] });
  assert.equal(failed.status, 503); assert.equal(await f.source.get('counselors', next), null);
  assert.doesNotMatch(JSON.stringify(failed.body), /secret provider/);
});

test('only owner/admin receive certificate URLs; anonymous and visitor never cause certificate signing', async t => {
  const f = await setup(t), image = await picture();
  assert.equal((await f.request('PATCH', f.path, { photo_daily: [image], photo_license: [image], photo_diploma: [image], photo_ethics: [image] }, f.owner)).status, 200);
  for (const auth of [undefined, f.token('visitor', 'someone'), f.token('counselor', randomUUID())]) {
    f.storage.signed.length = 0;
    const r = await f.request('GET', f.path, null, auth);
    if (r.status === 200) { assert.equal(r.body[0].photo_license, undefined); assert.equal(r.body[0].photo_diploma, undefined); assert.equal(r.body[0].photo_ethics, undefined); }
    else assert.equal(r.status, 403);
    assert.ok(f.storage.signed.every(x => !x.fileID.includes('photo_license') && !x.fileID.includes('photo_diploma') && !x.fileID.includes('photo_ethics')));
  }
  for (const auth of [f.owner, f.admin]) {
    const r = await f.request('GET', f.path, null, auth);
    assert.equal(r.status, 200); assert.match(r.body[0].photo_license[0].url, /^https:/); assert.match(r.body[0].photo_diploma[0].url, /^https:/); assert.match(r.body[0].photo_ethics[0].url, /^https:/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  assert.ok(f.storage.signed.every(x => x.maxAge === LINK_TTL));
  const denied = await f.request('PATCH', f.path, { photo_daily: [] }); assert.equal(denied.status, 403);
  assert.equal((await f.request('GET', f.path, null, f.token('admin', 'admin', { demo: true }))).status, 403);
  assert.equal((await f.request('GET', f.path, null, f.token('admin', 'admin', { exp: 1 }))).body[0].photo_license, undefined);
});

test('references cannot be forged, moved across owners/namespaces or promoted from certificate to public photo', async t => {
  const f = await setup(t), image = await picture();
  const created = await f.request('PATCH', f.path, { photo_daily: [image], photo_license: [image], photo_ethics: [image] }, f.owner);
  const ref = created.body[0].photo_license[0];
  for (const value of [ref, { file_id: ref.file_id.replace(f.cid, randomUUID()) }, { file_id: ref.file_id.replace(namespace, 'xg_v2_other_') }, { file_id: 'cloud://evil/anything' }, 'https://private.example/reuse']) {
    const r = await f.request('PATCH', f.path, { photo_daily: [value] }, f.owner);
    assert.equal(r.status, 400);
  }
  const ethicsRef = created.body[0].photo_ethics[0];
  assert.equal((await f.request('PATCH', f.path, { photo_daily: [{ file_id: ethicsRef.file_id }] }, f.owner)).status, 400);
  assert.equal((await f.request('PATCH', f.path, { photo_daily: [image, image, image] }, f.owner)).status, 400);
  const r = await f.request('PATCH', f.path, { photo_license: [{ file_id: ref.file_id, url: 'https://evil/ignored' }] }, f.owner);
  assert.equal(r.status, 200); assert.doesNotMatch(r.body[0].photo_license[0].url, /evil/);
  assert.equal(f.storage.objects.size, 3);
});

test('legacy photos migrate on save; removing/replacing deletes old objects; failed persistence rolls back new uploads', async t => {
  const f = await setup(t), image = await picture();
  await f.source.transaction(async tx => { const row = await tx.get('counselors', f.cid); await tx.put('counselors', f.cid, { ...row, photo_daily: [image], photo_license: [image] }); });
  assert.equal((await f.request('GET', f.path, null, f.owner)).body[0].photo_license[0], image);
  const initial = await f.request('PATCH', f.path, { photo_daily: [image], photo_license: [image] }, f.owner);
  assert.equal(initial.status, 200); assert.equal(f.storage.objects.size, 2);
  assert.equal((await f.request('PATCH', f.path, { photo_license: [] }, f.owner)).status, 200);
  assert.equal(f.storage.objects.size, 1); assert.match(f.storage.removed[0], /photo_license/);
  f.store.portal.patchCounselor = async () => { throw Object.assign(new Error('db unavailable'), { statusCode: 503 }); };
  const failed = await f.request('PATCH', f.path, { photo_daily: [image] }, f.owner);
  assert.equal(failed.status, 503); assert.equal(f.storage.objects.size, 1);
  assert.equal((await f.source.get('counselors', f.cid)).photo_daily[0], initial.body[0].photo_daily[0].file_id);
});

test('stale photo snapshots cannot revive removed files; ambiguous committed writes retain their objects', async t => {
  const f = await setup(t), image = await picture(), old = await f.source.get('counselors', f.cid);
  await f.request('PATCH', f.path, { photo_daily: [image] }, f.owner);
  await assert.rejects(f.store.portal.patchCounselor(old, { photo_daily: [] }), { code: 'XPG_PHOTO_CONFLICT' });
  const persist = f.store.portal.patchCounselor;
  f.store.portal.patchCounselor = async (...args) => { await persist(...args); throw new Error('lost ack'); };
  await f.request('PATCH', f.path, { photo_license: [image] }, f.owner);
  const saved = await f.source.get('counselors', f.cid);
  assert.ok(f.storage.objects.has(saved.photo_license[0]));
});
