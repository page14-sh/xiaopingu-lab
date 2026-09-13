const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createRequestHandler } = require('./app');
const { createStaticHandler } = require('./static');

function memoryStore(initial = {}) {
  const data = Object.fromEntries(['assessments', 'counselors', 'sessions', 'pcoms_ratings', 'visitor_users']
    .map((name) => [name, (initial[name] || []).map((row, index) => ({ _id: row._id || `${name}-${index}`, ...row }))]));
  return {
    async list(table) { return data[table].map((row) => ({ ...row })); },
    async insert(table, row) { data[table].push({ _id: `${table}-${data[table].length}`, ...row }); },
    async update(table, id, patch) { Object.assign(data[table].find((row) => row._id === id), patch); },
    async remove(table, id) { data[table] = data[table].filter((row) => row._id !== id); }
  };
}

async function withServer(store, run, options = {}) {
  const server = http.createServer(createRequestHandler({
    store,
    adminPassword: 'correct-horse-battery-staple',
    demoCounselorPassword: 'xiaopingu2026',
    sessionSecret: 'test-session-secret-with-enough-entropy',
    demoMode: true,
    ...options
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('health endpoint is fixed and does not echo runtime data', async () => {
  await withServer(memoryStore(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, { headers: { 'x-cloudbase-context': 'do-not-echo' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, mode: 'cloudbase-nosql' });
  });
});

test('public counselor listing hides private data', async () => {
  const store = memoryStore({ counselors: [{
    id: 'c1', name: 'Approved', is_active: true, review_status: 'approved',
    edit_token: 'secret', contact_phone: '13800000000', contact_phone_public: false
  }] });
  await withServer(store, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/rest/v1/counselors?select=*`);
    const [counselor] = await response.json();
    assert.equal(response.status, 200);
    assert.equal(counselor.name, 'Approved');
    assert.equal(counselor.edit_token, undefined);
    assert.equal(counselor.contact_phone, undefined);
  });
});

test('admin token protects broad assessment reads', async () => {
  const store = memoryStore({ assessments: [{ id: 'a1', view_token: 'a1', visitor_name: 'Demo' }] });
  await withServer(store, async (baseUrl) => {
    const denied = await fetch(`${baseUrl}/rest/v1/assessments?select=*`);
    assert.equal(denied.status, 403);

    const login = await fetch(`${baseUrl}/auth/admin`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'correct-horse-battery-staple' })
    });
    const { token } = await login.json();
    const allowed = await fetch(`${baseUrl}/rest/v1/assessments?select=*`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).length, 1);
  });
});

test('admin and demo passwords cannot be interchanged', async () => {
  const store = memoryStore({ counselors: [
    { id: '00000000-0000-4000-8000-000000000001', edit_token: 'edit-demo-1' },
    { id: '00000000-0000-4000-8000-000000000002', edit_token: 'edit-demo-2' }
  ] });
  await withServer(store, async (baseUrl) => {
    const login = (route, body) => fetch(`${baseUrl}/auth/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    for (const [credential, id] of [
      ['counselor', '00000000-0000-4000-8000-000000000001'],
      ['counselor2', '00000000-0000-4000-8000-000000000002']
    ]) {
      const allowed = await login('counselor', { credential, password: 'xiaopingu2026' });
      assert.equal(allowed.status, 200);
      const session = await allowed.json();
      assert.equal(session.counselor.id, id);
      assert.equal((await login('counselor', { credential, password: 'correct-horse-battery-staple' })).status, 401);
      const adminData = await fetch(`${baseUrl}/rest/v1/assessments?select=*`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${session.token}` }
      });
      assert.equal(adminData.status, 403);
    }
    assert.equal((await login('admin', { password: 'xiaopingu2026' })).status, 401);
    assert.equal((await login('admin', { password: 'correct-horse-battery-staple' })).status, 200);
  });
});

test('missing demo password or disabled demo mode fails closed while edit codes still work', async () => {
  for (const options of [{ demoCounselorPassword: undefined }, { demoCounselorPassword: '' }, { demoMode: false }]) {
    await withServer(memoryStore({ counselors: [
      { id: '00000000-0000-4000-8000-000000000001', edit_token: 'edit-demo-1' }
    ] }), async (baseUrl) => {
      for (const password of ['', 'xiaopingu2026', 'correct-horse-battery-staple']) {
        const denied = await fetch(`${baseUrl}/auth/counselor`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ credential: 'counselor', password })
        });
        assert.equal(denied.status, 401);
      }
      const allowed = await fetch(`${baseUrl}/auth/counselor`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credential: 'edit-demo-1' })
      });
      assert.equal(allowed.status, 200);
    }, options);
  }
});

test('assessment id acts as an unguessable view capability', async () => {
  const store = memoryStore({ assessments: [{ id: 'capability-id', view_token: 'capability-id', visitor_name: 'Demo' }] });
  await withServer(store, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/rest/v1/assessments?id=eq.capability-id&select=*`);
    assert.equal(response.status, 200);
    assert.equal((await response.json())[0].visitor_name, 'Demo');
  });
});

test('write payloads cannot persist prototype or operator keys', async () => {
  const store = memoryStore();
  await withServer(store, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/rest/v1/assessments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"id":"safe-id","$where":"unsafe","nested":{"constructor":"unsafe","ok":true}}'
    });
    const [created] = await response.json();
    assert.equal(response.status, 201);
    assert.equal(created.$where, undefined);
    assert.deepEqual(created.nested, { ok: true });
  });
});

test('counselor token cannot mutate another counselor session', async () => {
  const store = memoryStore({
    counselors: [{ id: 'c1', edit_token: 'edit-c1', is_active: true, review_status: 'approved' }],
    assessments: [
      { id: 'a1', view_token: 'a1', selected_counselor_id: 'c1' },
      { id: 'a2', view_token: 'a2', selected_counselor_id: 'c2' }
    ],
    sessions: [{ id: 's2', assessment_id: 'a2', session_number: 1 }]
  });
  await withServer(store, async (baseUrl) => {
    const login = await fetch(`${baseUrl}/auth/counselor`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential: 'edit-c1' })
    });
    const { token } = await login.json();
    const response = await fetch(`${baseUrl}/rest/v1/sessions?id=eq.s2`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ session_number: 99 })
    });
    assert.equal(response.status, 403);
  });
});

test('combined CloudRun handler serves the homepage and integrated admin route', async () => {
  const publicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaopingu-static-'));
  fs.writeFileSync(path.join(publicRoot, 'index.html'), '<!doctype html><title>home</title>');
  const apiHandler = createRequestHandler({
    store: memoryStore(),
    adminPassword: 'correct-horse-battery-staple',
    sessionSecret: 'test-session-secret-with-enough-entropy',
    demoMode: true
  });
  const server = http.createServer(createStaticHandler(publicRoot, apiHandler));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const home = await fetch(`${baseUrl}/`);
    const admin = await fetch(`${baseUrl}/admin`);
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /<title>home<\/title>/);
    assert.equal(admin.status, 200);
    assert.match(await admin.text(), /<title>home<\/title>/);
    assert.deepEqual(await health.json(), { ok: true, mode: 'cloudbase-nosql' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(publicRoot, { recursive: true, force: true });
  }
});
