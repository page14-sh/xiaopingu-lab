const crypto = require('crypto');
const { createCloudBaseAssessmentStore } = require('./assessment/cloudbase-store');
const { createAssessmentRepository } = require('./assessment/repository');
const { createIdentityRepository } = require('./assessment/identity-repository');
const { createConsentRepository } = require('./assessment/consent');
const { createProvenanceRepository } = require('./assessment/provenance');
const { createEventLifecycle } = require('./assessment/event-lifecycle');
const { createFollowupRepository } = require('./assessment/followups');
const { createNotificationWorker } = require('./assessment/notification-worker');
const { createNotificationService } = require('./assessment/notification-service');
const { createStatisticsRepository } = require('./assessment/statistics');
const { createLlmWorker } = require('./assessment/llm-worker');
const { createLlmService } = require('./assessment/llm-service');
const { createAssessmentHttp } = require('./assessment/http');
const {createAdmissionBridge}=require('./assessment/admission');
const { AUDIENCE } = require('./assessment/authorization');

const TABLES = new Set([
  'assessments',
  'counselors',
  'sessions',
  'pcoms_ratings',
  'visitor_users'
]);

const DEMO_COUNSELOR_ALIASES = {
  counselor: '00000000-0000-4000-8000-000000000001',
  counselor1: '00000000-0000-4000-8000-000000000001',
  counselor2: '00000000-0000-4000-8000-000000000002'
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization,apikey,content-type,prefer,x-counselor-token',
  'Access-Control-Max-Age': '600'
};

function uuid() {
  return crypto.randomUUID();
}

