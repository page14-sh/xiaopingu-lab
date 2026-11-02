// Browser smoke test using only synthetic in-memory records and storage.
// Requires Playwright on NODE_PATH and an installed Chromium browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { fixture } = require('./fixtures/v2-portal.cjs');
const base = path.resolve(__dirname, '../cloudrun/xiaopingu-api');
const sharp = require(base + '/node_modules/sharp');
const { createRequestHandler } = require(base + '/app');
const { createCounselorPhotos } = require(base + '/portal/photos');
async function main() {
  const f = await fixture(), objects = new Map(), root = path.resolve(__dirname, '../legacy-web');
  const photos = createCounselorPhotos({ namespace: 'xg_preview_browser_', storage: {
    async uploadFile({ cloudPath, fileContent }) { const fileID = 'cloud://test.bucket/' + cloudPath; objects.set(fileID, fileContent); return { fileID }; },
    async getTempFileURL({ fileList }) { return { fileList: fileList.map(({ fileID }) => ({ fileID, tempFileURL: 'https://private-photo.test/' + encodeURIComponent(fileID) + '?sign=test' })) }; },
    async deleteFile({ fileList }) { fileList.forEach(id => objects.delete(id)); return { fileList: fileList.map(fileID => ({ fileID, code: 'SUCCESS' })) }; }
  } });
  const api = createRequestHandler({ store: f.store, photos, portalEnabled: true, sessionSecret: 'browser-only', adminPassword: 'synthetic-admin-only' });
  let origin;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    if (url.pathname.startsWith('/api/')) { req.url = req.url.slice(4); return api(req, res); }
    const file = path.resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + '/') || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    let body = fs.readFileSync(file);
    if (file.endsWith('supabase-config.js')) body = body.toString().replace(/url: '[^']+'/, `url: '${origin}/api'`);
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', 'Cache-Control': 'no-store' }); res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.XPG_CHROMIUM_PATH ? { executablePath: process.env.XPG_CHROMIUM_PATH } : {}) });
    const context = await browser.newContext();
    await context.route('https://private-photo.test/**', route => {
      const id = decodeURIComponent(new URL(route.request().url()).pathname.slice(1)), bytes = objects.get(id);
      return route.fulfill({ status: bytes ? 200 : 404, contentType: 'image/jpeg', body: bytes || '' });
    });
    // Login through the actual API, then use the normal counselor page controls.
    const login = await context.request.post(origin + '/api/auth/counselor', { data: { credential: 'synthetic-counselor-only' } });
    const auth = await login.json(); assert.equal(login.status(), 200);
    await context.addInitScript(({ token, id }) => {
      localStorage.setItem('xiaopingu_counselor_token', token); localStorage.setItem('xiaopingu_counselor_id', id);
    }, { token: auth.token, id: f.cid });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/counselor.html?panel=1');
    await page.locator('#panel-edit-btn').click();
    await page.waitForFunction(() => document.getElementById('pe_name').value === '合成咨询师');
    await page.locator('#pe_bio_short').fill('仅用于私有照片测试');
    const image = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#778899' } }).jpeg().toBuffer();
    for (const key of ['daily', 'license']) {
      await page.locator('#file_pe_' + key).setInputFiles({ name: 'synthetic.jpg', mimeType: 'image/jpeg', buffer: image });
      await page.locator('#slots_pe_' + key + ' img').waitFor();
    }
    const save = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().includes('/rest/v1/counselors'));
    await page.locator('#pe-save-btn').click(); assert.equal((await save).status(), 200);
    await page.locator('#panel-edit-btn').waitFor({ state: 'visible' });
    await page.locator('#panel-edit-btn').click();
    await page.waitForFunction(() => ['daily', 'license'].every(key => {
      const img = document.querySelector('#slots_pe_' + key + ' img'); return img && img.complete && img.naturalWidth > 0 && img.src.startsWith('https://private-photo.test/');
    }));
    assert.equal(objects.size, 2);
    // Existing file references must round-trip without uploading duplicates.
    const again = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().includes('/rest/v1/counselors'));
    await page.locator('#pe-save-btn').click(); assert.equal((await again).status(), 200); assert.equal(objects.size, 2);
    await page.locator('#panel-edit-btn').waitFor({ state: 'visible' });
    await page.locator('#panel-edit-btn').click();
    await page.route('**/api/rest/v1/counselors*', route => route.request().method() === 'PATCH' ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"synthetic failure"}' }) : route.continue());
    await page.locator('#pe-save-btn').click();
    await page.getByText('保存失败：HTTP 503', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('xiaopingu_counselor_draft')), null);
    await page.close();
    const admin = await context.newPage();
    admin.on('pageerror', error => errors.push(error.message));
    await admin.goto(origin + '/admin.html');
    await admin.locator('#login-password').fill('synthetic-admin-only');
    await admin.locator('#login-password').press('Enter');
    await admin.waitForFunction(() => document.getElementById('main-app').style.display !== 'none');
    // Open the same detail action used by the row buttons; verify both images and lightbox.
    await admin.waitForFunction(() => allData.counselors.length > 0);
    await admin.evaluate(id => viewDetail('counselors', id), f.cid);
    await admin.waitForFunction(() => document.querySelectorAll('.photo-thumb').length === 2 && [...document.querySelectorAll('.photo-thumb')].every(img => img.complete && img.naturalWidth > 0));
    await admin.locator('.photo-thumb').last().click();
    assert.equal(await admin.locator('#modal-photo-img').getAttribute('referrerpolicy'), 'no-referrer');
    await admin.evaluate(() => doLogout());
    assert.equal(await admin.locator('#modal-photo-img').getAttribute('src'), null);
    assert.equal(await admin.locator('#modal-content').textContent(), '');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(JSON.stringify({ counselor_upload: 'passed', private_photo_render: 'passed', reference_roundtrip: 'passed', failed_save: 'visible', browser_photo_draft: 'absent', admin_lightbox: 'passed', page_errors: errors.length }));
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
