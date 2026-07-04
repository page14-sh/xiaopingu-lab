const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'local-data.json');
const DEV_OPENID = process.env.DEV_OPENID || 'dev-openid-xiaopingu';
const LOCAL_COUNSELOR_ID = '00000000-0000-4000-8000-000000000001';
const DEMO_SEED_ENABLED = process.env.DEMO_SEED !== '0';
const DEMO_COUNSELOR_ID = '00000000-0000-4000-8000-000000000002';
const DEMO_ASSESSMENT_CRISIS_ID = '10000000-0000-4000-8000-000000000001';
const DEMO_ASSESSMENT_APPROVED_ID = '10000000-0000-4000-8000-000000000002';
const DEMO_ASSESSMENT_PASSIVE_ID = '10000000-0000-4000-8000-000000000003';

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

const demoCounselor = {
  id: DEMO_COUNSELOR_ID,
  created_at: '2026-07-01T01:00:00.000Z',
  updated_at: '2026-07-01T01:00:00.000Z',
  name: '调试咨询师',
  credential_level: '心理治疗师',
  years_experience: 12,
  education: '博士',
  city: '杭州',
  approaches: ['家庭治疗', 'EFT', 'CBT', 'DBT'],
  service_settings: ['个体咨询', '家庭咨询'],
  specialties: ['relationship', 'marriage', 'family', 'adolescent', 'crisis'],
  populations: ['成人', '青少年', '家庭'],
  severity_levels: ['轻度', '中度', '重度'],
  session_formats: ['视频咨询', '线下面询'],
  session_duration: '50分钟',
  fee_min: 600,
  fee_budget_level: 'high',
  available_slots: '周二/周四晚上，周六下午',
  bio_short: '用于展示推荐咨询师排序、危机风险承接和家庭系统方向。',
  bio_full: '演示用咨询师档案，覆盖关系、家庭、青少年和危机风险评估场景。',
  is_active: true,
  review_status: 'approved',
  edit_token: 'demo-counselor-token'
};