function sanitizePlainValue(value) {
  if (Array.isArray(value)) return value.map(sanitizePlainValue);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor' || key.startsWith('$')) continue;
    output[key] = sanitizePlainValue(child);
  }
  return output;
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(Object.assign(new Error('Request body is too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (_error) {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signSession(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifySession(token, secret) {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest('base64url');
  if (!safeEqual(parts[1], expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!payload || !['visitor', 'counselor', 'admin'].includes(payload.role) ||
        typeof payload.subject !== 'string' || !payload.subject ||
        !Number.isFinite(payload.exp) || payload.exp <= Date.now()) return null;
    return payload;
  } catch (_error) {
    return null;
  }
}

function sessionFromRequest(req, secret) {
  const authorization = req.headers.authorization || '';
  if (!authorization.startsWith('Bearer ')) return null;
  return verifySession(authorization.slice(7), secret);
}

function valueMatches(actual, expression) {
  const actualText = String(actual ?? '');
  if (expression.startsWith('eq.')) {
    return actualText === expression.slice(3);
  }
  if (expression.startsWith('gte.')) {
    return actualText >= expression.slice(4);
  }
  if (expression.startsWith('lt.')) {
    return actualText < expression.slice(3);
  }
  if (expression.startsWith('in.(') && expression.endsWith(')')) {
    return expression.slice(4, -1).split(',').map((item) => item.trim()).includes(actualText);
  }
  return false;
}

function filterRows(rows, params) {
  let output = rows.slice();
  params.forEach((value, key) => {
    if (['select', 'order', 'limit', 'on_conflict'].includes(key)) return;
    output = output.filter((row) => valueMatches(row[key], value));
  });
  const order = params.get('order');
  if (order) {
    const [field, direction] = order.split('.');
    output.sort((left, right) => {
      const a = String(left[field] ?? '');
      const b = String(right[field] ?? '');
      return direction === 'desc' ? b.localeCompare(a) : a.localeCompare(b);
    });
  }
  const limit = Number(params.get('limit'));
  if (Number.isFinite(limit) && limit > 0) output = output.slice(0, Math.min(limit, 1000));
  return output;
}

function projectRows(rows, select) {
  if (!select || select === '*') return rows;
  const fields = select.split(',').map((field) => field.trim()).filter(Boolean);
  return rows.map((row) => Object.fromEntries(fields.filter((field) => field in row).map((field) => [field, row[field]])));
}

function publicCounselor(row) {
  const output = { ...row };
  delete output._id;
  delete output.edit_token;
  delete output.license_number;
  delete output.review_note;
  delete output.reviewed_by;
  if (!output.contact_wechat_public) delete output.contact_wechat;
  if (!output.contact_phone_public) delete output.contact_phone;
  if (!output.contact_email_public) delete output.contact_email;
  return output;
}

function publicRow(row) {
  const output = { ...row };
  delete output._id;
  return output;
}

function exactFilter(params, key) {
  const expression = params.get(key) || '';
  return expression.startsWith('eq.') ? expression.slice(3) : '';
}

async function assignedAssessmentIds(store, counselorId) {
  const assessments = await store.list('assessments');
  return new Set(assessments
    .filter((item) => item.match_request_cid === counselorId || item.selected_counselor_id === counselorId)
    .map((item) => item.id));
}

async function authorizeRowsForRead(store, table, rows, params, session) {
  if (session && session.role === 'admin') return rows.map(publicRow);

  if (table === 'counselors') {
    if (session && session.role === 'counselor') {
      return rows.filter((row) => row.id === session.subject).map(publicRow);
    }
    return rows
      .filter((row) => row.is_active === true && row.review_status === 'approved')
      .map(publicCounselor);
  }

  if (table === 'assessments') {
    if (session && session.role === 'counselor') {
      return rows
        .filter((row) => row.match_request_cid === session.subject || row.selected_counselor_id === session.subject)
        .map(publicRow);
    }
    const capability = exactFilter(params, 'view_token') || exactFilter(params, 'id');
    if (!capability) return null;
    return rows.filter((row) => row.view_token === capability).map(publicRow);
  }

  if (table === 'sessions') {
    if (session && session.role === 'counselor') {
      const ids = await assignedAssessmentIds(store, session.subject);
      return rows.filter((row) => ids.has(row.assessment_id)).map(publicRow);
    }
    const assessmentId = exactFilter(params, 'assessment_id');
    if (!assessmentId) return null;
    const assessments = await store.list('assessments');
    const allowed = assessments.some((row) => row.id === assessmentId && row.view_token === assessmentId);
    return allowed ? rows.map(publicRow) : null;
  }

  if (table === 'pcoms_ratings') {
    const sessions = await store.list('sessions');
    if (session && session.role === 'counselor') {
      const assessmentIds = await assignedAssessmentIds(store, session.subject);
      const sessionIds = new Set(sessions.filter((item) => assessmentIds.has(item.assessment_id)).map((item) => item.id));
      return rows.filter((row) => sessionIds.has(row.session_id)).map(publicRow);
    }
    const sessionId = exactFilter(params, 'session_id');
    return sessionId ? rows.map(publicRow) : null;
  }

  return null;
}

async function authorizeMutation(store, table, rows, params, session) {
  if (session && session.role === 'admin') return true;
  if (session && session.role === 'counselor') {
    if (table === 'counselors') return rows.every((row) => row.id === session.subject);
    if (table === 'assessments') {
      return rows.every((row) => row.match_request_cid === session.subject || row.selected_counselor_id === session.subject);
    }
    const assessmentIds = await assignedAssessmentIds(store, session.subject);
    if (table === 'sessions') return rows.every((row) => assessmentIds.has(row.assessment_id));
    if (table === 'pcoms_ratings') {
      const sessions = await store.list('sessions');
      const allowedSessionIds = new Set(sessions.filter((row) => assessmentIds.has(row.assessment_id)).map((row) => row.id));
      return rows.every((row) => allowedSessionIds.has(row.session_id));
    }
  }
  if (table === 'assessments') {
    const capability = exactFilter(params, 'view_token') || exactFilter(params, 'id');
    return Boolean(capability) && rows.length > 0 && rows.every((row) => row.view_token === capability);
  }
  return false;
}

function sanitizeCreate(table, input) {
  const now = new Date().toISOString();
  const row = sanitizePlainValue(input);
  delete row._id;
  delete row.xg_managed;
  if (table === 'assessments') {
    row.id = row.id || uuid();
    row.view_token = row.id;
    row.created_at = row.created_at || now;
  } else if (table === 'counselors') {
    row.id = row.id || uuid();
    row.edit_token = crypto.randomBytes(24).toString('base64url');
    row.review_status = 'pending';
    row.is_active = false;
    row.created_at = row.created_at || now;
    row.updated_at = now;
    delete row.review_note;
    delete row.reviewed_at;
    delete row.reviewed_by;
  } else {
    row.id = row.id || uuid();
    row.created_at = row.created_at || now;
  }
  if (table === 'pcoms_ratings' && row.total_score === undefined) {
    row.total_score = Number(row.item_individual || 0) + Number(row.item_interpersonal || 0) +
      Number(row.item_social || 0) + Number(row.item_overall || 0);
  }
  return row;
}

async function canCreate(store, table, row, session) {
  if (session && session.role === 'admin') return true;
  if (session && session.role === 'counselor') {
    const assessmentIds = await assignedAssessmentIds(store, session.subject);
    if (table === 'sessions') return assessmentIds.has(row.assessment_id);
    if (table === 'pcoms_ratings') {
      const sessions = await store.list('sessions');
      return sessions.some((item) => item.id === row.session_id && assessmentIds.has(item.assessment_id));
    }
    if (table === 'assessments' || table === 'counselors') return true;
    return false;
  }
  if (table === 'assessments' || table === 'counselors') return true;
  if (table === 'sessions') {
    const assessments = await store.list('assessments');
    return assessments.some((item) => item.id === row.assessment_id && item.view_token === row.assessment_id);
  }
  if (table === 'pcoms_ratings') {
    const sessions = await store.list('sessions');
    return sessions.some((item) => item.id === row.session_id);
  }
  return false;
}

function createRequestHandler(options) {
  const { store, adminPassword, demoCounselorPassword, sessionSecret, demoMode } = options;
  const xgHandler = createAssessmentHttp({ store, signSession, sessionSecret,
    identityBridge: options.identityBridge, serviceSecrets: options.serviceSecrets, readJson, sendJson,
    demoCounselorIds: Object.values(DEMO_COUNSELOR_ALIASES) });

  return async function handler(req, res) {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const session = sessionFromRequest(req, sessionSecret);

      if (await xgHandler(req, res, url, session)) return;

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, mode: 'cloudbase-nosql' });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/auth/admin') {
        const body = await readJson(req);
        if (!adminPassword || !safeEqual(body.password, adminPassword)) {
          sendJson(res, 401, { message: '管理员凭据无效' });
          return;
        }
        const token = signSession({ role: 'admin', subject: 'admin', aud: AUDIENCE,
          auth_method: 'admin-password', demo: false, exp: Date.now() + 2 * 60 * 60 * 1000 }, sessionSecret);
        sendJson(res, 200, { token, expires_in: 7200 });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/auth/counselor') {
        const body = await readJson(req);
        const counselors = await store.list('counselors');
        let counselor = typeof body.credential === 'string' && body.credential.length > 0
          ? counselors.find((item) => typeof item.edit_token === 'string' && item.edit_token.length > 0 && safeEqual(item.edit_token, body.credential))
          : null;
        let usedDemo = false;
        if (!counselor && demoMode && demoCounselorPassword && safeEqual(body.password, demoCounselorPassword)) {
          const counselorId = DEMO_COUNSELOR_ALIASES[String(body.credential || '').trim()];
          counselor = counselors.find((item) => item.id === counselorId);
          usedDemo = true;
        }
        if (!counselor) {
          sendJson(res, 401, { message: '咨询师凭据无效' });
          return;
        }
        const token = signSession({ role: 'counselor', subject: counselor.id, aud: AUDIENCE,
          auth_method: usedDemo ? 'demo' : 'counselor-edit',
          demo: usedDemo || counselor.is_demo === true || Object.values(DEMO_COUNSELOR_ALIASES).includes(counselor.id),
          exp: Date.now() + 24 * 60 * 60 * 1000 }, sessionSecret);
        sendJson(res, 200, { token, counselor: publicRow(counselor), expires_in: 86400 });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/wechat/login') {
        if (!demoMode) {
          sendJson(res, 501, { message: '微信环境尚未绑定，请使用 wx.cloud 原生身份' });
          return;
        }
        const visitor = { id: 'demo-visitor', openid: 'demo-openid-xiaopingu', nickname: '微信演示来访者' };
        const existing = (await store.list('visitor_users')).find((item) => item.openid === visitor.openid);
        if (!existing) await store.insert('visitor_users', { ...visitor, created_at: new Date().toISOString() });
        sendJson(res, 200, visitor);
        return;
      }

      const match = url.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      const table = match ? match[1] : '';
      if (!TABLES.has(table)) {
        sendJson(res, 404, { message: 'Not found' });
        return;
      }

      if (req.method === 'GET') {
        const rows = filterRows((await store.list(table)).filter((row) => !row.xg_managed), url.searchParams);
        const allowed = await authorizeRowsForRead(store, table, rows, url.searchParams, session);
        if (!allowed) {
          sendJson(res, 403, { message: '无权读取该资源' });
          return;
        }
        sendJson(res, 200, projectRows(allowed, url.searchParams.get('select')));
        return;
      }

      if (req.method === 'POST') {
        const body = await readJson(req);
        const inputs = Array.isArray(body) ? body : [body];
        const inserted = [];
        for (const input of inputs) {
          const row = sanitizeCreate(table, input || {});
          if (!(await canCreate(store, table, row, session))) {
            sendJson(res, 403, { message: '无权创建该资源' });
            return;
          }
          const duplicate = (await store.list(table)).some((item) => item.id === row.id);
          if (duplicate) {
            sendJson(res, 409, { message: '记录已存在' });
            return;
          }
          await store.insert(table, row);
          inserted.push(publicRow(row));
        }
        sendJson(res, 201, inserted);
        return;
      }

      if (req.method === 'PATCH') {
        const patch = sanitizePlainValue(await readJson(req));
        delete patch._id;
        delete patch.id;
        delete patch.edit_token;
        delete patch.xg_managed;
        const rows = filterRows(await store.list(table), url.searchParams);
        if (rows.some((row) => row.xg_managed)) {
          sendJson(res, 403, { message: '四评来源记录须经专用接口操作' }); return;
        }
        if (!(await authorizeMutation(store, table, rows, url.searchParams, session))) {
          sendJson(res, 403, { message: '无权修改该资源' });
          return;
        }
        const updated = [];
        for (const row of rows) {
          const next = { ...patch, updated_at: new Date().toISOString() };
          await store.update(table, row._id, next);
          updated.push(publicRow({ ...row, ...next }));
        }
        sendJson(res, 200, updated);
        return;
      }

      if (req.method === 'DELETE') {
        if (!session || session.role !== 'admin') {
          sendJson(res, 403, { message: '仅管理员可删除资源' });
          return;
        }
        const rows = filterRows(await store.list(table), url.searchParams);
        if (rows.some((row) => row.xg_managed)) {
          sendJson(res, 403, { message: '四评来源记录须经专用接口操作' }); return;
        }
        for (const row of rows) await store.remove(table, row._id);
        sendJson(res, 200, []);
        return;
      }

      sendJson(res, 405, { message: 'Method not allowed' });
    } catch (error) {
      console.error('request failed', {
        name: error && error.name,
        message: error && error.message,
        path: req.url,
        method: req.method
      });
      sendJson(res, error.statusCode || 500, { message: error.statusCode ? error.message : '服务暂时不可用' });
    }
  };
}

