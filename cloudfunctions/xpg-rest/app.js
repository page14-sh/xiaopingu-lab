// Legacy REST compatibility service, imported from the live 2026-10-25 baseline.
// Profile edits, approvals and clinical data access are independently authorized.
// Existing intake links remain valid; short aliases alone grant no access.
const crypto = require('crypto');
const cloud = require('@cloudbase/node-sdk');

const app = cloud.init(process.env.XPG_ENV ? { env: process.env.XPG_ENV } : undefined);
const db = app.database();
const _ = db.command;

const ADMIN_PASSWORD = process.env.XPG_ADMIN_PASSWORD || '';
const TABLES = ['counselors', 'assessments', 'sessions', 'pcoms_ratings', 'visitor_users'];
const DEMO_COUNSELOR_CODES = {
  counselor: '00000000-0000-4000-8000-000000000001',
  counselor1: '00000000-0000-4000-8000-000000000001',
  counselor2: '00000000-0000-4000-8000-000000000002'
};

// ---------------- 基础工具 ----------------
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function adminToken() { return ADMIN_PASSWORD ? 'adm.' + sha256(ADMIN_PASSWORD + '|xpg-admin-v1') : null; }
function isAdminToken(t) { return t === adminToken(); }
function uuid() { return crypto.randomUUID(); }
function realCounselor(c) { return c && !c.is_demo && !Object.values(DEMO_COUNSELOR_CODES).includes(c.id); }
function activeCounselor(caller) { return caller.role === 'counselor' && caller.counselor?.is_active === true && caller.counselor?.review_status === 'approved'; }
function exactCapability(filters) { const value=filters.view_token || filters.id || ''; return /^eq\./.test(value) && isUuid(value.slice(3)) ? value.slice(3) : null; }