const demoAssessments = [
  {
    id: DEMO_ASSESSMENT_CRISIS_ID,
    view_token: DEMO_ASSESSMENT_CRISIS_ID,
    visitor_user_id: null,
    visitor_openid: DEV_OPENID,
    visitor_name: '高危演示来访者',
    visitor_age: 28,
    visitor_gender: '女',
    visitor_occupation: '在职人员',
    visitor_city: '上海',
    filled_by: 'self',
    prev_counseling: '是，曾就诊精神科或接受心理治疗',
    budget: 'mid',
    preferred_formats: ['视频咨询', '线下面询'],
    gender_pref: 'female',
    age_pref: 'older',
    orientation_pref: '',
    comm_style: 'guided',
    cnip_structure: 'structured',
    cnip_emotion: 'balanced',
    cnip_timefocus: 'present',
    cnip_warmth: 'warm',
    cnip_homework: 'yes',
    cnip_relational: 'discuss',
    expects: ['support', 'emotion_manage', 'crisis'],
    issues: ['emotion', 'crisis', 'personality'],
    description: '最近情绪波动明显，出现过具体自伤想法，希望尽快获得安全评估和支持。',
    duration: '几个月（1-6个月）',
    score_mood: 5,
    score_anxiety: 4,
    score_sleep: 4,
    score_function: 4,
    score_relation: 3,
    total_score: 20,
    severity: '重度',
    specials: ['diagnosed', 'medication'],
    crisis_level: 'active',
    user_agent: 'demo-seed',
    match_request_name: '高危演示来访者',
    match_request_contact: 'demo-crisis-contact',
    match_request_cid: LOCAL_COUNSELOR_ID,
    match_request_status: 'pending',
    created_at: '2026-07-04T01:00:00.000Z',
    updated_at: '2026-07-04T01:00:00.000Z'
  },
  {
    id: DEMO_ASSESSMENT_APPROVED_ID,
    view_token: DEMO_ASSESSMENT_APPROVED_ID,
    visitor_user_id: null,
    visitor_openid: DEV_OPENID,
    visitor_name: 'PCOMS演示来访者',
    visitor_age: 34,
    visitor_gender: '男',
    visitor_occupation: '在职人员',
    visitor_city: '上海',
    filled_by: 'self',
    prev_counseling: '是，接受过简短咨询（5次以内）',
    budget: 'mid',
    preferred_formats: ['视频咨询'],
    gender_pref: 'any',
    age_pref: 'peer',
    orientation_pref: '',
    comm_style: 'collaborative',
    cnip_structure: 'balanced',
    cnip_emotion: 'rational',
    cnip_timefocus: 'present',
    cnip_warmth: 'balanced',
    cnip_homework: 'neutral',
    cnip_relational: 'neutral',
    expects: ['solve', 'career_develop'],
    issues: ['emotion', 'workplace'],
    description: '工作压力较大，睡眠变差，希望通过短程咨询改善情绪和行动计划。',
    duration: '半年到一年',
    score_mood: 3,
    score_anxiety: 4,
    score_sleep: 4,
    score_function: 3,
    score_relation: 2,
    total_score: 16,
    severity: '重度',
    specials: [],
    crisis_level: 'safe',
    user_agent: 'demo-seed',
    match_request_name: 'PCOMS演示来访者',
    match_request_contact: 'demo-pcoms-contact',
    match_request_cid: LOCAL_COUNSELOR_ID,
    match_request_status: 'approved',
    match_request_reviewed_at: '2026-07-04T02:00:00.000Z',
    match_request_reviewed_by: LOCAL_COUNSELOR_ID,
    selected_counselor_id: LOCAL_COUNSELOR_ID,
    selected_counselor_name: '本地演示咨询师',
    selected_at: '2026-07-04T02:10:00.000Z',
    created_at: '2026-07-03T08:30:00.000Z',
    updated_at: '2026-07-04T02:10:00.000Z'
  },
  {
    id: DEMO_ASSESSMENT_PASSIVE_ID,
    view_token: DEMO_ASSESSMENT_PASSIVE_ID,
    visitor_user_id: null,
    visitor_openid: DEV_OPENID,
    visitor_name: '黄色风险演示来访者',
    visitor_age: 19,
    visitor_gender: 'TA',
    visitor_occupation: '在校学生（大学及以上）',
    visitor_city: '杭州',
    filled_by: 'self',
    prev_counseling: '否，这是第一次',
    budget: 'low',
    preferred_formats: ['视频咨询', '文字咨询'],
    gender_pref: 'any',
    age_pref: 'younger',
    orientation_pref: 'friendly',
    comm_style: 'shy',
    cnip_structure: 'open',
    cnip_emotion: 'emotional',
    cnip_timefocus: 'past',
    cnip_warmth: 'warm',
    cnip_homework: 'no',
    cnip_relational: 'neutral',
    expects: ['understand', 'support'],
    issues: ['relationship', 'adolescent', 'growth'],
    description: '最近人际关系压力大，有时会觉得活着没意思，但没有具体计划。',
    duration: '近期才出现（1个月以内）',
    score_mood: 4,
    score_anxiety: 3,
    score_sleep: 3,
    score_function: 2,
    score_relation: 4,
    total_score: 16,
    severity: '重度',
    specials: [],
    crisis_level: 'passive',
    user_agent: 'demo-seed',
    match_request_name: '黄色风险演示来访者',
    match_request_contact: 'demo-passive-contact',
    match_request_cid: LOCAL_COUNSELOR_ID,
    match_request_status: 'pending',
    created_at: '2026-07-04T03:00:00.000Z',
    updated_at: '2026-07-04T03:00:00.000Z'
  }
];

const demoSessions = [
  { id: '20000000-0000-4000-8000-000000000001', assessment_id: DEMO_ASSESSMENT_APPROVED_ID, counselor_id: LOCAL_COUNSELOR_ID, visitor_name: 'PCOMS演示来访者', session_number: 1, session_date: '2026-07-01', created_at: '2026-07-01T12:00:00.000Z' },
  { id: '20000000-0000-4000-8000-000000000002', assessment_id: DEMO_ASSESSMENT_APPROVED_ID, counselor_id: LOCAL_COUNSELOR_ID, visitor_name: 'PCOMS演示来访者', session_number: 2, session_date: '2026-07-03', created_at: '2026-07-03T12:00:00.000Z' },
  { id: '20000000-0000-4000-8000-000000000003', assessment_id: DEMO_ASSESSMENT_APPROVED_ID, counselor_id: LOCAL_COUNSELOR_ID, visitor_name: 'PCOMS演示来访者', session_number: 3, session_date: '2026-07-04', created_at: '2026-07-04T12:00:00.000Z' }
];