function createCloudBaseStore(db, { notificationProvider, llmProvider } = {}) {
  const xgStore = createCloudBaseAssessmentStore(db);
  const consent = createConsentRepository(xgStore);
  return {
    // Internal cycle-scoped persistence. Not exposed via TABLES / generic REST.
    assessment: createAssessmentRepository(xgStore),
    identity: createIdentityRepository(xgStore),
    admission: createAdmissionBridge(xgStore,consent),
    consent,
    lifecycle: createEventLifecycle(xgStore, consent),
    followups: createFollowupRepository(xgStore),
    statistics: createStatisticsRepository(xgStore),
    llmWorker: createLlmWorker(xgStore,{provider:llmProvider}),
    llm: createLlmService(xgStore),
    notificationWorker: createNotificationWorker(xgStore, { provider: notificationProvider }),
    notifications: createNotificationService(xgStore, { validateCounselor: async (id) => {
      const result = await db.collection('counselors').where({ id }).limit(2).get();
      return !result.code && Array.isArray(result.data) && result.data.length === 1 && result.data[0].is_active === true &&
        result.data[0].review_status === 'approved' && !result.data[0].is_demo && !Object.values(DEMO_COUNSELOR_ALIASES).includes(id);
    } }),
    provenance: createProvenanceRepository(xgStore),
    async findById(table, id) {
      if (!TABLES.has(table) || typeof id !== 'string') throw new Error('Invalid lookup');
      const result = await db.collection(table).where({ id }).limit(2).get();
      if (result.code || !Array.isArray(result.data)) throw new Error('Lookup failed');
      if (result.data.length > 1) throw new Error('Ambiguous record identity');
      return result.data[0] || null;
    },
    async list(table) {
      const rows = [];
      const pageSize = 100;
      for (let offset = 0; offset < 1000; offset += pageSize) {
        const result = await db.collection(table).skip(offset).limit(pageSize).get();
        const page = Array.isArray(result.data) ? result.data : [];
        rows.push(...page);
        if (page.length < pageSize) break;
      }
      return rows;
    },
    async insert(table, row) {
      return db.collection(table).add(row);
    },
    async update(table, documentId, patch) {
      return db.collection(table).doc(documentId).update(patch);
    },
    async remove(table, documentId) {
      return db.collection(table).doc(documentId).remove();
    }
  };
}

module.exports = {
  createCloudBaseStore,
  createRequestHandler,
  signSession,
  verifySession
};
