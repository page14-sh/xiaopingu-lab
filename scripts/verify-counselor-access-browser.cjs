// Uses only in-memory synthetic records. NODE_PATH may point to a bundled Playwright.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture } = require('./fixtures/v2-portal.cjs');
const { createRequestHandler } = require('../cloudrun/xiaopingu-api/app');
async function main() {
  const f = await fixture(), root = path.resolve(__dirname, '../legacy-web');
  await f.source.transaction(async tx => tx.put('counselors', f.cid, { ...await tx.get('counselors', f.cid), contact_phone: '13800123456',
    contact_wechat: 'synthetic-only', contact_email: 'synthetic@example.invalid', contact_email_public: true, bio_short: '合成介绍' }));
  const api = createRequestHandler({ store: f.store, portalEnabled: true, sessionSecret: 'synthetic-access-browser', adminPassword: 'synthetic-admin-only' });
  let origin;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    if (url.pathname.startsWith('/api/')) { req.url = req.url.slice(4); return api(req, res); }
    const file = path.resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + '/') || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    let body = fs.readFileSync(file);
    if (file.endsWith('supabase-config.js')) body = body.toString().replace(/url: '[^']+'/, `url: '${origin}/api'`);
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', 'cache-control': 'no-store' }); res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.XPG_CHROMIUM_PATH ? { executablePath: process.env.XPG_CHROMIUM_PATH } : {}) });
    const errors = [];
    async function newContext() {
      const c = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
      await c.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
      c.on('page', page => page.on('pageerror', e => errors.push(e.message))); return c;
    }
    const adminContext = await newContext(), admin = await adminContext.newPage();
    await admin.goto(origin + '/admin.html');
    await admin.locator('#login-password').fill('synthetic-admin-only'); await admin.locator('#login-password').press('Enter');
    const shareButton = admin.locator('[data-counselor-id="' + f.cid + '"]');
    await shareButton.waitFor({ state: 'attached' });
    // Switch to the existing counselor table if the dashboard opens another tab.
    if (!await shareButton.isVisible()) await admin.locator('[onclick="switchTab(\'counselors\')"]').click();
    await shareButton.click();
    const dialog = admin.getByRole('dialog', { name: '分享资料填写链接' });
    await dialog.getByRole('button', { name: '生成新链接', exact: true }).click();
    await admin.waitForFunction(() => document.querySelector('dialog input[aria-label="资料填写链接"]').value.includes('#invite='));
    const link = await dialog.getByLabel('资料填写链接').inputValue();
    await dialog.getByRole('button', { name: '复制链接', exact: true }).click();
    assert.equal(await admin.evaluate(() => navigator.clipboard.readText()), link);
    const recipientContext = await newContext(), recipient = await recipientContext.newPage(), requestUrls = [];
    recipient.on('request', req => requestUrls.push(req.url()));
    await recipient.goto(link);
    await recipient.waitForFunction(() => document.getElementById('pe_name').value === '合成咨询师');
    assert.equal(new URL(recipient.url()).hash, '');
    assert.ok(!requestUrls.some(url => url.includes(new URL(link).hash.slice(1))));
    assert.equal(await recipient.locator('#panel-content').isVisible(), false);
    assert.equal(await recipient.evaluate(() => localStorage.getItem('xiaopingu_counselor_token')), null);
    await recipient.locator('#pe_bio_short').fill('通过分享链接补齐资料');
    await recipient.locator('#pe-save-btn').click();
    await recipient.getByText(/档案已保存成功，可以关闭本页/).waitFor();
    assert.equal((await f.source.get('counselors', f.cid)).bio_short, '通过分享链接补齐资料');
    await dialog.getByRole('button', { name: '撤销链接', exact: true }).click();
    await dialog.getByText(/已撤销/).waitFor();
    await recipient.locator('#pe_bio_short').fill('撤销后的修改不应写入'); await recipient.locator('#pe-save-btn').click();
    await recipient.locator('#shared-profile-status').getByText(/已撤销/).waitFor();
    assert.equal((await f.source.get('counselors', f.cid)).bio_short, '通过分享链接补齐资料');
    const phoneContext = await newContext(), phone = await phoneContext.newPage();
    await phone.goto(origin + '/index.html'); await phone.getByRole('button', { name: '咨询师登录', exact: true }).first().click();
    const form = phone.getByRole('form', { name: '手机号登录' });
    await form.locator('[name=phone]').fill('13800123456'); await form.locator('[name=password]').fill('123456');
    await form.getByRole('button', { name: '手机号登录', exact: true }).click();
    assert.equal(await form.locator('[name=new_password]').count(), 0);
    await phone.waitForURL('**/counselor.html?panel=1'); await phone.locator('#panel-edit-btn').waitFor();
    await phone.evaluate(() => localStorage.clear()); await phone.goto(origin + '/counselor.html?panel=1');
    const panelForm = phone.getByRole('form', { name: '手机号登录' });
    await panelForm.locator('[name=phone]').fill('13800123456'); await panelForm.locator('[name=password]').fill('wrong-password');
    await panelForm.getByRole('button', { name: '手机号登录', exact: true }).click(); await panelForm.getByText(/手机号或密码不正确/).waitFor();
    await panelForm.locator('[name=password]').fill('123456'); await panelForm.getByRole('button', { name: '手机号登录', exact: true }).click();
    await phone.locator('#panel-edit-btn').waitFor();
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(JSON.stringify({ share_generate_copy: 'passed', profile_fill_save: 'passed', revoke_open_session: 'passed',
      fragment_removed: true, profile_token_not_persisted: true, phone_direct_login: 'passed', wrong_password_rejected: true, default_password_relogin: 'passed', page_errors: 0 }));
  } finally { if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
