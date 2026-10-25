// REST compatibility for existing intake/profile pages. All data uses the injected v2 namespace.
const crypto=require('node:crypto');
function createLegacyRest({db,hooks}) {
const _=db.command;
const TABLES=['counselors','assessments','sessions','pcoms_ratings','visitor_users'];
const DEMO_COUNSELOR_CODES={counselor:'00000000-0000-4000-8000-000000000001',counselor2:'00000000-0000-4000-8000-000000000002'};
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
  const rows=[];let after;const max=opts.limit?Math.min(opts.limit,1000):2000;
  for(;;){let q=db.collection(coll).where({...where,...(after?{_id:_.gt(after)}:{})}).orderBy('_id','asc').limit(100);const r=await q.get();if(r.code||!Array.isArray(r.data))throw new Error('Legacy compatibility read failed');rows.push(...r.data);if(r.data.length<100||rows.length>=max){if(rows.length>=2000&&!opts.limit)throw new Error('Legacy query requires pagination');return rows.slice(0,max);}after=r.data.at(-1)._id;}
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
        rows = (await findMany(table, {})).filter(r => r.migration_access !== 'admin-review' && (r.match_request_cid === caller.counselorId || r.selected_counselor_id === caller.counselorId));
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
        rows = rows.filter(r=>r.is_active===true && r.review_status==='approved' && !r.is_demo);
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
    if (!['assessments','counselors'].includes(table)) return sendJson(res,403,{message:'该写入口仅对管理员开放'});
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
        row.id = isUuid(item.id) ? item.id : uuid();
        if (await findOne('counselors', { id: row.id })) return sendJson(res, 409, { message: '记录已存在' });
        row.edit_token = crypto.randomBytes(24).toString('base64url');
        row.created_at = item.created_at || now;
        row.updated_at = now;
        row.is_active = isAdmin && item.is_active === true;
        row.is_demo = false;
        row.needs_deep_review = item.has_violation === '是' || item.has_incident === '是';
        row.review_status = isAdmin ? (item.review_status || 'pending') : 'pending'; // 匿名录入一律待审
        await hooks.createCounselor(row);
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
        
        row.created_at = item.created_at || now;
        row.updated_at = now;
        results.push(await hooks.createIntake(row,caller));
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
    if(!['assessments','counselors'].includes(table))return sendJson(res,410,{message:'历史记录只读，请使用新版周期'});
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
      const fresh = await hooks.patchIntake(rows[0], allowed, caller);
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
    return sendJson(res,405,{message:'迁移历史不允许删除'});
    if (!isAdmin) return sendJson(res, 403, { message: 'Forbidden: 删除仅限管理员' });
    const rows = (await findMany(table, {})).filter((r) =>
      Object.entries(filters).every(([k, expr]) => valueMatches(r[k], expr)));
    for (const r of rows) await db.collection(table).doc(r._id).remove();
    return sendJson(res, 200, []);
  }

  return sendJson(res, 405, { message: 'Method not allowed' });
}


return handleRest;
}
module.exports={createLegacyRest};