function isUuid(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
function nowIso() { return new Date().toISOString(); }

// ---------- 短编号（来访者好记好输的评估号别名，如 K7M2-9X4T） ----------
// 字母表去掉易混淆字符 0/O/1/I/L/U，32 字符 × 8 位 ≈ 1.1 万亿组合
const SHORT_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'; // 30 字符
function genShortCode() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += SHORT_ALPHABET[bytes[i] % SHORT_ALPHABET.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}
function normalizeShortCode(s) {
  // 用户输入容错：去空格/横线、转大写、O→0 之类不做（字母表不含）
  return String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}
async function uniqueShortCode() {
  for (let i = 0; i < 12; i++) {
    const c = genShortCode();
    if (!(await findOne('assessments', { short_id: c }))) return c;
  }
  throw new Error('short code collision');
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'authorization,apikey,content-type,prefer,x-assessment-token',
    'Content-Type': 'application/json'
  });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  if (req.__bodyRaw !== undefined) {
    return new Promise((resolve, reject) => {
      if (!req.__bodyRaw) return resolve({});
      try { resolve(JSON.parse(req.__bodyRaw)); } catch (e) { reject(e); }
    });
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ---------------- 数据访问 ----------------
async function findMany(coll, where, opts = {}) {
  let q = db.collection(coll).where(where);
  if (opts.orderBy) q = q.orderBy(opts.orderBy, opts.orderDir === 'desc' ? 'desc' : 'asc');
  if (opts.limit) q = q.limit(Math.min(opts.limit, 1000));
  const r = await q.get();
  return r.data || [];
}
async function findOne(coll, where) {
  const rows = await findMany(coll, where, { limit: 1 });
  return rows[0] || null;
}
async function insertOne(coll, doc) {
  await db.collection(coll).add(doc);
  return doc;
}
async function updateWhere(coll, where, patch) {
  await db.collection(coll).where(where).update(patch);
}

// ---------------- 身份 ----------------
async function resolveCaller(req) {
  const h = req.headers || {};
  const auth = h['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return { role: 'anon', counselorId: null, token: null };
  if (isAdminToken(token)) return { role: 'admin', counselorId: null, token };
  const c = await findOne('counselors', { edit_token: token });
  if (realCounselor(c)) return { role: 'counselor', counselorId: c.id, token, counselor: c };
  return { role: 'anon', counselorId: null, token: null };
}

// ---------------- 字段策略 ----------------
// counselors 匿名读剥离（与旧线上一致，另加执照号）
const COUNSELOR_SENSITIVE = ['edit_token', 'contact_wechat', 'contact_phone', 'contact_email', 'license_number', 'public_welfare_fee', 'photo_license', 'wx_openid', 'wx_bind_token', 'review_note', 'reviewed_by', 'reviewed_at', 'has_violation', 'violation_detail', 'has_incident', 'incident_detail', 'needs_deep_review'];
function stripCounselor(row) {
  if (!row) return row;
  const out = { ...row };
  COUNSELOR_SENSITIVE.forEach((k) => delete out[k]);
  return out;
}
// 咨询师照片：dataURL 数组，每张 ≤ 260KB（字符数），最多 3 张；非图片/超限一律剔除
function sanitizeCounselorPhotos(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  v.forEach((s) => {
    if (typeof s === 'string' && /^data:image\/(jpeg|jpg|png|webp);base64,/.test(s) && s.length <= 260000) out.push(s);
  });
  return out.slice(0, 3);
}
// 本人档案编辑白名单；审核、启用状态与身份字段须管理员。
const COUNSELOR_PATCH_FIELDS = [
  'name', 'credential_level', 'years_experience', 'education', 'city',
  'approaches', 'service_settings', 'specialties', 'populations', 'severity_levels',
  'session_formats', 'session_duration', 'fee_min', 'fee_budget_level', 'available_slots',
  'bio_short', 'bio_full', 'training_background', 'supervision_hours', 'personal_therapy_hours',
  'ethics_training', 'certifications', 'orientation_friendly', 'client_gender_pref',
  'client_age_prefs', 'comm_styles', 'cnip_styles', 'cnip_emotion_focus', 'cnip_time',
  'cnip_stance', 'cnip_homework', 'cnip_relational', 'public_welfare', 'public_welfare_fee',
  'photo_daily', 'photo_license',
  // 资质与认证：咨询师可随时自行更新（平台复核后生效，审核状态不变、不影响现有匹配）
  'gender', 'supervisor_cert', 'license_number', 'extra_credentials', 'extra_credentials_other',
  'certifications_other', 'approaches_other', 'specialties_other', 'populations_other',
  'personal_therapy_status', 'therapy_cert', 'gender_identity_friendly', 'credential_updated_at',
  'contact_wechat', 'contact_wechat_public', 'contact_phone', 'contact_phone_public',
  'contact_email', 'contact_email_public', 'has_violation', 'violation_detail', 'has_incident', 'incident_detail', 'updated_at'
];
// 兼容字段集合；下方按来访能力凭证、所属咨询师、管理员分别授权。
const ASSESSMENT_PATCH_FIELDS = [
  'match_request_name', 'match_request_contact', 'match_request_cid', 'match_request_status',
  'match_request_reviewed_at', 'match_request_reviewed_by', 'match_request_reviewed_note',
  'selected_counselor_id', 'selected_counselor_name', 'selected_at', 'updated_at'
];
const SESSION_FIELDS = ['assessment_id', 'counselor_id', 'visitor_name', 'session_number', 'session_date', 'notes', 'created_at'];
const PCOMS_FIELDS = ['session_id', 'type', 'item_individual', 'item_interpersonal', 'item_social', 'item_overall', 'clinical_change', 'notes', 'created_at'];

function pickAllowed(body, whitelist) {
  const out = {};
  Object.keys(body || {}).forEach((k) => { if (whitelist.includes(k)) out[k] = body[k]; });
  return out;
}

// ---------------- PostgREST 风格过滤 ----------------
function valueMatches(actual, expression) {
  const actualText = String(actual);
  const actualUuidText = actualText.replace(/-/g, '');
  if (expression.startsWith('eq.')) {
    const expected = expression.slice(3);
    return actualText === expected || actualUuidText === expected.replace(/-/g, '');
  }
  if (expression.startsWith('in.(') && expression.endsWith(')')) {
    const values = expression.slice(4, -1).split(',').map((s) => s.trim());
    return values.some((v) => actualText === v || actualUuidText === v.replace(/-/g, ''));
  }
  if (expression.startsWith('is.')) {
    const v = expression.slice(3);
    if (v === 'null') return actual === null || actual === undefined;
    if (v === 'true') return actual === true;
    if (v === 'false') return actual === false;
    return false;
  }
  return false; // 收口：不认识的操作符一律不匹配
}

function parseFilters(params) {
  const filters = {};
  params.forEach((value, key) => {
    if (['select', 'order', 'limit', 'on_conflict', 'apikey'].includes(key)) return;
    filters[key] = value;
  });
  return filters;
}

function applyFilters(rows, filters) {
  let out = rows.slice();
  Object.entries(filters).forEach(([key, expr]) => {
    out = out.filter((row) => valueMatches(row[key], expr));
  });
  return out;
}

function applyOrderLimit(rows, params) {
  const order = params.get('order');
  if (order) {
    const [field, direction] = order.split('.');
    out_sort(direction !== 'desc');
    function out_sort(asc) {
      rows.sort((a, b) => {
        const av = a[field], bv = b[field];
        if (av === bv) return 0;
        if (av === undefined || av === null) return 1;
        if (bv === undefined || bv === null) return -1;
        if (typeof av === 'number' && typeof bv === 'number') return asc ? av - bv : bv - av;
        return asc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
      });
    }
  }
  const limit = Number(params.get('limit'));
  if (limit > 0) rows = rows.slice(0, limit);
  return rows;
}

// ---------------- REST 核心 ----------------
async function handleRest(req, res, table, params, caller) {
  if (!TABLES.includes(table)) return sendJson(res, 404, { message: 'Unknown table: ' + table });
  const filters = parseFilters(params);
  const filterKeys = Object.keys(filters);
  const isAdmin = caller.role === 'admin';

  // ---------- GET ----------
  if (req.method === 'GET') {
    let rows;
    if (isAdmin) {
      rows = await findMany(table, {});
    } else if (caller.role === 'counselor') {
      // 咨询师令牌：可看对口申请与自己档案
      if (table === 'counselors') {
        rows = await findMany(table, {});
        rows = rows.filter((r) => r.id === caller.counselorId || (r.is_active !== false && r.review_status === 'approved'));
      } else if (table === 'assessments') {
        if (!activeCounselor(caller)) return sendJson(res,403,{message:'咨询师尚未通过审核或已停用'});
        if (filters.match_request_cid && filters.match_request_cid !== 'eq.' + caller.counselorId) {
          return sendJson(res, 403, { message: 'Forbidden: 只能查看自己的匹配申请' });
        }
        rows = (await findMany(table, {})).filter(r => r.match_request_cid === caller.counselorId || r.selected_counselor_id === caller.counselorId);
      } else if (['sessions','pcoms_ratings'].includes(table) && activeCounselor(caller)) {
        const own=(await findMany('assessments',{})).filter(r=>r.match_request_cid===caller.counselorId||r.selected_counselor_id===caller.counselorId).map(r=>r.id);
        const sessions=(await findMany('sessions',{})).filter(r=>own.includes(r.assessment_id));
        rows=table==='sessions'?sessions:(await findMany('pcoms_ratings',{})).filter(r=>sessions.some(x=>x.id===r.session_id));
      } else {
        return sendJson(res, 403, { message: 'Forbidden' });
      }
    } else {
      // 匿名：能力键受限读
      if (table === 'counselors') {
        rows = await findMany(table, {});
        rows = rows.filter(r=>r.is_active===true && r.review_status==='approved');
      } else if (table === 'assessments') {
        const cap=exactCapability(filters);
        if(!cap)return sendJson(res,403,{message:'须使用完整评估凭证，咨询师编号不是来访者凭证'});
        rows=(await findMany(table,{})).filter(r=>r.view_token===cap);
      } else {
        return sendJson(res, 403, { message: 'Forbidden' });
      }
    }
    let out = applyOrderLimit(applyFilters(rows, filters), params);
    if (table === 'counselors' && !isAdmin) {
      // 咨询师令牌看自己完整档案；其余（含匿名）一律剥离敏感字段
      out = out.map((r) => (caller.role === 'counselor' && r.id === caller.counselorId ? r : stripCounselor(r)));
    }
    return sendJson(res, 200, out);
  }

  // ---------- POST ----------
  if (req.method === 'POST') {
    const body = await readBody(req);
    const items = Array.isArray(body) ? body : [body];
    if (!isAdmin && !['assessments','counselors'].includes(table)) return sendJson(res,403,{message:'该写入口仅对管理员开放'});
    if(!items.length||items.length>20||items.some(x=>!x||Object.getPrototypeOf(x)!==Object.prototype))return sendJson(res,400,{message:'请求内容不合法'});

    if (table === 'visitor_users') {
      const results = [];
      for (const item of items) {
        const openid = item.openid || 'dev-openid-xiaopingu';
        let row = await findOne('visitor_users', { openid });
        if (row) {
          await updateWhere('visitor_users', { id: row.id }, { ...pickAllowed(item, ['nickname', 'avatar_url']), openid, updated_at: nowIso() });
        } else {
          row = { id: isUuid(item.id) ? item.id : uuid(), openid, nickname: item.nickname || '微信来访者', created_at: nowIso(), updated_at: nowIso() };
          await insertOne('visitor_users', row);
        }
        results.push(row);
      }
      return sendJson(res, 201, results);
    }

    const results = [];
    for (const item of items) {
      const now = nowIso();
      if (table === 'counselors') {
        const row = pickAllowed(item, COUNSELOR_PATCH_FIELDS.concat(['id', 'created_at']));
        row.photo_daily = sanitizeCounselorPhotos(item.photo_daily);
        row.photo_license = sanitizeCounselorPhotos(item.photo_license);
        // 微信扫码注册绑定：校验一次性绑定令牌（creg 会话完成后下发，防伪造 openid）
        if (item.wx_openid && item.wx_bind_token) {
          const sess = await findOne('wx_login_sessions', { bind_token: String(item.wx_bind_token) });
          if (sess && sess.openid === item.wx_openid && !sess.used && sess.kind === 'creg' && Date.parse(sess.expires_at)>Date.now()) {
            row.wx_openid = String(item.wx_openid);
            await updateWhere('wx_login_sessions', { bind_token: String(item.wx_bind_token) }, { used: true, counselor_id: row.id });
          }
        }
        row.id = isUuid(item.id) ? item.id : uuid();
        if (await findOne('counselors', { id: row.id })) return sendJson(res, 409, { message: '记录已存在' });
        row.edit_token = crypto.randomBytes(24).toString('base64url');
        row.created_at = item.created_at || now;
        row.updated_at = now;
        row.is_active = isAdmin && item.is_active === true;
        row.is_demo = false;
        row.needs_deep_review = item.has_violation === '是' || item.has_incident === '是';
        row.review_status = isAdmin ? (item.review_status || 'pending') : 'pending'; // 匿名录入一律待审
        await insertOne('counselors', row);
        // Only the successful registration response returns this new editing credential.
        results.push(row);
      } else if (table === 'assessments') {
        const row = { ...item };
        delete row.match_request_status; delete row.match_request_reviewed_at; delete row.match_request_reviewed_by;
        delete row.match_request_reviewed_note; delete row.selected_counselor_id; delete row.selected_counselor_name; delete row.selected_at;
        delete row.short_id; // 短编号只能服务端生成，客户端传值一律丢弃
        row.id = isUuid(item.id) ? item.id : uuid();
        row.view_token = row.id;
        for(const key of ['_id','xg_managed','visitor_user_id','visitor_id','match_id','xg_scope_status','role','permissions'])delete row[key];
        if(row.match_request_cid)row.match_request_status='pending';
        row.short_id = await uniqueShortCode();
        if (await findOne('assessments', { id: row.id })) return sendJson(res, 409, { message: '记录已存在' });
        row.created_at = item.created_at || now;
        row.updated_at = now;
        await insertOne('assessments', row);
        results.push(row);
      } else if (table === 'sessions') {
        const row = pickAllowed(item, SESSION_FIELDS);
        row.id = isUuid(item.id) ? item.id : uuid();
        if (await findOne('sessions', { id: row.id })) return sendJson(res, 409, { message: '记录已存在' });
        row.created_at = item.created_at || now;
        await insertOne('sessions', row);
        results.push(row);
      } else if (table === 'pcoms_ratings') {
        const row = pickAllowed(item, PCOMS_FIELDS);
        if (!row.session_id) return sendJson(res, 400, { message: '缺少 session_id' });
        if (!['ORS', 'SRS'].includes(row.type)) return sendJson(res, 400, { message: 'type 须为 ORS/SRS' });
        for (const k of ['item_individual', 'item_interpersonal', 'item_social', 'item_overall']) {
          const v = Number(row[k]);
          if (isNaN(v) || v < 0 || v > 10) return sendJson(res, 400, { message: k + ' 须在 0–10' });
          row[k] = v;
        }
        // P0：总分服务端计算，客户端传值一律覆盖
        row.total_score = Math.round((row.item_individual + row.item_interpersonal + row.item_social + row.item_overall) * 100) / 100;
        row.id = isUuid(item.id) ? item.id : uuid();
        if (await findOne('pcoms_ratings', { id: row.id })) return sendJson(res, 409, { message: '记录已存在' });
        row.created_at = item.created_at || now;
        await insertOne('pcoms_ratings', row);
        results.push(row);
      }
    }
    return sendJson(res, 201, results);
  }

  // ---------- PATCH ----------
  if (req.method === 'PATCH') {
    const patch = await readBody(req);
    const single = filters.id || filters.view_token;

    if (table === 'counselors') {
      if (!/^eq\./.test(filters.id||'') || !isUuid(filters.id.slice(3))) return sendJson(res,403,{message:'须按完整 id 单行更新'});
      if (!isAdmin && (caller.role!=='counselor'||filters.id!=='eq.'+caller.counselorId))return sendJson(res,403,{message:'仅本人或管理员可编辑档案'});
      const target = (await findMany('counselors', {})).find((r) => valueMatches(r.id, filters.id));
      if (!target) return sendJson(res, 404, { message: 'Not found' });
      const wantsAdminFields = Object.keys(patch).some((k) => !COUNSELOR_PATCH_FIELDS.includes(k));
      if (wantsAdminFields && !isAdmin) {
        return sendJson(res, 403, { message: 'Forbidden: 审核/状态字段仅管理员可改' });
      }
      const allowed = isAdmin ? patch : pickAllowed(patch, COUNSELOR_PATCH_FIELDS);
      if(!isAdmin && target.review_status==='rejected')Object.assign(allowed,{review_status:'pending',is_active:false});
      if(!isAdmin && ('has_violation'in allowed||'has_incident'in allowed))allowed.needs_deep_review=(allowed.has_violation??target.has_violation)==='是'||(allowed.has_incident??target.has_incident)==='是';
      if ('photo_daily' in allowed) allowed.photo_daily = sanitizeCounselorPhotos(allowed.photo_daily);
      if ('photo_license' in allowed) allowed.photo_license = sanitizeCounselorPhotos(allowed.photo_license);
      // 资质 / 认证字段有实质变更 → 记录更新时间，供平台复核
      // （不改变 review_status：修改档案不会让咨询师下架，也不影响已通过的匹配）
      const CRED_KEYS = ['credential_level', 'years_experience', 'license_number', 'supervisor_cert',
        'extra_credentials', 'extra_credentials_other', 'certifications', 'certifications_other',
        'therapy_cert', 'photo_license', 'education', 'training_background'];
      const credChanged = CRED_KEYS.some(function(k) {
        return (k in allowed) && JSON.stringify(allowed[k]) !== JSON.stringify(target[k]);
      });
      if (credChanged) allowed.credential_updated_at = nowIso();
      allowed.updated_at = nowIso();
      await updateWhere('counselors', { id: target.id }, allowed);
      const fresh = await findOne('counselors', { id: target.id });
      return sendJson(res, 200, [isAdmin ? fresh : stripCounselor(fresh)]);
    }

    if (table === 'assessments') {
      if (!single) return sendJson(res, 403, { message: 'Forbidden: 须按 id/view_token 单行更新' });
      const rows = (await findMany('assessments', {})).filter((r) =>
        Object.entries(filters).every(([k, expr]) => valueMatches(r[k], expr)));
      if (!rows.length) return sendJson(res, 404, { message: 'Not found' });
      if (rows.length > 1) return sendJson(res, 403, { message: 'Forbidden: 命中多行' });
      if(!isAdmin){
        if(caller.role==='counselor'){
          if(!activeCounselor(caller)||!(rows[0].match_request_cid===caller.counselorId||rows[0].selected_counselor_id===caller.counselorId))return sendJson(res,403,{message:'无权审批该申请'});
          const fields=['match_request_status','match_request_reviewed_note','match_request_reviewed_at','match_request_reviewed_by','updated_at'];
          if(Object.keys(patch).some(k=>!fields.includes(k)))return sendJson(res,403,{message:'审批不能修改来访者数据或归属'});
          if('match_request_status'in patch&&!['approved','rejected','contacted'].includes(patch.match_request_status))return sendJson(res,400,{message:'审批状态不合法'});
          patch.match_request_reviewed_by=caller.counselorId;patch.match_request_reviewed_at=nowIso();
        }else{
          const cap=exactCapability(filters);if(!cap||rows[0].view_token!==cap)return sendJson(res,403,{message:'无效评估凭证'});
          const fields=['match_request_name','match_request_contact','match_request_cid','selected_counselor_id','selected_counselor_name','selected_at','updated_at'];
          if(Object.keys(patch).some(k=>!fields.includes(k)))return sendJson(res,403,{message:'来访者不能审批或修改历史分数'});
          if('match_request_cid'in patch)Object.assign(patch,{match_request_status:'pending',match_request_reviewed_by:null,match_request_reviewed_at:null,match_request_reviewed_note:null});
        }
        if(['active','action'].includes(rows[0].crisis_level)&&Object.keys(patch).some(k=>k.startsWith('match_request_')||k.startsWith('selected_')))return sendJson(res,403,{message:'当前评估不开放咨询匹配'});
      }
      const banned = ['id', 'view_token', 'created_at', 'total_score', 'crisis_level',
        'score_mood', 'score_anxiety', 'score_sleep', 'score_function', 'score_relation', 'severity'];
      if (!isAdmin && Object.keys(patch).some((k) => banned.includes(k))) {
        return sendJson(res, 403, { message: 'Forbidden: 该字段不可修改' });
      }
      const allowed = isAdmin ? { ...patch } : pickAllowed(patch, ASSESSMENT_PATCH_FIELDS);
      // ===== 锚点：审批通过（approved）时，服务端自动生成匹配单号 match_id = "<评估号>-<序号>" =====
      // 客户端不得自行指定（防伪造）；管理员可显式指定修正
      if (allowed.match_request_status === 'approved') {
        const prev = rows[0].match_id;
        const forceNew = allowed.force_new_match === true || allowed.force_new_match === 'true';
        if (!prev || forceNew) {
          let seq = 1;
          if (prev) {
            const m = String(prev).match(/-(\d+)$/);
            if (m) seq = parseInt(m[1], 10) + 1;
          }
          allowed.match_id = rows[0].id + '-' + seq;
          allowed.match_id_created_at = nowIso();
        }
      }
      delete allowed.force_new_match;
      if (!isAdmin && allowed.match_request_status !== 'approved') delete allowed.match_id;
      allowed.updated_at = nowIso();
      await updateWhere('assessments', { id: rows[0].id }, allowed);
      const fresh = await findOne('assessments', { id: rows[0].id });
      return sendJson(res, 200, [fresh]);
    }

    if (!isAdmin) return sendJson(res, 403, { message: 'Forbidden' });
    // sessions / pcoms_ratings / visitor_users：仅管理员
    const rows = (await findMany(table, {})).filter((r) =>
      Object.entries(filters).every(([k, expr]) => valueMatches(r[k], expr)));
    if (!rows.length) return sendJson(res, 404, { message: 'Not found' });
    patch.updated_at = nowIso();
    await updateWhere(table, { id: _.in(rows.map((r) => r.id)) }, patch);
    return sendJson(res, 200, rows);
  }

  // ---------- DELETE ----------
  if (req.method === 'DELETE') {
    if (!isAdmin) return sendJson(res, 403, { message: 'Forbidden: 删除仅限管理员' });
    const rows = (await findMany(table, {})).filter((r) =>
      Object.entries(filters).every(([k, expr]) => valueMatches(r[k], expr)));
    for (const r of rows) await db.collection(table).doc(r._id).remove();
    return sendJson(res, 200, []);
  }

  return sendJson(res, 405, { message: 'Method not allowed' });
}

// ---------------- 微信公众号扫码登录 / 绑定 ----------------
// 骨架：WX_APPID / WX_SECRET / WX_TOKEN 未配置时优雅降级（configured:false），前端走备用凭码入口。
// 公众号后台「开发 → 基本配置」URL 填 <host>/xpg-rest/wx/callback，Token 与 WX_TOKEN 一致。
const WX_APPID = process.env.WX_APPID || '';
const WX_SECRET = process.env.WX_SECRET || '';
const WX_TOKEN = process.env.WX_TOKEN || '';
let _wxTokenCache = { token: '', expireAt: 0 };

function wxSha1(str) { return crypto.createHash('sha1').update(str).digest('hex'); }
function wxCheckSignature(q) {
  if (!WX_TOKEN) return false;
  const arr = [WX_TOKEN, q.get('timestamp') || '', q.get('nonce') || ''].sort();
  return wxSha1(arr.join('')) === (q.get('signature') || '');
}
async function wxAccessToken() {
  if (!WX_APPID || !WX_SECRET) return null;
  if (_wxTokenCache.token && Date.now() < _wxTokenCache.expireAt) return _wxTokenCache.token;
  const url = 'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' + WX_APPID + '&secret=' + encodeURIComponent(WX_SECRET);
  const d = await fetch(url).then((r) => r.json()).catch(() => null);
  if (!d || !d.access_token) return null;
  _wxTokenCache = { token: d.access_token, expireAt: Date.now() + (d.expires_in - 120) * 1000 };
  return d.access_token;
}
function xmlVal(xml, tag) {
  const m = xml.match(new RegExp('<' + tag + '><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></' + tag + '>')) ||
            xml.match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>'));
  return m ? m[1] : '';
}
async function readText(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------- 路由 ----------------
async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'authorization,apikey,content-type,prefer,x-assessment-token'
    });
    return res.end();
  }
  const parsed = new URL(req.url, 'http://localhost');
  const path = parsed.pathname;

  try {
    if (path === '/health') {
      return sendJson(res, 200, { ok: true, mode: 'cloudbase-nosql-secure', version: 'security-20261025' });
    }

    // 短编号 → 评估号解析（公开：短编号本身就是来访者凭证，只回 id 不泄漏评估内容）
    if (path === '/resolve' && req.method === 'GET') {
      const raw = parsed.searchParams.get('code') || '';
      if (isUuid(raw.trim())) {
        const row0 = await findOne('assessments', { id: raw.trim() });
        if (!row0) return sendJson(res, 404, { message: '评估号不存在' });
        return sendJson(res, 200, { id: row0.id, short_id: row0.short_id || null });
      }
      const cap=req.headers['x-assessment-token'];
      if(!isUuid(cap))return sendJson(res,403,{message:'短编号只用于查找，请使用原填写设备或完整评估链接'});
      const norm = normalizeShortCode(raw);
      if (norm.length !== 8) return sendJson(res, 400, { message: '编号格式不对，应为 8 位短编号或完整评估号' });
      const code = norm.slice(0, 4) + '-' + norm.slice(4);
      const row = await findOne('assessments', { short_id: code });
      if (!row || row.view_token!==cap) return sendJson(res,403,{message:'编号与当前评估凭证不匹配'});
      return sendJson(res, 200, { id: row.id, short_id: row.short_id });
    }

    if (path === '/wechat/login' && req.method === 'POST') {
      return sendJson(res,501,{configured:false,message:'微信身份尚未开通，请使用现有初评入口；不会生成模拟身份'});
    }

    if (path === '/auth/admin' && req.method === 'POST') {
      const body = await readBody(req);
      if (!ADMIN_PASSWORD) return sendJson(res,503,{message:'管理员身份配置尚未完成'});
      if (body.password !== ADMIN_PASSWORD) return sendJson(res, 401, { message: '管理员密码错误' });
      return sendJson(res, 200, { token: adminToken(), role: 'admin' });
    }

    if (path === '/auth/counselor' && req.method === 'POST') {
      const body = await readBody(req);
      const credential = body.credential || body.code || '';
      let c = credential ? await findOne('counselors', { edit_token: credential }) : null;
      if (!realCounselor(c)) return sendJson(res,401,{message:'请使用本人有效编辑码登录，演示账号不访问真实数据'});
      return sendJson(res, 200, { token: c.edit_token, counselor: stripCounselor(c), counselor_id: c.id });
    }

    // ---- 微信公众号：扫码登录 / 注册绑定 ----
    if (path === '/wx/qrcode' && req.method === 'GET') {
      if(!WX_APPID||!WX_SECRET||!WX_TOKEN)return sendJson(res,200,{configured:false,message:'微信扫码尚未开通，请使用编辑码登录'});
      const kind = (parsed.searchParams.get('kind') || 'clogin').replace(/[^a-z]/g, '');
      const scene = kind + '-' + crypto.randomBytes(6).toString('hex');
      await insertOne('wx_login_sessions', {
        id: scene, scene, kind, status: 'pending', openid: null, counselor_id: null,
        created_at: nowIso(), expires_at: new Date(Date.now() + 10 * 60000).toISOString()
      });
      if (!WX_APPID || !WX_SECRET) {
        return sendJson(res, 200, { configured: false, scene, message: '微信扫码登录未配置（WX_APPID / WX_SECRET 未设置）' });
      }
      const at = await wxAccessToken();
      if (!at) return sendJson(res, 200, { configured: false, scene, message: '微信 access_token 获取失败，请检查 appid/secret 与 IP 白名单' });
      const qr = await fetch('https://api.weixin.qq.com/cgi-bin/qrcode/create?access_token=' + at, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expire_seconds: 600, action_name: 'QR_STR_SCENE', action_info: { scene: { scene_str: scene } } })
      }).then((r) => r.json()).catch(() => null);
      if (!qr || !qr.ticket) return sendJson(res, 200, { configured: false, scene, message: '二维码生成失败：' + ((qr && qr.errmsg) || '未知') });
      return sendJson(res, 200, { configured: true, scene, qr_url: 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=' + encodeURIComponent(qr.ticket), expires_in: 600 });
    }

    if (path === '/wx/session' && req.method === 'GET') {
      const scene = parsed.searchParams.get('scene') || '';
      const s = await findOne('wx_login_sessions', { scene });
      if (!s || Date.parse(s.expires_at)<=Date.now()) return sendJson(res,404,{message:'会话不存在或已过期'});
      if (s.status !== 'done') return sendJson(res, 200, { status: s.status });
      return sendJson(res, 200, { status: 'done', kind: s.kind, openid: s.openid, counselor_id: s.counselor_id || null, bind_token: s.bind_token || null });
    }

    // 微信服务器校验：公众号后台配置时验证
    if (path === '/wx/callback' && req.method === 'GET') {
      if (!wxCheckSignature(parsed.searchParams)) return sendJson(res, 403, { message: 'signature 校验失败' });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(parsed.searchParams.get('echostr') || '');
    }

    // 微信事件推送：关注（subscribe）/ 已关注扫码（SCAN）
    if (path === '/wx/callback' && req.method === 'POST') {
      if(!wxCheckSignature(parsed.searchParams))return sendJson(res,403,{message:'signature 校验失败'});
      const xml = req.__bodyRaw!==undefined ? req.__bodyRaw : await readText(req);
      const event = xmlVal(xml, 'Event');
      const openid = xmlVal(xml, 'FromUserName');
      let scene = xmlVal(xml, 'EventKey');
      if (scene.indexOf('qrscene_') === 0) scene = scene.slice(8);
      if ((event === 'subscribe' || event === 'SCAN') && scene) {
        const s = await findOne('wx_login_sessions', { scene });
        if (s && s.status !== 'done' && Date.parse(s.expires_at)>Date.now()) {
          const patch = { status: 'done', openid, updated_at: nowIso() };
          if (s.kind === 'clogin') {
            const c = await findOne('counselors', { wx_openid: openid });
            if (c) patch.counselor_id = c.id;
          }
          if (s.kind === 'creg') patch.bind_token = crypto.randomBytes(12).toString('hex');
          await updateWhere('wx_login_sessions', { scene }, patch);
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('success');
    }

    if(path==='/xg/counselor-context' && req.method==='GET'){
      const caller=await resolveCaller(req);
      if(!activeCounselor(caller))return sendJson(res,403,{message:'请使用已审核咨询师的编辑码登录'});
      const id=parsed.searchParams.get('assessment_id');if(!isUuid(id))return sendJson(res,400,{message:'评估号不合法'});
      const a=await findOne('assessments',{id});
      if(!a||a.match_request_cid!==caller.counselorId||!['approved','contacted'].includes(a.match_request_status))return sendJson(res,403,{message:'该来访尚未审批通过或不属于当前咨询师'});
      if(!a.match_id)return sendJson(res,409,{message:'该申请尚无咨询周期，请先由管理员核对'});
      const v=await findOne('visitor_users',{id:'asid-'+id});
      if(!v)return sendJson(res,409,{message:'请先由来访者进入四评并完成知情同意'});
      const latest=await findMany('xg_assessment_events',{match_id:a.match_id},{orderBy:'session_no',orderDir:'desc',limit:1});
      return sendJson(res,200,{match_id:a.match_id,user_id:v.id,counselor_id:caller.counselorId,session_no:Math.max(1,Number(latest[0]?.session_no)||0)});
    }

    // ---- 四评个案列表（仅管理员；同库读 xg_* 集合）----
    if (path === '/xg/cases' && req.method === 'GET') {
      const caller = await resolveCaller(req);
      if (caller.role !== 'admin') return sendJson(res, 401, { message: 'Forbidden: 须管理员令牌' });
      const cases = await findMany('xg_case_switch', {});
      const events = await findMany('xg_assessment_events', {});
      const alerts = await findMany('xg_alerts', {});
      const out = [];
      for (const c of cases) {
        const mid = c.match_id;
        const ce = events.filter((e) => e.match_id === mid || (c.visitor_id && e.user_id === c.visitor_id));
        const ca = alerts.filter((a) => a.match_id === mid || (c.visitor_id && a.user_id === c.visitor_id));
        const lastAt = ce.map((e) => e.created_at).filter(Boolean).sort().pop() || null;
        let counselorName = '';
        if (c.counselor_id) {
          const cn = await findOne('counselors', { id: c.counselor_id });
          if (cn) counselorName = cn.name || '';
        }
        let visitorName = '';
        if (c.visitor_id) {
          const v = await findOne('visitor_users', { id: c.visitor_id });
          if (v) visitorName = v.nickname || '';
        }
        out.push({
          match_id: mid, counselor_id: c.counselor_id || null, counselor_name: counselorName,
          visitor_id: c.visitor_id || null, visitor_name: visitorName,
          card_started: ce.filter((e) => e.status === 'started').length,
          card_submitted: ce.filter((e) => e.status === 'submitted').length,
          card_abandoned: ce.filter((e) => e.status === 'abandoned').length,
          alerts_total: ca.length,
          alerts_open: ca.filter((a) => a.status && a.status !== 'closed').length,
          last_activity_at: lastAt, updated_at: c.updated_at || null
        });
      }
      out.sort((a, b) => String(b.last_activity_at || '').localeCompare(String(a.last_activity_at || '')));
      return sendJson(res, 200, { total: out.length, cases: out });
    }

    // ---- 四评质量统计（仅管理员；口径与 xg-api /admin/stats 一致）----
    if (path === '/xg/stats' && req.method === 'GET') {
      const caller = await resolveCaller(req);
      if (caller.role !== 'admin') return sendJson(res, 401, { message: 'Forbidden: 须管理员令牌' });
      const events = await findMany('xg_assessment_events', {}, { limit: 1000 });
      const alerts = await findMany('xg_alerts', {}, { limit: 1000 });
      const jobs = await findMany('xg_llm_jobs', {}, { limit: 1000 });
      const endProfiles = await findMany('xg_end_profile', {}, { limit: 1000 });

      const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
      const m = {};

      // 填卡用时（仅 submitted）
      const durs = events.filter((e) => e.status === 'submitted' && e.duration_ms != null)
        .map((e) => Number(e.duration_ms)).sort((a, b) => a - b);
      m.fill_duration_ms = durs.length >= 5 ? { p50: pct(durs, 50), p90: pct(durs, 90), n: durs.length } : null;

      // 放弃率：同一 (user, card, session) 计一次
      const seen = new Map();
      events.forEach((e) => {
        const k = e.user_id + '|' + e.scale_code + '|' + e.session_no;
        const cur = seen.get(k) || { started: 0, abandoned: 0 };
        if (e.status === 'started' || e.status === 'abandoned' || e.status === 'submitted') cur.started++;
        if (e.status === 'abandoned') cur.abandoned++;
        seen.set(k, cur);
      });
      const totStarted = [...seen.values()].reduce((a, x) => a + x.started, 0);
      const totAbandoned = [...seen.values()].reduce((a, x) => a + x.abandoned, 0);
      m.abandon_rate = totStarted >= 5 ? Math.round((totAbandoned / totStarted) * 100) / 100 : null;

      // 敷衍填写率
      const submitted = events.filter((e) => e.status === 'submitted');
      const lowQ = submitted.filter((e) => e.quality_flag === 'low');
      m.low_quality_rate = submitted.length >= 5 ? Math.round((lowQ.length / submitted.length) * 100) / 100 : null;

      // 预警处理时长（小时，仅 closed）
      const handled = alerts.filter((a) => a.status === 'closed' && a.handled_at && a.triggered_at)
        .map((a) => (new Date(a.handled_at).getTime() - new Date(a.triggered_at).getTime()) / 3600000)
        .sort((a, b) => a - b);
      m.alert_handle_time_h = handled.length >= 5
        ? { p50: Math.round(pct(handled, 50) * 10) / 10, p90: Math.round(pct(handled, 90) * 10) / 10, n: handled.length } : null;

      // 提醒有动作率：L2/L3 中有 cst_note 或已关闭 ÷ 全部 L2/L3
      const l23 = alerts.filter((a) => a.alert_level === 'L2' || a.alert_level === 'L3');
      const acted = l23.filter((a) => a.cst_note || a.status === 'closed');
      m.remind_action_rate = l23.length >= 5 ? Math.round((acted.length / l23.length) * 100) / 100 : null;

      // 随访回收率
      const rates = {};
      ['1m', '3m'].forEach((rd) => {
        const due = endProfiles.filter((p) => p['follow_' + rd + '_due_at'] && new Date(p['follow_' + rd + '_due_at']) <= new Date());
        const done = due.filter((p) => p['follow_' + rd + '_result'] === 'sent');
        rates[rd] = due.length >= 5 ? Math.round((done.length / due.length) * 100) / 100 : null;
      });
      m.follow_return_rate = (rates['1m'] != null || rates['3m'] != null) ? rates : null;

      // LLM 成功率
      const doneJobs = jobs.filter((j) => j.status === 'done');
      m.llm_success_rate = jobs.length >= 5 ? Math.round((doneJobs.length / jobs.length) * 100) / 100 : null;

      // 总量概览（不受"满 5 条才出指标"限制，便于看板展示规模）
      m.overview = {
        events_total: events.length,
        submitted_total: submitted.length,
        abandoned_total: events.filter((e) => e.status === 'abandoned').length,
        alerts_total: alerts.length,
        alerts_open: alerts.filter((a) => a.status && a.status !== 'closed').length,
        l23_total: l23.length
      };

      const metric = parsed.searchParams.get('metric') || 'all';
      if (metric !== 'all' && m[metric] !== undefined) return sendJson(res, 200, { metric: metric, value: m[metric] });
      return sendJson(res, 200, { range: { from: null, to: null }, metrics: m });
    }

    const m2 = path.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (m2) {
      const caller = await resolveCaller(req);
      return handleRest(req, res, m2[1], parsed.searchParams, caller);
    }

    return sendJson(res, 404, { message: 'Not found' });
  } catch (e) {
    return sendJson(res,500,{message:'服务暂不可用，请稍后重试'});
  }
}

module.exports = { handleRequest };
