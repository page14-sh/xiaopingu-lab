const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'local-data.json');
const DEV_OPENID = process.env.DEV_OPENID || 'dev-openid-xiaopingu';
const LOCAL_COUNSELOR_ID = '00000000-0000-4000-8000-000000000001';

const localCounselor = {
  id: LOCAL_COUNSELOR_ID,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  name: '本地演示咨询师',
  credential_level: '二级',
  years_experience: 8,
  education: '硕士',
  city: '上海',
  approaches: ['CBT', 'ACT'],
  service_settings: ['个体咨询'],
  specialties: ['emotion', 'relationship'],
  populations: ['成人', '青少年'],
  severity_levels: ['轻度', '中度'],
  session_formats: ['视频咨询', '线下面询'],
  session_duration: '50分钟',
  fee_min: 400,
  fee_budget_level: 'mid',
  available_slots: '工作日晚上、周末上午',
  bio_short: '本地演示账号使用的咨询师档案',
  bio_full: '用于本地演示咨询师工作台、匹配申请和 PCOMS 追踪流程。',
  is_active: true,
  review_status: 'approved',
  edit_token: 'local-counselor-demo-token'
};

const emptyDb = {
  assessments: [],
  counselors: [],
  sessions: [],
  pcoms_ratings: [],
  visitor_users: []
};

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function loadDb() {
  const db = fs.existsSync(DATA_FILE) ? { ...emptyDb, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) } : { ...emptyDb };
  if (!db.counselors.some((item) => item.id === LOCAL_COUNSELOR_ID)) {
    db.counselors.unshift({ ...localCounselor });
  }
  return db;
}

function saveDb(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'authorization,apikey,content-type,prefer',
    ...extra
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, corsHeaders({ 'Content-Type': 'application/json' }));
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function parsePath(url) {
  const parsed = new URL(url, `http://${HOST}:${PORT}`);
  const match = parsed.pathname.match(/^\/rest\/v1\/([^/]+)$/);
  return {
    table: match ? match[1] : null,
    params: parsed.searchParams
  };
}

function valueMatches(actual, expression) {
  const actualText = String(actual);
  const actualUuidText = actualText.replace(/-/g, '');
  if (expression.startsWith('eq.')) {
    const expected = expression.slice(3);
    return actualText === expected || actualUuidText === expected.replace(/-/g, '');
  }
  if (expression.startsWith('gte.')) {
    const expected = expression.slice(4);
    return actualText >= expected;
  }
  if (expression.startsWith('lt.')) {
    const expected = expression.slice(3);
    return actualText < expected;
  }
  if (expression.startsWith('in.(') && expression.endsWith(')')) {
    const values = expression.slice(4, -1).split(',').map((item) => item.trim());
    return values.includes(actualText);
  }
  return true;
}

function filterRows(rows, params) {
  let out = rows.slice();
  params.forEach((value, key) => {
    if (['select', 'order', 'limit', 'on_conflict'].includes(key)) return;
    out = out.filter((row) => valueMatches(row[key], value));
  });
  const order = params.get('order');
  if (order) {
    const [field, direction] = order.split('.');
    out.sort((a, b) => {
      const av = a[field] || '';
      const bv = b[field] || '';
      return direction === 'desc' ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv));
    });
  }
  const limit = Number(params.get('limit'));
  if (limit > 0) out = out.slice(0, limit);
  return out;
}

function upsertVisitorUser(rows, body) {
  const openid = body.openid || DEV_OPENID;
  let row = rows.find((item) => item.openid === openid);
  if (row) {
    Object.assign(row, body, { openid, updated_at: new Date().toISOString() });
    return row;
  }
  row = {
    id: body.id || uuid(),
    openid,
    nickname: body.nickname || '微信来访者',
    created_at: new Date().toISOString(),
    ...body
  };
  rows.push(row);
  return row;
}

function applyLocalDemoMatch(table, row) {
  if (table !== 'assessments') return row;
  if (row.match_request_cid) return row;
  if (row.user_agent !== 'wechat-miniprogram') return row;
  row.match_request_name = row.visitor_name || '微信来访者';
  row.match_request_contact = row.visitor_openid || DEV_OPENID;
  row.match_request_cid = LOCAL_COUNSELOR_ID;
  row.match_request_status = 'pending';
  return row;
}

async function handleRest(req, res) {
  const { table, params } = parsePath(req.url);
  const db = loadDb();
  if (!table || !Array.isArray(db[table])) {
    sendJson(res, 404, { message: `Unknown table: ${table}` });
    return;
  }

  if (req.method === 'GET') {
    sendJson(res, 200, filterRows(db[table], params));
    return;
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    const rows = db[table];
    const items = Array.isArray(body) ? body : [body];
    const inserted = items.map((item) => {
      if (table === 'visitor_users') return upsertVisitorUser(rows, item);
      const now = new Date().toISOString();
      const row = {
        id: item.id || uuid(),
        created_at: item.created_at || now,
        ...item
      };
      applyLocalDemoMatch(table, row);
      rows.push(row);
      return row;
    });
    saveDb(db);
    sendJson(res, 201, Array.isArray(body) ? inserted : inserted);
    return;
  }

  if (req.method === 'PATCH') {
    const patch = await readJson(req);
    const rows = filterRows(db[table], params);
    rows.forEach((row) => Object.assign(row, patch));
    saveDb(db);
    sendJson(res, 200, rows);
    return;
  }

  if (req.method === 'DELETE') {
    const rowsToDelete = new Set(filterRows(db[table], params).map((row) => row.id));
    db[table] = db[table].filter((row) => !rowsToDelete.has(row.id));
    saveDb(db);
    sendJson(res, 200, []);
    return;
  }

  sendJson(res, 405, { message: 'Method not allowed' });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (req.url === '/health') {
      sendJson(res, 200, { ok: true, mode: 'local-file', dataFile: DATA_FILE });
      return;
    }

    if (req.url === '/wechat/login' && req.method === 'POST') {
      sendJson(res, 200, { id: '', openid: DEV_OPENID, nickname: '微信来访者' });
      return;
    }

    if (req.url.startsWith('/rest/v1/')) {
      await handleRest(req, res);
      return;
    }

    sendJson(res, 404, { message: 'Not found' });
  } catch (error) {
    sendJson(res, 500, { message: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Xiaopingu local API listening on http://${HOST}:${PORT}`);
  console.log(`Using local data file ${DATA_FILE}`);
});
