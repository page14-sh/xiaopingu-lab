// Synthetic-only storage smoke test; no production database reads or writes.
// node scripts/verify-private-photos.cjs --run-cloud
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const base = path.resolve(__dirname, '../cloudrun/xiaopingu-api');
const sharp = require(base + '/node_modules/sharp');
const sdk = require(base + '/node_modules/@cloudbase/node-sdk');
const { createCounselorPhotos } = require(base + '/portal/photos');

async function main() {
  assert.ok(process.argv.includes('--run-cloud'), 'Use --run-cloud to upload/delete synthetic test files');
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../.env.v2-runtime.json'), 'utf8'));
  assert.equal(config.TCB_ENV, 'xpg-demo-d3gzsswtcc3233ea0');
  const app = sdk.init({ env: config.TCB_ENV, accessKey: config.CLOUDBASE_APIKEY });
  const created = [];
  const storage = {
    async uploadFile(input) { const r = await app.uploadFile(input); if (r.fileID) created.push(r.fileID); return r; },
    deleteFile: input => app.deleteFile(input), getTempFileURL: input => app.getTempFileURL(input)
  };
  const photos = createCounselorPhotos({ storage, namespace: 'xg_preview_photosmoke_' });
  const bytes = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#779988' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const image = 'data:image/jpeg;base64,' + bytes.toString('base64');
  let saved = null;
  try {
    const id = randomUUID();
    await photos.save(id, { id, photo_daily: [image], photo_license: [image] }, null, async row => { saved = row; }, async () => saved);
    const [view] = await photos.present([saved]);
    const url = new URL(view.photo_license[0].url);
    assert.ok(url.search.length > 1, 'Private access must use a signed URL');
    const signed = await fetch(url, { signal: AbortSignal.timeout(20000) });
    assert.equal(signed.status, 200);
    const meta = await sharp(Buffer.from(await signed.arrayBuffer())).metadata();
    assert.equal(meta.exif, undefined); assert.equal(meta.icc, undefined);
    url.search = '';
    const unsigned = await fetch(url, { signal: AbortSignal.timeout(20000) });
    assert.ok([401, 403].includes(unsigned.status), 'Unsigned access must be denied');
    console.log(JSON.stringify({ environment: config.TCB_ENV, synthetic_only: true, upload: 'passed', signed_read: 'passed', unsigned_read: 'denied', metadata_removed: true }));
  } finally {
    if (created.length) {
      const result = await app.deleteFile({ fileList: created });
      assert.ok(!result.code || result.code === 'SUCCESS');
      assert.equal(result.fileList.length, created.length);
      assert.ok(result.fileList.every(x => !x.code || x.code === 'SUCCESS'));
      console.log(JSON.stringify({ cleanup: 'passed', synthetic_files_deleted: created.length }));
    }
  }
}
main().catch(error => { console.error(JSON.stringify({ check: 'failed', code: error.code || 'PHOTO_SMOKE_FAILED' })); process.exitCode = 1; });