const demoPcomsRatings = [
  { id: '30000000-0000-4000-8000-000000000001', session_id: demoSessions[0].id, type: 'ORS', item_individual: 5, item_interpersonal: 6, item_social: 5, item_overall: 6, total_score: 22, clinical_change: null, created_at: '2026-07-01T12:10:00.000Z' },
  { id: '30000000-0000-4000-8000-000000000002', session_id: demoSessions[0].id, type: 'SRS', item_individual: 8, item_interpersonal: 8, item_social: 8, item_overall: 8, total_score: 32, created_at: '2026-07-01T12:12:00.000Z' },
  { id: '30000000-0000-4000-8000-000000000003', session_id: demoSessions[1].id, type: 'ORS', item_individual: 6.5, item_interpersonal: 6, item_social: 6.5, item_overall: 7, total_score: 26, clinical_change: 'no_change', created_at: '2026-07-03T12:10:00.000Z' },
  { id: '30000000-0000-4000-8000-000000000004', session_id: demoSessions[1].id, type: 'SRS', item_individual: 9, item_interpersonal: 8.5, item_social: 8.5, item_overall: 9, total_score: 35, created_at: '2026-07-03T12:12:00.000Z' },
  { id: '30000000-0000-4000-8000-000000000005', session_id: demoSessions[2].id, type: 'ORS', item_individual: 7.5, item_interpersonal: 7, item_social: 7, item_overall: 7.5, total_score: 29, clinical_change: 'improved', created_at: '2026-07-04T12:10:00.000Z' },
  { id: '30000000-0000-4000-8000-000000000006', session_id: demoSessions[2].id, type: 'SRS', item_individual: 9, item_interpersonal: 9, item_social: 9, item_overall: 9, total_score: 36, created_at: '2026-07-04T12:12:00.000Z' }
];

const demoVisitorUsers = [
  {
    id: '40000000-0000-4000-8000-000000000001',
    openid: DEV_OPENID,
    nickname: '微信来访者',
    created_at: '2026-07-01T00:00:00.000Z',
    last_login_at: '2026-07-04T00:00:00.000Z'
  }
];

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function ensureRows(rows, seedRows) {
  let changed = false;
  seedRows.forEach((seed) => {
    if (!rows.some((item) => item.id === seed.id)) {
      rows.push({ ...seed });
      changed = true;
    }
  });
  return changed;
}

function ensureDemoSeed(db) {
  if (!DEMO_SEED_ENABLED) return false;
  let changed = false;
  changed = ensureRows(db.counselors, [demoCounselor]) || changed;
  changed = ensureRows(db.visitor_users, demoVisitorUsers) || changed;
  changed = ensureRows(db.assessments, demoAssessments) || changed;
  changed = ensureRows(db.sessions, demoSessions) || changed;
  changed = ensureRows(db.pcoms_ratings, demoPcomsRatings) || changed;
  return changed;
}

function loadDb() {
  const db = fs.existsSync(DATA_FILE) ? { ...emptyDb, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) } : { ...emptyDb };
  let changed = false;
  if (!db.counselors.some((item) => item.id === LOCAL_COUNSELOR_ID)) {
    db.counselors.unshift({ ...localCounselor });
    changed = true;
  }
  changed = ensureDemoSeed(db) || changed;
  if (changed) {
    saveDb(db);
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
  return row;
}

function applyLocalComputedFields(table, row) {
  if (table === 'pcoms_ratings' && row.total_score === undefined) {
    row.total_score = Number(row.item_individual || 0) +
      Number(row.item_interpersonal || 0) +
      Number(row.item_social || 0) +
      Number(row.item_overall || 0);
  }
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
      applyLocalComputedFields(table, row);
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
  loadDb();
  console.log(`Xiaopingu local API listening on http://${HOST}:${PORT}`);
  console.log(`Using local data file ${DATA_FILE}`);
});
