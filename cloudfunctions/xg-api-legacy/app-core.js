// ============================================================================
// 小平菇 · 四评 API（xg）— CloudBase NoSQL Edition V3.2
// 依据：《【修改版V3.2】06 API 接口规格》《02 数据字典》《03 schema.sql》
// 形态：独立云托管服务，挂 /v1/xg 前缀，直连 CloudBase NoSQL 12 张 xg_* 集合
// 鉴权：Bearer <token>（visitor=openid/id，counselor=edit_token，admin=管理令牌）
//       x-service-token <token>（系统间：/m4/close、/jobs/*、/internal/*）
// ============================================================================
const http = require('http');
const cloud = require('@cloudbase/node-sdk');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_TOKEN = process.env.XG_ADMIN_TOKEN || '';
const SERVICE_TOKEN = process.env.XG_SERVICE_TOKEN || '';
const CONSENT_VERSION = process.env.XG_CONSENT_VERSION || 'v1';
const LATE_RECHECK_DAYS = Number(process.env.XG_LATE_RECHECK_DAYS || 7);
const BANNED_WORDS = ['恶化', '病情', '严重', '抑郁', '焦虑症', '变差', '下降', '危险', '自杀'];

// 云函数/云托管环境自动注入环境 ID；本地调试可用 XG_ENV 显式指定
const app = cloud.init(process.env.XG_ENV ? { env: process.env.XG_ENV } : undefined);
const db = app.database();
const _ = db.command;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function nowIso() { return new Date().toISOString(); }

// 输出统一 +08:00（06 §0：时间一律 ISO 8601 + 08:00）
function to08(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T` +
    `${p(d.getUTCHours() + 8)}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+08:00`;
}

function daysBetween(aIso, bIso) {
  return (new Date(bIso).getTime() - new Date(aIso).getTime()) / 86400000;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'authorization,content-type,x-service-token',
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(body);
}

function xgError(res, httpStatus, code, message, field) {
  const err = { code, message };
  if (field) err.field = field;
  sendJson(res, httpStatus, { error: err });
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

// ---------------------------------------------------------------------------
// 数据访问封装
// ---------------------------------------------------------------------------
async function findMany(coll, where, opts = {}) {
  let q = db.collection(coll).where(where);
  if (opts.orderBy) {
    q = q.orderBy(opts.orderBy, opts.orderDir === 'desc' ? 'desc' : 'asc');
  }
  if (opts.limit) q = q.limit(Math.min(opts.limit, 200));
  const r = await q.get();
  return r.data || [];
}

async function findOne(coll, where, opts = {}) {
  const rows = await findMany(coll, where, { ...opts, limit: 1 });
  return rows[0] || null;
}

async function insertOne(coll, doc) {
  const r = await db.collection(coll).add(doc);
  return r.id || r._id;
}

async function updateWhere(coll, where, patch) {
  // NoSQL update 的两个坑（都会让整请求 500）：
  //   1) null 值不被接受 → 转成"删除该字段"
  //   2) 对象/数组会被 SDK 展开成点路径（raw_answers.s1），
  //      若原字段是 null 会报 "Cannot create field 's1' in element {raw_answers: null}"
  //      → 一律用 _.set() 整体覆盖
  const data = { updated_at: nowIso() };
  const isContainer = (v) => v !== null && typeof v === 'object';
  Object.keys(patch || {}).forEach((k) => {
    const v = patch[k];
    if (v === undefined) return;
    if (v === null) {
      if (typeof _.remove === 'function') data[k] = _.remove();
      return;
    }
    data[k] = (isContainer(v) && typeof _.set === 'function') ? _.set(v) : v;
  });
  await db.collection(coll).where(where).update(data);
}

let _configCache = null;
let _configCacheAt = 0;
const CONFIG_CACHE_TTL_MS = 30 * 1000; // 线上改配置最迟 30s 生效
async function getConfig() {
  if (_configCache && (Date.now() - _configCacheAt) < CONFIG_CACHE_TTL_MS) return _configCache;
  const rows = await findMany('xg_config', {});
  const cfg = {};
  rows.forEach((r) => { cfg[r.key] = r.value; });
  _configCache = cfg;
  _configCacheAt = Date.now();
  return cfg;
}
function bustConfigCache() { _configCache = null; }

// 数值归一化：兼容 MongoDB 扩展 JSON 包装（{$numberInt:"7"} 等）——
// 若 SDK 直接返回原始包装对象，cfgInt 会静默落回默认值，导致线上改配置不生效。
function num(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v !== '' && !isNaN(Number(v))) return Number(v);
  if (v && typeof v === 'object') {
    const raw = v.$numberInt != null ? v.$numberInt
      : v.$numberDouble != null ? v.$numberDouble
        : v.$numberLong != null ? v.$numberLong : null;
    if (raw != null && !isNaN(Number(raw))) return Number(raw);
  }
  return null;
}

function cfgInt(cfg, key, dflt) {
  const n = num(cfg[key]);
  return n === null ? dflt : n;
}

function cfgStr(cfg, key, dflt) {
  const v = cfg[key];
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return dflt;
}

// ---------------------------------------------------------------------------
// 身份解析（06 §0）
// ---------------------------------------------------------------------------
async function resolveIdentity(req) {
  const serviceToken = req.headers['x-service-token'];
  if (serviceToken && serviceToken === SERVICE_TOKEN) return { role: 'service' };

  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!bearer) return { role: null };

  if (bearer === ADMIN_TOKEN) return { role: 'admin' };

  // 咨询师：counselors.edit_token
  const c = await findOne('counselors', { edit_token: bearer });
  if (c && c.is_active===true && c.review_status==='approved' && !c.is_demo && !/^00000000-0000-4000-8000-00000000000[12]$/.test(c.id)) return { role: 'counselor', userId: c.id, counselorId: c.id, name: c.name };

  // 来访：visitor_users.openid / id
  const v = await findOne('visitor_users', _.or([{ openid: bearer }, { id: bearer }]));
  if (v && v.source==='assessment' && /^[0-9a-f-]{36}$/i.test(v.asid||'')) return { role: 'visitor', userId: v.id, nickname: v.nickname };

  return { role: null };
}

function requireRole(res, identity, roles) {
  if (!identity.role || !roles.includes(identity.role)) {
    xgError(res, 401, 'XG_UNAUTHORIZED', '未登录或令牌失效');
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 计分（03 schema.sql xg_compute_scores 唯一口径，JS 等价实现）
// ---------------------------------------------------------------------------
function grabInt(raw, code) {
  const v = raw ? raw[code] : undefined;
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function computeScores(scaleCode, raw, optionalCount) {
  const sum = (codes) => codes.reduce((acc, c) => acc + (grabInt(raw, c) || 0), 0);
  const out = { total: null, pct: null, ors_total: null, add_total: null, supp_total: null, resource_total: null, dissoc_level: null };
  const r2 = (n) => Math.round(n * 100) / 100;

  if (scaleCode === 'xg_m0_baseline') {
    for (let i = 1; i <= 7; i++) {
      const v = grabInt(raw, 's' + i);
      if (v === null) throw { code: 'XG_MISSING_ITEM', field: 's' + i };
      if (v < 0 || v > 10) throw { code: 'XG_VALUE_RANGE', field: 's' + i };
    }
    out.total = sum(['s1', 's2', 's3', 's4', 's5', 's6', 's7']);
    out.pct = r2((out.total / 70) * 100);
    out.ors_total = Math.round(sum(['s1', 's2', 's3']) / 3 + sum(['s4', 's5', 's6']));
    out.add_total = grabInt(raw, 's7');
    out.supp_total = sum(['b1', 'b2', 'b3']);
    out.resource_total = sum(['r1', 'r2']);
    out.dissoc_level = grabInt(raw, 'd1') || 0;
    return out;
  }

  if (scaleCode === 'xg_m1_state') {
    for (let i = 1; i <= 7; i++) {
      const v = grabInt(raw, 's' + i);
      if (v === null) throw { code: 'XG_MISSING_ITEM', field: 's' + i };
      if (v < 0 || v > 10) throw { code: 'XG_VALUE_RANGE', field: 's' + i };
    }
    let t = sum(['s1', 's2', 's3', 's4', 's5', 's6', 's7']);
    let max = 70;
    const oc = Math.min(optionalCount || 0, 3);
    for (let i = 8; i <= 7 + oc; i++) { t += grabInt(raw, 's' + i) || 0; max += 10; }
    out.total = t;
    out.pct = r2((t / max) * 100);
    out.ors_total = Math.round(sum(['s1', 's2', 's3']) / 3 + sum(['s4', 's5', 's6']));
    out.add_total = grabInt(raw, 's7');
    return out;
  }

  if (scaleCode === 'xg_m2_feel') {
    out.total = sum(['f1', 'f2', 'f3', 'f4']);
    out.pct = r2((out.total / 40) * 100);
    return out;
  }

  if (scaleCode === 'xg_m3_pro') {
    out.total = sum(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    out.pct = r2((out.total / 60) * 100);
    return out;
  }

  if (scaleCode === 'xg_m4_end') {
    out.total = sum(['e1', 'e2', 'e3', 'e4', 'e5', 'e6']);
    out.pct = r2((out.total / 60) * 100);
    out.supp_total = sum(['e3', 'e4', 'e5']);
    return out;
  }

  if (scaleCode === 'xg_m4_eval') {
    out.total = sum(['v1', 'v2', 'v3']); // o1 文字不计分
    out.pct = r2((out.total / 30) * 100);
    return out;
  }

  if (scaleCode === 'xg_m4_follow') {
    out.total = sum(['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
    out.pct = r2((out.total / 60) * 100);
    out.supp_total = sum(['u2', 'u3', 'u4']);
    return out;
  }

  // 风险复查卡（P1-B6 过程内风险再筛查）：单题，不产 pct、不并入任何量表分
  if (scaleCode === 'xg_risk_recheck') {
    const v = grabInt(raw, 'k1');
    if (v === null) throw { code: 'XG_MISSING_ITEM', field: 'k1' };
    if (v < 0 || v > 10) throw { code: 'XG_VALUE_RANGE', field: 'k1' };
    out.total = v; // 0=没有 / 5=偶尔闪过 / 10=经常出现
    return out;
  }

  throw { code: 'XG_BAD_PARAM', message: '未知卡片：' + scaleCode };
}

// ---------------------------------------------------------------------------
// 知情同意判定（xg_has_consent）
// ---------------------------------------------------------------------------
async function hasConsent(userId, scope) {
  const rows = await findMany('xg_consent', { user_id: userId, scope, revoked_at: null });
  return rows.length > 0;
}

function scopeOfScale(scaleCode) {
  return scaleCode && scaleCode.indexOf('xg_m4_') === 0 ? 'followup' : 'assessment';
}

// ---------------------------------------------------------------------------
// 预警判定（03 xg_evaluate_alerts 的 NoSQL 等价实现）
// 幂等键：user_id + alert_type + event_id（存在则按最高级合并）
// ---------------------------------------------------------------------------
async function upsertAlert(alert) {
  const existing = await findOne('xg_alerts', {
    user_id: alert.user_id, alert_type: alert.alert_type, event_id: alert.event_id
  });
  if (!existing) {
    await insertOne('xg_alerts', {
      id: uuid(), ...alert,
      status: 'open', cst_step: null, cst_note: null,
      notify_channel: null, notified_at: null, notify_result: null,
      handled_at: null, created_at: nowIso(), updated_at: nowIso()
    });
    return;
  }
  const sevRank = { info: 1, warn: 2, urgent: 3 };
  const lvRank = { L1: 1, L2: 2, L3: 3 };
  const patch = { detail: { ...existing.detail, ...alert.detail } };
  if ((sevRank[alert.severity] || 0) > (sevRank[existing.severity] || 0)) {
    patch.severity = alert.severity;
    patch.alert_level = alert.alert_level;
  }
  await updateWhere('xg_alerts', { id: existing.id }, patch);
}

async function evaluateAlerts(userId, eventId, sessionNo) {
  const cfg = await getConfig();
  const cDropAbs = cfgInt(cfg, 'outcome_drop_abs', 7);
  const cDropCons = cfgInt(cfg, 'outcome_drop_consecutive', 2);
  const cFlatDelta = cfgInt(cfg, 'outcome_flat_delta', 3);
  const cFlatCons = cfgInt(cfg, 'outcome_flat_consecutive', 4);
  const cStabItem = cfgInt(cfg, 'stability_item_max', 3);
  const cStabCons = cfgInt(cfg, 'stability_consecutive', 2);
  const cAllyTotal = cfgInt(cfg, 'alliance_total_max', 28);
  const cAllyDim = cfgInt(cfg, 'alliance_dim_max', 3);
  const cAllyCons = cfgInt(cfg, 'alliance_consecutive', 2);
  const cL3Cons = cfgInt(cfg, 'l3_consecutive', 3);
  const cL3LowPct = cfgInt(cfg, 'l3_low_pct', 30);
  const cDiffPost = cfgInt(cfg, 'diff_post_warn', 15);
  const cRiskPos = cfgInt(cfg, 'risk_recheck_positive_min', 5);
  const cRiskUrgent = cfgInt(cfg, 'risk_recheck_urgent_min', 10);

  // 阈值留痕（A1 校准前提）：每条告警都记下判定所用阈值与阈值版本，
  // 否则 100–200 样本后无法回溯"这条告警是哪个阈值算出来的"。
  const thSnap = {
    threshold_version: cfgStr(cfg, 'threshold_version', 'v3.2-engineering-default'),
    outcome_drop_abs: cDropAbs, outcome_drop_consecutive: cDropCons,
    outcome_flat_delta: cFlatDelta, outcome_flat_consecutive: cFlatCons,
    stability_item_max: cStabItem, stability_consecutive: cStabCons,
    alliance_total_max: cAllyTotal, alliance_dim_max: cAllyDim, alliance_consecutive: cAllyCons,
    l3_consecutive: cL3Cons, l3_low_pct: cL3LowPct, diff_post_warn: cDiffPost,
    risk_recheck_positive_min: cRiskPos, risk_recheck_urgent_min: cRiskUrgent
  };
  const put = (a) => upsertAlert({ ...a, detail: { ...(a.detail || {}), threshold: thSnap } });

  const ev = await findOne('xg_assessment_events', { id: eventId });
  if (!ev) return;
  let counselorId = ev.counselor_id || null;
  const scale = ev.scale_code;

  // 咨询师归属兜底（D22）：事件自身 → 同 match 的 case_switch → 同 match 事件 → 用户最近事件
  if (!counselorId) {
    if (ev.match_id) {
      const sw = await findOne('xg_case_switch', { match_id: ev.match_id });
      if (sw && sw.counselor_id) counselorId = sw.counselor_id;
    }
  }
  if (!counselorId && ev.match_id) {
    const m = await findMany('xg_assessment_events',
      { match_id: ev.match_id, counselor_id: _.neq(null) }, { limit: 1 });
    if (m.length) counselorId = m[0].counselor_id;
  }
  if (!counselorId) {
    const cs = await findMany('xg_assessment_events',
      { user_id: userId, counselor_id: _.neq(null) },
      { orderBy: 'session_no', orderDir: 'desc', limit: 20 });
    // 再按提交时间兜底
    if (!cs.length) {
      const cs2 = await findMany('xg_assessment_events', { user_id: userId }, { orderBy: 'submitted_at', orderDir: 'desc', limit: 50 });
      const hit = cs2.find((x) => x.counselor_id);
      counselorId = hit ? hit.counselor_id : null;
    } else {
      counselorId = cs[0].counselor_id;
    }
  }

  // 基线参照（补推重测优先）
  const bp = await findOne('xg_baseline_profile', { user_id: userId });
  const ref = bp ? (bp.state_total_recheck != null ? bp.state_total_recheck : bp.state_total) : null;

  const base = { user_id: userId, counselor_id: counselorId, triggered_at: nowIso() };

  // =========== 结果线 + 稳定化线（来访端）：仅 M1 ===========
  if (scale === 'xg_m1_state') {
    const rows = await findMany('xg_assessment_events',
      { user_id: userId, scale_code: 'xg_m1_state', status: 'submitted' },
      { orderBy: 'session_no', orderDir: 'desc', limit: Math.max(cFlatCons, cL3Cons, 20) });
    const recent = rows.filter((r) => r.session_no <= sessionNo)
      .sort((a, b) => b.session_no - a.session_no)
      .map((r) => r.total);
    const cnt = recent.length;

    let ok = 0;
    if (cnt >= cDropCons && ref != null) {
      for (let i = 0; i < cDropCons; i++) if (recent[i] - ref <= -cDropAbs) ok++;
    }

    if (ok === cDropCons) {
      let lv = 'L2', sev = 'warn';
      if (cnt >= cL3Cons && recent[0] < recent[1] && recent[1] < recent[2]) { lv = 'L3'; sev = 'urgent'; }
      if (cnt >= cL3Cons && (recent[0] - recent[1]) <= -cDropAbs && (recent[1] - recent[2]) <= 0) { lv = 'L3'; sev = 'urgent'; }
      if (ev.pct != null && ev.pct < cL3LowPct) { lv = 'L3'; sev = 'urgent'; }
      await put({
        ...base, event_id: eventId, alert_type: 'outcome', severity: sev, alert_level: lv,
        detail: { kind: 'declining', recent_totals: recent.slice(0, cL3Cons), ref_baseline: ref, drop_abs: cDropAbs, pct: ev.pct }
      });
    } else {
      let flat = 0;
      if (cnt >= cFlatCons && ref != null) {
        for (let i = 0; i < cFlatCons; i++) if (Math.abs(recent[i] - ref) < cFlatDelta) flat++;
      }
      if (flat === cFlatCons) {
        await put({
          ...base, event_id: eventId, alert_type: 'outcome', severity: 'warn', alert_level: 'L2',
          detail: { kind: 'no_change', recent_totals: recent.slice(0, cFlatCons), ref_baseline: ref, flat_delta: cFlatDelta }
        });
      } else {
        await put({
          ...base, event_id: eventId, alert_type: 'outcome', severity: 'info', alert_level: 'L1',
          detail: { kind: 'single_session', total: ev.total, pct: ev.pct, ref_baseline: ref }
        });
      }
    }

    // 稳定化线（选修 s8 存在且启用时；来访端）
    const s8 = await findOne('xg_scale_items', { code: 's8', is_active: true, is_optional: true });
    if (s8) {
      const srows = await findMany('xg_assessment_events',
        { user_id: userId, scale_code: 'xg_m1_state', status: 'submitted' },
        { orderBy: 'session_no', orderDir: 'desc', limit: 20 });
      const lastN = srows.filter((r) => r.session_no <= sessionNo)
        .sort((a, b) => b.session_no - a.session_no).slice(0, cStabCons);
      const bad = lastN.filter((r) => {
        const a = grabInt(r.raw_answers, 's8'), b = grabInt(r.raw_answers, 's9'), c = grabInt(r.raw_answers, 's10');
        return (a == null ? 10 : a) <= cStabItem || (b == null ? 10 : b) <= cStabItem || (c == null ? 10 : c) <= cStabItem;
      }).length;
      if (lastN.length >= cStabCons && bad === cStabCons) {
        await put({
          ...base, event_id: eventId, alert_type: 'stability', severity: 'warn', alert_level: 'L2',
          detail: { kind: 'self_report', threshold: cStabItem, consecutive: cStabCons }
        });
      }
    }
  }

  // =========== 联盟线 + 双向差异 + 稳定化线（咨询师端）：M2 / M3 ===========
  if (scale === 'xg_m2_feel' || scale === 'xg_m3_pro') {
    const feelEv = await findMany('xg_assessment_events',
      { user_id: userId, scale_code: 'xg_m2_feel', session_no: sessionNo, status: 'submitted' },
      { orderBy: 'submitted_at', orderDir: 'desc', limit: 1 });
    const vFeel = feelEv.length ? feelEv[0].total : null;
    const proEvs = await findMany('xg_assessment_events',
      { user_id: userId, scale_code: 'xg_m3_pro', session_no: sessionNo, status: 'submitted' },
      { orderBy: 'submitted_at', orderDir: 'desc', limit: 1 });
    const vPro = proEvs.length ? proEvs[0].total : null;
    const evPro = proEvs.length ? proEvs[0].id : null;

    // 联盟线只在感受卡提交时判定（挂来访端事件）
    if (scale === 'xg_m2_feel') {
      const frows = await findMany('xg_assessment_events',
        { user_id: userId, scale_code: 'xg_m2_feel', status: 'submitted' },
        { orderBy: 'session_no', orderDir: 'desc', limit: 20 });
      const lastN = frows.filter((r) => r.session_no <= sessionNo)
        .sort((a, b) => b.session_no - a.session_no).slice(0, cAllyCons);

      const lowTotal = lastN.length >= cAllyCons &&
        lastN.every((r) => (r.total == null ? 40 : r.total) <= cAllyTotal);
      if (lowTotal) {
        await put({
          ...base, event_id: eventId, alert_type: 'alliance', severity: 'warn', alert_level: 'L2',
          detail: { kind: 'low_total', feel_total: vFeel, threshold: cAllyTotal, consecutive: cAllyCons }
        });
      }
      const lowDim = lastN.length >= cAllyCons &&
        lastN.every((r) => ['f1', 'f2', 'f3', 'f4'].some((c) => {
          const v = grabInt(r.raw_answers, c);
          return (v == null ? 10 : v) <= cAllyDim;
        }));
      if (lowDim) {
        await put({
          ...base, event_id: eventId, alert_type: 'alliance', severity: 'warn', alert_level: 'L2',
          detail: { kind: 'low_dim', threshold: cAllyDim, consecutive: cAllyCons }
        });
      }
    }

    // 双向差异：两侧都已提交才判，固定挂该节 M3 事件
    if (vFeel != null && vPro != null && evPro) {
      const diff = Math.abs(Math.round((vFeel / 40) * 10000) / 100 - Math.round((vPro / 60) * 10000) / 100);
      if (diff >= cDiffPost) {
        await put({
          ...base, event_id: evPro, alert_type: 'alliance', severity: 'warn', alert_level: 'L2',
          detail: {
            kind: 'view_gap', diff_post: diff,
            feel_pct: Math.round((vFeel / 40) * 10000) / 100,
            pro_pct: Math.round((vPro / 60) * 10000) / 100,
            threshold: cDiffPost
          }
        });
      }
    }

    // 稳定化线（咨询师端 p4）
    if (scale === 'xg_m3_pro') {
      const s8 = await findOne('xg_scale_items', { code: 's8', is_active: true, is_optional: true });
      if (s8) {
        const prows = await findMany('xg_assessment_events',
          { user_id: userId, scale_code: 'xg_m3_pro', status: 'submitted' },
          { orderBy: 'session_no', orderDir: 'desc', limit: 20 });
        const lastN = prows.filter((r) => r.session_no <= sessionNo)
          .sort((a, b) => b.session_no - a.session_no).slice(0, cStabCons);
        const bad = lastN.filter((r) => {
          const v = grabInt(r.raw_answers, 'p4');
          return (v == null ? 10 : v) <= cStabItem;
        }).length;
        if (lastN.length >= cStabCons && bad === cStabCons) {
          await put({
            ...base, event_id: eventId, alert_type: 'stability', severity: 'warn', alert_level: 'L2',
            detail: { kind: 'counselor_rating', threshold: cStabItem, consecutive: cStabCons }
          });
        }
      }
    }
  }

  // =========== 解离线（安全线）：仅 M0 ===========
  if (scale === 'xg_m0_baseline' && bp && bp.dissoc_level === 2) {
    await put({
      ...base, event_id: eventId, alert_type: 'dissociation', severity: 'urgent', alert_level: 'L3',
      detail: { dissoc_level: 2, safety_line: true, note: '建议先做专业评估、暂缓深度工作' }
    });
  }

  // =========== 风险复查线（P1-B6 安全兜底）：恶化后 1 题极简再筛查 ===========
  // 定位：不是诊断，也不是准入层危机筛查的替代品——只在"过程内出现重度恶化"时
  // 补一次 1 题复查，阳性即转准入层危机流程 + 来访端承接资源。安全线，全阶段常开。
  if (scale === 'xg_risk_recheck') {
    const v = ev.total == null ? 0 : ev.total;
    if (v >= cRiskPos) {
      await put({
        ...base, event_id: eventId, alert_type: 'risk',
        severity: v >= cRiskUrgent ? 'urgent' : 'warn',
        alert_level: v >= cRiskUrgent ? 'L3' : 'L2',
        detail: {
          kind: 'process_recheck', value: v, safety_line: true,
          positive_min: cRiskPos, urgent_min: cRiskUrgent,
          note: '过程内风险复查阳性：转准入层危机流程，并向来访承接支持资源；平台不做临床判断'
        }
      });
    }
  }

  // =========== 组合判读（分数走低 ≠ 治疗出问题）==========
  if (scale === 'xg_m1_state') {
    const myAlerts = await findMany('xg_alerts', { user_id: userId, event_id: eventId });
    const outcomeL2 = myAlerts.find((a) => a.alert_type === 'outcome' && ['L2', 'L3'].includes(a.alert_level));
    if (outcomeL2) {
      const alliance = myAlerts.find((a) => a.alert_type === 'alliance');
      let combination = 'working_fluctuation';
      if (alliance && ['low_total', 'low_dim'].includes((alliance.detail || {}).kind)) {
        combination = 'real_deterioration';
      } else if (alliance) {
        combination = 'communication_gap';
      }
      const patch = { detail: { ...outcomeL2.detail, combination } };
      if (combination === 'working_fluctuation') {
        // 已达 L3 者保留 L3；否则降为 L1（工作性波动）
        patch.detail.note = '状态降+联盟稳：可能正在触及痛苦议题；已达 L3 者保留人工复核';
        if (outcomeL2.alert_level !== 'L3') { patch.alert_level = 'L1'; patch.severity = 'info'; }
      }
      await updateWhere('xg_alerts', { id: outcomeL2.id }, patch);
    }
  }
}

// ---------------------------------------------------------------------------
// 2.1 GET /scales — 拉取卡片与题目
// ---------------------------------------------------------------------------
async function handleScales(res, q) {
  const codes = (q.get('codes') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!codes.length) return xgError(res, 400, 'XG_BAD_PARAM', '缺少 codes 参数');
  const includeOptional = q.get('include_optional') === 'true';

  const scales = await findMany('xg_scales', { scale_code: _.in(codes), is_active: true }, { orderBy: 'sort_order' });
  if (!scales.length) return xgError(res, 404, 'XG_NOT_FOUND', '卡片不存在');
  const allItems = await findMany('xg_scale_items', { is_active: true }, { orderBy: 'sort_order' });

  const out = [];
  for (const sc of scales) {
    let items;
    if (sc.scale_code === 'xg_m0_baseline') {
      // 拼装规则：先取 xg_m1_state 的 s1–s7，再取 M0 的 b1–b3/r1/r2/d1
      const m1 = allItems.filter((i) => i.scale_code === 'xg_m1_state' && !i.is_optional && i.code !== 's8' && i.code !== 's9' && i.code !== 's10')
        .sort((a, b) => a.sort_order - b.sort_order);
      const m0 = allItems.filter((i) => i.scale_code === 'xg_m0_baseline')
        .sort((a, b) => a.sort_order - b.sort_order);
      items = [...m1, ...m0];
    } else if (sc.scale_code === 'xg_m1_state') {
      items = allItems.filter((i) => i.scale_code === 'xg_m1_state')
        .filter((i) => includeOptional || !i.is_optional)
        .sort((a, b) => a.sort_order - b.sort_order);
    } else {
      items = allItems.filter((i) => i.scale_code === sc.scale_code)
        .sort((a, b) => a.sort_order - b.sort_order);
    }

    out.push({
      scale_code: sc.scale_code,
      name: sc.name,
      phase: sc.phase,
      fill_role: sc.fill_role,
      timing: sc.timing,
      intro_text: sc.intro_text || null,
      item_count: sc.item_count,
      score_max: sc.score_max,
      sort_order: sc.sort_order,
      items: items.map((i) => ({
        code: i.code, label: i.label, dim: i.dim,
        text: (i.is_dynamic && i.dynamic_text) ? i.dynamic_text : i.text,
        anchor_low: i.anchor_low || null, anchor_high: i.anchor_high || null,
        item_type: i.item_type,
        options: Array.isArray(i.options)
          ? i.options.map((o) => ({ label: o.label, value: num(o.value) == null ? o.value : num(o.value) }))
          : null,
        is_optional: !!i.is_optional, is_dynamic: !!i.is_dynamic, dynamic_text: i.dynamic_text || null,
        sort_order: i.sort_order
      }))
    });
  }
  sendJson(res, 200, { scales: out });
}

// ---------------------------------------------------------------------------
// 2.2 GET /prompts/next — 本次该填哪些卡
// ---------------------------------------------------------------------------
async function handlePromptsNext(res, q, identity) {
  if (!requireRole(res, identity, ['visitor', 'counselor', 'admin'])) return;
  const userId = identity.role === 'visitor' ? identity.userId : q.get('user_id');
  if (!userId) return xgError(res, 400, 'XG_BAD_PARAM', '缺少 user_id');

  const sessionNo = Number(q.get('session_no') || 0);
  const prompts = [];
  const already = [];

  // 知情同意（assessment 范围）未签 → 不推任何卡
  if (!(await hasConsent(userId, 'assessment'))) {
    return sendJson(res, 200, { session_no: sessionNo, prompts: [], already_submitted: [], consent_required: true });
  }

  // 已判定「不在评估范围」（危机红线）→ 永久停推，只指向拒评页
  const scopeBlock = await findOne('xg_case_switch', { visitor_id: userId });
  if (scopeBlock && scopeBlock.out_of_scope === true) {
    return sendJson(res, 200, {
      session_no: sessionNo, prompts: [], already_submitted: [],
      out_of_scope: true,
      reason: scopeBlock.out_of_scope_reason || 'crisis_red_line',
      next_page: 'x1-out-of-scope.html'
    });
  }

  const m0 = await findMany('xg_assessment_events',
    { user_id: userId, scale_code: 'xg_m0_baseline', status: 'submitted' },
    { orderBy: 'submitted_at', orderDir: 'desc', limit: 1 });
  const endProfile = await findOne('xg_end_profile', { user_id: userId });
  const submittedNow = await findMany('xg_assessment_events',
    { user_id: userId, session_no: sessionNo, status: 'submitted' });
  submittedNow.forEach((e) => already.push(e.scale_code));

  const scaleMeta = {};
  (await findMany('xg_scales', { is_active: true })).forEach((s) => { scaleMeta[s.scale_code] = s; });
  const push = (code, reason) => {
    if (already.includes(code)) return;
    const m = scaleMeta[code];
    if (!m) return;
    prompts.push({ scale_code: code, fill_role: m.fill_role, reason });
  };

  if (endProfile && endProfile.closed_at) {
    // 已结案：只推随访
    const followDue = [];
    ['1m', '3m'].forEach((rd) => {
      const dueAt = endProfile['follow_' + rd + '_due_at'];
      const submitted = submittedNow.some((e) => e.scale_code === 'xg_m4_follow' && e.follow_round === rd);
      if (dueAt && new Date(dueAt) <= new Date() && !submitted) followDue.push(rd);
    });
    if (!followDue.length) {
      return sendJson(res, 200, { session_no: sessionNo, prompts: [], already_submitted: already, relation_closed: true });
    }
    followDue.forEach((rd) => {
      const submitted = submittedNow.some((e) => e.scale_code === 'xg_m4_follow' && e.follow_round === rd);
      if (!submitted) prompts.push({ scale_code: 'xg_m4_follow', fill_role: 'visitor', reason: 'followup_' + rd });
    });
    return sendJson(res, 200, { session_no: sessionNo, prompts, already_submitted: already });
  }

  if (!m0.length || sessionNo === 0) {
    push('xg_m0_baseline', 'baseline');
  } else if (sessionNo === 1) {
    // 首节不推状态卡：首节状态由基线卡承担
    push('xg_m2_feel', 'post_session');
    push('xg_m3_pro', 'post_session');
    // 距 M0 提交 > 7 天且 M1(session 1) 未提交 → 追加一次 M1（写 recheck 不覆盖原值）
    const m1s1 = await findOne('xg_assessment_events',
      { user_id: userId, scale_code: 'xg_m1_state', session_no: 1, status: 'submitted' });
    if (!m1s1 && daysBetween(m0[0].submitted_at, nowIso()) > LATE_RECHECK_DAYS) {
      push('xg_m1_state', 'late_recheck');
    }
  } else {
    push('xg_m1_state', 'pre_session');
    push('xg_m2_feel', 'post_session');
    push('xg_m3_pro', 'post_session');
  }

  // 过程内风险再筛查（P1-B6）：出现 outcome L3（重度恶化）→ 推 1 题风险复查
  // 冷却：距上次复查 ≥ risk_recheck_cooldown_sessions 节，避免每节重复问
  {
    const cfg = await getConfig();
    const cd = cfgInt(cfg, 'risk_recheck_cooldown_sessions', 2);
    const l3 = await findMany('xg_alerts',
      { user_id: userId, alert_type: 'outcome', alert_level: 'L3', status: 'open' }, { limit: 20 });
    if (l3.length) {
      const last = await findMany('xg_assessment_events',
        { user_id: userId, scale_code: 'xg_risk_recheck', status: 'submitted' },
        { orderBy: 'session_no', orderDir: 'desc', limit: 1 });
      const lastS = last.length ? last[0].session_no : -99;
      if (sessionNo - lastS >= cd) push('xg_risk_recheck', 'risk_recheck');
    }
  }

  sendJson(res, 200, { session_no: sessionNo, prompts, already_submitted: already });
}

// ---------------------------------------------------------------------------
// 2.3a POST /events/start
// ---------------------------------------------------------------------------
async function handleEventsStart(res, body, identity) {
  if (!requireRole(res, identity, ['visitor', 'counselor'])) return;
  const userId = identity.role === 'visitor' ? identity.userId : body.user_id;
  if (!userId) return xgError(res, 400, 'XG_BAD_PARAM', '缺少 user_id');
  const { client_event_id, scale_code, session_no, follow_round } = body;
  if (!client_event_id || !scale_code || session_no === undefined) {
    return xgError(res, 400, 'XG_BAD_PARAM', '缺少 client_event_id / scale_code / session_no');
  }
  const meta = await findOne('xg_scales', { scale_code });
  if (!meta) return xgError(res, 404, 'XG_NOT_FOUND', '卡片不存在：' + scale_code);

  // 前置校验知情同意
  if (!(await hasConsent(userId, scopeOfScale(scale_code)))) {
    return xgError(res, 409, 'XG_CONSENT_REQUIRED', '未签署知情同意');
  }

  // 幂等：同 client_event_id 返回首行
  const dup = await findOne('xg_assessment_events', { client_event_id });
  if (dup) {
    return sendJson(res, 201, { event_id: dup.id, status: dup.status, started_at: to08(dup.started_at), duplicated: true });
  }

  const now = nowIso();
  const doc = {
    id: uuid(), user_id: userId, role: identity.role,
    scale_code, session_no: Number(session_no), follow_round: follow_round || '',
    match_id: body.match_id || null,
    counselor_id: identity.role === 'counselor' ? identity.counselorId : (body.counselor_id || null),
    status: 'started', duration_ms: null, quality_flag: null, raw_answers: null,
    total: null, pct: null, ors_total: null, add_total: null, supp_total: null,
    resource_total: null, dissoc_level: null,
    client_event_id, started_at: now, submitted_at: null,
    created_at: now, updated_at: now
  };
  await insertOne('xg_assessment_events', doc);
  sendJson(res, 201, { event_id: doc.id, status: 'started', started_at: to08(now) });
}

// ---------------------------------------------------------------------------
// 2.3b POST /events/abandon
// ---------------------------------------------------------------------------
async function handleEventsAbandon(res, body, identity) {
  if (!requireRole(res, identity, ['visitor', 'counselor'])) return;
  const ev = await findOne('xg_assessment_events', { id: body.event_id });
  if (!ev) return xgError(res, 404, 'XG_NOT_FOUND', '记录不存在');
  if (ev.status === 'submitted' || ev.status === 'rejected') {
    return xgError(res, 409, 'XG_ALREADY_SUBMITTED', '该记录已提交，不可变更');
  }
  if (ev.status !== 'started') {
    return sendJson(res, 200, { event_id: ev.id, status: ev.status });
  }
  const dur = ev.started_at ? Date.now() - new Date(ev.started_at).getTime() : null;
  await updateWhere('xg_assessment_events', { id: ev.id }, { status: 'abandoned', duration_ms: dur });
  sendJson(res, 200, { event_id: ev.id, status: 'abandoned' });
}

// ---------------------------------------------------------------------------
// 2.3 POST /events — 提交答卷（幂等，7 步顺序）
// ---------------------------------------------------------------------------
async function handleEventsSubmit(res, body, identity) {
  if (!requireRole(res, identity, ['visitor', 'counselor'])) return;
  const userId = identity.role === 'visitor' ? identity.userId : body.user_id;
  if (!userId) return xgError(res, 400, 'XG_BAD_PARAM', '缺少 user_id');
  const { client_event_id, scale_code, session_no, answers, duration_ms } = body;
  const followRound = body.follow_round || '';
  if (!client_event_id || !scale_code || session_no === undefined || !answers) {
    return xgError(res, 400, 'XG_BAD_PARAM', '缺少 client_event_id / scale_code / session_no / answers');
  }
  const meta = await findOne('xg_scales', { scale_code });
  if (!meta) return xgError(res, 404, 'XG_NOT_FOUND', '卡片不存在：' + scale_code);

  // fill_role 校验：M3 只能咨询师填，来访卡不能咨询师代填
  if (meta.fill_role === 'counselor' && identity.role !== 'counselor') {
    return xgError(res, 403, 'XG_FORBIDDEN', '该卡片由咨询师填写');
  }

  // 0. 知情同意前置校验
  if (!(await hasConsent(userId, scopeOfScale(scale_code)))) {
    return xgError(res, 409, 'XG_CONSENT_REQUIRED', '未签署知情同意');
  }

  const items = await findMany('xg_scale_items', { scale_code: _.in([scale_code, 'xg_m1_state']), is_active: true });
  // M0 参数校验须覆盖拼装后的完整题集（s1–s7 归属 xg_m1_state，渲染时并入 M0）
  const itemsFor = scale_code === 'xg_m0_baseline'
    ? items.filter((i) => (i.scale_code === 'xg_m1_state' && !i.is_optional) || i.scale_code === 'xg_m0_baseline')
    : items.filter((i) => i.scale_code === scale_code);
  const optionalCount = itemsFor.filter((i) => i.is_optional && grabInt(answers, i.code) != null).length;

  // 1. 参数校验（不填补）
  try {
    for (const it of itemsFor) {
      if (it.is_optional && answers[it.code] === undefined) continue;
      if (it.item_type === 'slider') {
        const v = grabInt(answers, it.code);
        if (v === null) throw { code: 'XG_MISSING_ITEM', field: it.code };
        if (v < 0 || v > 10) throw { code: 'XG_VALUE_RANGE', field: it.code };
      } else if (it.item_type === 'single_choice') {
        const opts = (it.options || []).map((o) => o.value);
        if (answers[it.code] === undefined || answers[it.code] === null) throw { code: 'XG_MISSING_ITEM', field: it.code };
        if (!opts.includes(answers[it.code])) throw { code: 'XG_VALUE_RANGE', field: it.code };
      } else if (it.item_type === 'text') {
        if (typeof answers[it.code] !== 'string') throw { code: 'XG_MISSING_ITEM', field: it.code };
      }
    }
  } catch (ve) {
    // 带 event_id 的 started 行置 rejected 留痕
    if (body.event_id) {
      const st = await findOne('xg_assessment_events', { id: body.event_id });
      if (st && st.status === 'started') {
        await updateWhere('xg_assessment_events', { id: body.event_id }, { status: 'rejected' });
      }
    }
    return xgError(res, 422, ve.code || 'XG_BAD_PARAM',
      ve.code === 'XG_MISSING_ITEM' ? '缺少必答项' : '取值越界', ve.field);
  }

  // 2. 幂等：同 client_event_id → 返回首次结果
  const dup = await findOne('xg_assessment_events', { client_event_id });
  if (dup && (dup.status === 'submitted' || dup.status === 'rejected')) {
    return sendJson(res, 200, { event_id: dup.id, status: dup.status, duplicated: true });
  }
  // 部分唯一索引（API 层实现）：同 (user, card, session, round) 已 submitted/rejected
  const exist = await findMany('xg_assessment_events', {
    user_id: userId, scale_code, session_no: Number(session_no), follow_round: followRound,
    status: _.in(['submitted', 'rejected'])
  });
  if (exist.length) {
    return xgError(res, 409, 'XG_ALREADY_SUBMITTED', '该节该卡已提交');
  }

  // 3. 计分（唯一口径）
  let scores;
  try {
    scores = computeScores(scale_code, answers, optionalCount);
  } catch (ve) {
    if (body.event_id) {
      const st = await findOne('xg_assessment_events', { id: body.event_id });
      if (st && st.status === 'started') await updateWhere('xg_assessment_events', { id: body.event_id }, { status: 'rejected' });
    }
    return xgError(res, 422, ve.code || 'XG_BAD_PARAM', ve.code === 'XG_MISSING_ITEM' ? '缺少必答项' : '取值越界', ve.field);
  }

  // 质量标记
  const itemCount = itemsFor.filter((i) => !i.is_optional || answers[i.code] !== undefined).length;
  const vals = Object.values(answers).filter((v) => typeof v === 'number');
  const variance0 = vals.length > 1 && vals.every((v) => v === vals[0]);
  const qualityFlag = (duration_ms != null && duration_ms < itemCount * 5000) || variance0 ? 'low' : 'ok';

  // 4. 落库
  const now = nowIso();
  let eventId = body.event_id || null;
  let reused = false;
  if (eventId) {
    const st = await findOne('xg_assessment_events', { id: eventId });
    if (st && st.status === 'started') {
      reused = true;
      await updateWhere('xg_assessment_events', { id: eventId }, {
        status: 'submitted', submitted_at: now, duration_ms: duration_ms || null,
        quality_flag: qualityFlag, raw_answers: answers,
        total: scores.total, pct: scores.pct, ors_total: scores.ors_total,
        add_total: scores.add_total, supp_total: scores.supp_total,
        resource_total: scores.resource_total, dissoc_level: scores.dissoc_level,
        match_id: body.match_id || st.match_id || null,
        counselor_id: identity.role === 'counselor' ? identity.counselorId : (st.counselor_id || body.counselor_id || null)
      });
    } else {
      eventId = null;
    }
  }
  if (!reused) {
    eventId = uuid();
    await insertOne('xg_assessment_events', {
      id: eventId, user_id: userId, role: identity.role,
      scale_code, session_no: Number(session_no), follow_round: followRound,
      match_id: body.match_id || null,
      counselor_id: identity.role === 'counselor' ? identity.counselorId : (body.counselor_id || null),
      status: 'submitted', duration_ms: duration_ms || null, quality_flag: qualityFlag,
      raw_answers: answers,
      total: scores.total, pct: scores.pct, ors_total: scores.ors_total,
      add_total: scores.add_total, supp_total: scores.supp_total,
      resource_total: scores.resource_total, dissoc_level: scores.dissoc_level,
      client_event_id, started_at: body.started_at || now, submitted_at: now,
      created_at: now, updated_at: now
    });
  }

  // 档案回写
  if (scale_code === 'xg_m0_baseline') {
    const riskRow = await findOne('assessments', { view_token: userId });
    const riskLevel = riskRow && riskRow.crisis_level === 'active' ? 'block'
      : riskRow && riskRow.crisis_level === 'passive' ? 'watch' : 'normal';
    const existing = await findOne('xg_baseline_profile', { user_id: userId });
    const doc = {
      user_id: userId,
      state_total: existing ? existing.state_total : scores.total,
      state_total_recheck: existing ? existing.state_total_recheck : null,
      baseline_source: existing ? existing.baseline_source : 'normal',
      ors_total: scores.ors_total, add_total: scores.add_total,
      supp_total: scores.supp_total, resource_total: scores.resource_total,
      dissoc_level: scores.dissoc_level,
      risk_level: existing ? existing.risk_level : riskLevel,
      focus_text: existing ? existing.focus_text : null,
      tags: existing ? existing.tags : null
    };
    if (existing) await updateWhere('xg_baseline_profile', { user_id: userId }, doc);
    else await insertOne('xg_baseline_profile', { ...doc, created_at: now, updated_at: now });
  }

  if (scale_code === 'xg_m1_state' && Number(session_no) === 1) {
    const m0 = await findMany('xg_assessment_events',
      { user_id: userId, scale_code: 'xg_m0_baseline', status: 'submitted' },
      { orderBy: 'submitted_at', orderDir: 'desc', limit: 1 });
    const bp = await findOne('xg_baseline_profile', { user_id: userId });
    if (m0.length && bp && daysBetween(m0[0].submitted_at, now) > LATE_RECHECK_DAYS) {
      // 基线补推特例：写 recheck，不覆盖原值
      await updateWhere('xg_baseline_profile', { user_id: userId },
        { state_total_recheck: scores.total, baseline_source: 'late_recheck' });
    }
  }

  if (scale_code === 'xg_m4_end' || scale_code === 'xg_m4_eval' || scale_code === 'xg_m4_follow') {
    const ep = await findOne('xg_end_profile', { user_id: userId });
    const patch = {};
    if (scale_code === 'xg_m4_end') {
      patch.end_total = scores.total; patch.supp_end_total = scores.supp_total;
      patch.counselor_id = identity.role === 'counselor' ? identity.counselorId : undefined;
    } else if (scale_code === 'xg_m4_eval') {
      patch.eval_total = scores.total; patch.end_open = answers.o1 || null;
      patch.recommend = grabInt(answers, 'v3');
    } else {
      const key = followRound === '3m' ? '3m' : '1m';
      patch['follow_' + key + '_total'] = scores.total;
      patch['supp_follow_' + key + '_total'] = scores.supp_total;
    }
    if (ep) await updateWhere('xg_end_profile', { user_id: userId }, patch);
    else await insertOne('xg_end_profile', {
      user_id: userId, match_id: body.match_id || null,
      counselor_id: identity.role === 'counselor' ? identity.counselorId : null,
      ...patch, closed_at: null,
      follow_1m_due_at: null, follow_3m_due_at: null,
      follow_1m_sent_at: null, follow_3m_sent_at: null,
      follow_1m_result: null, follow_3m_result: null,
      notify_channel: 'miniprogram', created_at: now, updated_at: now
    });
  }

  // 5. 预警判定（永远执行，与开关无关）
  try {
    await evaluateAlerts(userId, eventId, Number(session_no));
  } catch (e) {
    console.error('evaluateAlerts failed:', e);
  }

  // 6. 异步投递 LLM 任务（失败不影响提交；阶段一仅落 pending）
  if (['xg_m1_state', 'xg_m2_feel', 'xg_m3_pro'].includes(scale_code)) {
    try {
      const jobExist = await findOne('xg_llm_jobs', { event_id: eventId });
      if (!jobExist) {
        await insertOne('xg_llm_jobs', {
          id: uuid(), event_id: eventId, status: 'pending',
          request: { scale_code, session_no: Number(session_no), raw_answers: answers },
          response: null, attempts: 0, last_error: null,
          created_at: now, updated_at: now
        });
      }
    } catch (e) { console.error('llm job enqueue failed:', e); }
  }

  // 6.5 过程中红线：风险复查达紧急线 → 立即中止评估、转医疗
  // 口径（2026-10-20 定）：来访在四评过程中暴露急性风险时，当次填卡立即中止，
  // 后续不再推卡，个案标记 out_of_scope；同时写一条安全线告警（risk 线常开，
  // 咨询师收件箱必见），由咨询师跟进确认安全。来访端不给任何分数、不做判断。
  let outOfScope = false;
  if (scale_code === 'xg_risk_recheck') {
    const cfgR = await getConfig();
    const urgentMin = cfgInt(cfgR, 'risk_recheck_urgent_min', 10);
    if ((grabInt(answers, 'k1') || 0) >= urgentMin) {
      outOfScope = true;
      const evRow = await findOne('xg_assessment_events', { id: eventId });
      const matchId = body.match_id || (evRow && evRow.match_id) || null;
      if (matchId) {
        await updateWhere('xg_case_switch', { match_id: matchId }, {
          out_of_scope: true, out_of_scope_reason: 'risk_recheck_red_line',
          out_of_scope_scale: scale_code, out_of_scope_session: Number(session_no),
          out_of_scope_at: now
        });
      }
      const csRow = matchId ? await findOne('xg_case_switch', { match_id: matchId }) : null;
      await upsertAlert({
        user_id: userId, match_id: matchId,
        counselor_id: (evRow && evRow.counselor_id) || (csRow && csRow.counselor_id) || null,
        event_id: eventId, alert_type: 'risk', severity: 'urgent', alert_level: 'L3',
        title: '来访已中止评估：风险筛查提示需优先医疗评估',
        body: '风险复查达到紧急线。按服务边界，该个案已判定为不在本工具评估范围，已停止推卡并引导就医。请尽快联系来访确认安全。',
        detail: { out_of_scope: true, reason: 'risk_recheck_red_line', session_no: Number(session_no) },
        session_no: Number(session_no)
      });
      // upsert 默认只合并 detail（同 event_id 已存在时不会覆盖标题/归属）；
      // 这里强制补写，确保咨询师收件箱拿到的是「已中止评估」而不是一条普通风险预警
      const written = await findOne('xg_alerts', { user_id: userId, alert_type: 'risk', event_id: eventId });
      if (written) {
        await updateWhere('xg_alerts', { id: written.id }, {
          match_id: matchId, severity: 'urgent', alert_level: 'L3',
          title: '来访已中止评估：风险筛查提示需优先医疗评估',
          body: '风险复查达到紧急线。按服务边界，该个案已判定为不在本工具评估范围，已停止推卡并引导就医。请尽快联系来访确认安全。'
        });
      }
    }
  }

  // 7. 返回：按角色裁剪（来访端不含分数）
  if (identity.role === 'visitor') {
    const resp = {
      event_id: eventId, scale_code, status: 'submitted', saved: true,
      visitor_view: { message: '已记下，谢谢你照实说。' }
    };
    if (outOfScope) {
      resp.out_of_scope = true;
      resp.next_page = 'x1-out-of-scope.html';
      return sendJson(res, 201, resp);
    }
    // 风险复查阳性 → 来访端承接支持资源（不给分数、不做判断）
    if (scale_code === 'xg_risk_recheck') {
      const c = await getConfig();
      const pos = cfgInt(c, 'risk_recheck_positive_min', 5);
      if ((scores.total || 0) >= pos) {
        resp.support = {
          message: '你刚才说的这些，有人能马上接住你。',
          hotlines: [
            { name: '全国心理援助热线', number: '12356' },
            { name: '青少年心理咨询热线', number: '12355' }
          ],
          note: '如果现在很难受，可以先打一个电话；也可以告诉你的咨询师。'
        };
      }
    }
    return sendJson(res, 201, resp);
  }
  const resp = { event_id: eventId, scale_code, status: 'submitted', saved: true, total: scores.total, pct: scores.pct };
  if (outOfScope) { resp.out_of_scope = true; resp.next_page = 'x1-out-of-scope.html'; }
  if (scale_code === 'xg_m0_baseline' || scale_code === 'xg_m1_state') {
    resp.ors_total = scores.ors_total; resp.add_total = scores.add_total;
  }
  sendJson(res, 201, resp);
}

// ---------------------------------------------------------------------------
// 2.4 GET /events
// ---------------------------------------------------------------------------
async function handleGetEvents(res, q, identity) {
  if (!requireRole(res, identity, ['visitor', 'counselor', 'admin'])) return;
  const limit = Math.min(Number(q.get('limit') || 50), 200);
  const offset = Number(q.get('offset') || 0);
  let where = {};
  let stripScores = false;

  if (identity.role === 'visitor') {
    where = { user_id: identity.userId };
    stripScores = true;
  } else if (identity.role === 'counselor') {
    if (q.get('user_id')) {
      if (!(await counselorCanAccessUser(identity.counselorId, q.get('user_id')))) {
        return xgError(res, 403, 'XG_FORBIDDEN', '无权查看该来访');
      }
      where = { user_id: q.get('user_id') };
    } else if (q.get('match_id')) where = { match_id: q.get('match_id') };
    else return xgError(res, 400, 'XG_BAD_PARAM', '咨询师查询须带 user_id 或 match_id');
  } else {
    if (q.get('user_id')) where.user_id = q.get('user_id');
  }
  if (q.get('scale_code')) where.scale_code = q.get('scale_code');
  const sn = q.get('session_no');
  if (sn !== null && sn !== '') where.session_no = Number(sn);
  if (q.get('follow_round')) where.follow_round = q.get('follow_round');

  const rows = await findMany('xg_assessment_events', where,
    { orderBy: 'submitted_at', orderDir: 'desc', limit: limit + offset + 50 });
  const page = rows.slice(offset, offset + limit).map((e) => {
    const item = {
      id: e.id, scale_code: e.scale_code, session_no: e.session_no, follow_round: e.follow_round,
      status: e.status, quality_flag: e.quality_flag, submitted_at: to08(e.submitted_at)
    };
    if (!stripScores && e.status === 'submitted') {
      item.total = e.total; item.pct = e.pct;
      item.ors_total = e.ors_total; item.add_total = e.add_total; item.supp_total = e.supp_total;
    }
    return item;
  });
  sendJson(res, 200, { events: page });
}

// 咨询师对某来访的可见性：有 counselor_id=self 的事件，或其事件的 match 建有本案开关，或有归属告警
async function counselorCanAccessUser(counselorId, userId) {
  if(!/^asid-[0-9a-f-]{36}$/i.test(userId||''))return false;
  const a=await findOne('assessments',{id:userId.slice(5)});
  return !!a && a.match_request_cid===counselorId && ['approved','contacted'].includes(a.match_request_status);
}
function counselororIdSafe(id) { return id || '__none__'; }

// ---------------------------------------------------------------------------
// 2.5 GET /trend — 逐节曲线（咨询师/管理员）
// ---------------------------------------------------------------------------
async function handleTrend(res, q, identity) {
  if (!requireRole(res, identity, ['counselor', 'admin'])) return;
  const userId = q.get('user_id');
  if (!userId) return xgError(res, 400, 'XG_BAD_PARAM', '缺少 user_id');
  const scaleCode = q.get('scale_code') || 'xg_m1_state';
  const fromS = Number(q.get('from_session') || 0);
  const toS = q.get('to_session') ? Number(q.get('to_session')) : Infinity;

  if (identity.role === 'counselor' && !(await counselorCanAccessUser(identity.counselorId, userId))) {
    return xgError(res, 403, 'XG_FORBIDDEN', '无权查看该来访');
  }

  const bp = await findOne('xg_baseline_profile', { user_id: userId });
  const ref = bp ? (bp.state_total_recheck != null ? bp.state_total_recheck : bp.state_total) : null;

  const rows = (await findMany('xg_assessment_events',
    { user_id: userId, scale_code: scaleCode, status: 'submitted' },
    { orderBy: 'session_no', limit: 200 }))
    .filter((e) => e.session_no >= fromS && e.session_no <= toS)
    .sort((a, b) => a.session_no - b.session_no);

  // 预期恢复曲线（P1-B8）：按起始严重度分层设"应有进度"，取代绝对阈值。
  // 阶段一默认关闭（需 ≥150 样本校准斜率），结构先落地，校准后开开关即可生效。
  const cfg = await getConfig();
  const curveOn = false; // User-confirmed: expected recovery curve remains disabled.
  let curveMeta = { enabled: false };
  let slope = null, tolerance = cfgInt(cfg, 'expected_curve_tolerance', 5);
  if (curveOn && ref != null) {
    const bands = Array.isArray(cfg.expected_curve_bands) ? cfg.expected_curve_bands : [];
    const basePct = bp && bp.state_pct != null ? bp.state_pct : (ref / 70) * 100;
    const band = bands.find((b) => basePct <= (num(b.pct_max) == null ? Infinity : num(b.pct_max)))
      || bands[bands.length - 1];
    slope = band ? num(band.per_session) : null;
    curveMeta = {
      enabled: true,
      version: cfgStr(cfg, 'expected_curve_version', 'v0-uncalibrated'),
      baseline_pct: Math.round(basePct * 100) / 100,
      per_session_expected: slope, tolerance
    };
  }

  const points = rows.map((e, i) => {
    const p = {
      session_no: e.session_no, total: e.total, pct: e.pct, ors_total: e.ors_total,
      delta_vs_baseline: ref != null ? e.total - ref : null,
      delta_vs_prev: i > 0 ? e.total - rows[i - 1].total : null
    };
    if (curveOn && ref != null && slope != null) {
      p.expected_total = Math.round((ref + slope * (i + 1)) * 100) / 100;
      p.deviation = e.total != null ? Math.round((e.total - p.expected_total) * 100) / 100 : null;
      p.below_expected = p.deviation != null && p.deviation <= -tolerance;
    }
    return p;
  });
  sendJson(res, 200, { points, expected_curve: curveMeta });
}

// ---------------------------------------------------------------------------
// 2.6 GET /person-compare — 全人同维对比
// ---------------------------------------------------------------------------
async function handlePersonCompare(res, q, identity) {
  if (!requireRole(res, identity, ['counselor', 'admin'])) return;
  const userId = q.get('user_id');
  if (!userId) return xgError(res, 400, 'XG_BAD_PARAM', '缺少 user_id');
  if (identity.role === 'counselor' && !(await counselorCanAccessUser(identity.counselorId, userId))) {
    return xgError(res, 403, 'XG_FORBIDDEN', '无权查看该来访');
  }
  const bp = await findOne('xg_baseline_profile', { user_id: userId });
  const ep = await findOne('xg_end_profile', { user_id: userId });
  const f1 = await findOne('xg_assessment_events', { user_id: userId, scale_code: 'xg_m4_follow', follow_round: '1m', status: 'submitted' });
  const f3 = await findOne('xg_assessment_events', { user_id: userId, scale_code: 'xg_m4_follow', follow_round: '3m', status: 'submitted' });
  sendJson(res, 200, {
    baseline: bp ? {
      state: bp.state_total_recheck != null ? bp.state_total_recheck : bp.state_total,
      ors: bp.ors_total, supp: bp.supp_total
    } : null,
    end: ep ? { total: ep.end_total, supp: ep.supp_end_total } : null,
    follow_1m: f1 ? { total: f1.total, supp: f1.supp_total } : null,
    follow_3m: f3 ? { total: f3.total, supp: f3.supp_total } : null
  });
}

// ---------------------------------------------------------------------------
// 2.7 GET /counselor/inbox — 待处理提醒（阶段控制 + 单案开关）
// ---------------------------------------------------------------------------
const SUGGEST_SAFE = {
  outcome: '这几节的数据值得一起看看',
  stability: '这段的稳定度值得留意，可与来访核对',
  alliance: '与来访的配合方式值得当面聊一聊',
  dissociation: '建议先做专业评估，暂缓深度工作',
  risk: '来访在过程内风险复查中给出阳性回答，请按危机流程处理并核对支持资源'
};

async function handleInbox(res, q, identity) {
  if (!requireRole(res, identity, ['counselor'])) return;
  const cfg = await getConfig();
  const globalOn = cfg.enable_reminder === true;
  let where = { counselor_id: identity.counselorId };
  if (q.get('status')) where.status = q.get('status');
  if (q.get('alert_type')) where.alert_type = q.get('alert_type');
  const alerts = await findMany('xg_alerts', where,
    { orderBy: 'triggered_at', orderDir: 'desc', limit: 100 });

  // 单案开关映射 match_id → enable_reminder
  const switches = await findMany('xg_case_switch', { counselor_id: identity.counselorId });
  const swMap = {};
  switches.forEach((s) => { swMap[s.match_id] = s.enable_reminder === true; });

  // 悬空告警补齐（安全线兜底）：
  // 告警生成时来访尚未绑定咨询师 → counselor_id 为空；之后本案建立了 case_switch，
  // 这些告警必须能被该咨询师看到（dissociation 安全线尤其不能漏）
  const myMatches = switches.map((s) => s.match_id).filter(Boolean);
  if (myMatches.length) {
    const evs = await findMany('xg_assessment_events', { match_id: _.in(myMatches) }, { limit: 300 });
    const evIds = evs.map((e) => e.id);
    if (evIds.length) {
      const orphan = await findMany('xg_alerts', { event_id: _.in(evIds) }, { limit: 300 });
      for (const a of orphan) {
        if (a.counselor_id === identity.counselorId) continue;
        if (!alerts.some((x) => x.id === a.id)) {
          alerts.push(a);
          // 自愈回写，后续查询走主路径
          if (!a.counselor_id) {
            updateWhere('xg_alerts', { id: a.id }, { counselor_id: identity.counselorId }).catch(() => {});
          }
        }
      }
    }
  }

  const items = [];
  for (const a of alerts) {
    // 安全线：解离 + 过程内风险复查，任何阶段、任何开关状态都返回
    const isSafety = a.alert_type === 'dissociation' || a.alert_type === 'risk';
    const ev = await findOne('xg_assessment_events', { id: a.event_id });
    const caseOn = ev && ev.match_id ? swMap[ev.match_id] === true : false;
    // 阶段控制：全局关且单案关 → 只返回 L1 + 安全线；L3 仅全局 on
    if (!isSafety) {
      if (a.alert_level === 'L2' && !globalOn && !caseOn) continue;
      if (a.alert_level === 'L3' && !globalOn) continue;
    }
    const det = a.detail || {};
    const scopeOut = det.out_of_scope === true;
    items.push({
      alert_id: a.id,
      user_alias: '来访 #' + String(a.user_id).slice(0, 4).toUpperCase(),
      session_no: ev ? ev.session_no : null,
      alert_type: a.alert_type, severity: a.severity, alert_level: a.alert_level,
      triggered_at: to08(a.triggered_at),
      detail: a.detail,
      // 不在评估范围（危机红线）：顶层标记，咨询师端要做显著区分，不能当普通预警处理
      out_of_scope: scopeOut,
      scope_reason: scopeOut ? (det.reason || 'crisis_red_line') : null,
      cst: {
        required: ['L2', 'L3'].includes(a.alert_level),
        steps: ['① 核对：是否漏填、误解题，或外部事件', '② 当面一起看：与来访共同看', '③ 调整：改目标/频率/方法，必要时转介']
      },
      suggest_text: scopeOut
        ? '该个案已判定为「不在本工具评估范围」，已停止推卡并引导就医。请尽快联系来访确认安全。'
        : (SUGGEST_SAFE[a.alert_type] || '这条记录值得查看')
    });
  }
  sendJson(res, 200, { items });
}

// ---------------------------------------------------------------------------
// 2.8 / 2.9 alerts ack / cst
// ---------------------------------------------------------------------------
async function handleAlertAck(res, alertId, body, identity) {
  if (!requireRole(res, identity, ['counselor', 'admin'])) return;
  const a = await findOne('xg_alerts', { id: alertId });
  if (!a) return xgError(res, 404, 'XG_NOT_FOUND', '记录不存在');
  if (identity.role === 'counselor' && a.counselor_id !== identity.counselorId) {
    return xgError(res, 403, 'XG_FORBIDDEN', '无权操作该记录');
  }
  await updateWhere('xg_alerts', { id: alertId }, { status: 'acked', handled_at: nowIso() });
  sendJson(res, 200, { alert_id: alertId, status: 'acked', handled_at: to08(nowIso()) });
}

async function handleAlertCst(res, alertId, body, identity) {
  if (!requireRole(res, identity, ['counselor', 'admin'])) return;
  const a = await findOne('xg_alerts', { id: alertId });
  if (!a) return xgError(res, 404, 'XG_NOT_FOUND', '记录不存在');
  if (identity.role === 'counselor' && a.counselor_id !== identity.counselorId) {
    return xgError(res, 403, 'XG_FORBIDDEN', '无权操作该记录');
  }
  if (!body.cst_step || ![1, 2, 3].includes(Number(body.cst_step))) {
    return xgError(res, 400, 'XG_BAD_PARAM', 'cst_step 须为 1/2/3');
  }
  const patch = { cst_step: Number(body.cst_step), cst_note: body.cst_note || null };
  if (body.close) { patch.status = 'closed'; patch.handled_at = nowIso(); }
  await updateWhere('xg_alerts', { id: alertId }, patch);
  sendJson(res, 200, {
    alert_id: alertId, cst_step: Number(body.cst_step),
    status: body.close ? 'closed' : (a.status === 'open' ? 'open' : a.status),
    handled_at: body.close ? to08(nowIso()) : to08(a.handled_at)
  });
}

// ---------------------------------------------------------------------------
// 2.10b GET/POST /case-switch — 单案开关（仅 L2）
// ---------------------------------------------------------------------------
async function handleCaseSwitchGet(res, q, identity) {
  if (!requireRole(res, identity, ['counselor', 'admin'])) return;
  const matchId = q.get('match_id');
  if (!matchId) return xgError(res, 400, 'XG_BAD_PARAM', '缺少 match_id');
  const s = await findOne('xg_case_switch', { match_id: matchId });
  if (!s) return sendJson(res, 200, { match_id: matchId, enable_reminder: false, enable_cst: false, updated_at: null });
  if (identity.role === 'counselor' && s.counselor_id !== identity.counselorId) {
    return xgError(res, 403, 'XG_FORBIDDEN', '无权查看该案');
  }
  sendJson(res, 200, {
    match_id: s.match_id, enable_reminder: s.enable_reminder === true,
    enable_cst: s.enable_cst === true, updated_at: to08(s.updated_at)
  });
}

async function handleCaseSwitchPost(res, body, identity) {
  if (!requireRole(res, identity, ['counselor'])) return;
  const { match_id } = body;
  if (!match_id) return xgError(res, 400, 'XG_BAD_PARAM', '缺少 match_id');
  const enableReminder = body.enable_reminder === true;
  const enableCst = body.enable_cst === true;
  const s = await findOne('xg_case_switch', { match_id });
  if (s) {
    if (s.counselor_id !== identity.counselorId) return xgError(res, 403, 'XG_FORBIDDEN', '无权操作该案');
    await updateWhere('xg_case_switch', { match_id }, {
      enable_reminder: enableReminder, enable_cst: enableCst, updated_by: identity.counselorId
    });
  } else {
    await insertOne('xg_case_switch', {
      match_id, counselor_id: identity.counselorId, visitor_id: body.visitor_id || null,
      enable_reminder: enableReminder, enable_cst: enableCst,
      updated_by: identity.counselorId, created_at: nowIso(), updated_at: nowIso()
    });
  }
  sendJson(res, 200, { match_id, enable_reminder: enableReminder, enable_cst: enableCst });
}

// ---------------------------------------------------------------------------
// 2.9b POST /bridge/enter（匿名；原问卷 → 四评 的唯一入口）
//   凭原问卷评估号 ASID 进入四评。一次调用完成四件事：
//   ① 校验 ASID 真实存在于 assessments（只有真填过问卷的人才能进，防刷号）
//   ② 建立/复用来访身份（visitor_users：id=asid-<asid>，openid=asid:<asid>）
//   ③ 生成并固定 match_id（已存在则复用，保证同一评估号永远同一个案号）
//   ④ 建 xg_case_switch + 回写 assessments.match_id（打通两套数据）
// ---------------------------------------------------------------------------
// 只做「看起来像评估号」的宽松校验（历史数据里存在 debug-assessment-001 这类非 UUID 的 id）；
// 真正的门槛是下一步的「必须在 assessments 中存在」，防刷靠存在性而非格式。
const ASID_RE = /^[A-Za-z0-9_-]{8,64}$/;

async function handleBridgeEnter(res, body) {
  const asid = String((body && body.asid) || '').trim();
  if (!ASID_RE.test(asid)) return xgError(res, 422, 'XG_BAD_PARAM', 'asid 不是合法的评估号');

  const a = await findOne('assessments', { id: asid });
  if (!a) return xgError(res, 404, 'XG_ASID_NOT_FOUND', '未找到该评估号，请先完成评估');

  // 红线判定（专业口径 2026-10-20 定）：
  // 四评是「咨询过程评估」工具，不承担危机处置。原问卷危机筛查命中
  // active（有具体想法或计划）/ action（近期有过自伤行为）时，属于
  //「明确拒绝评估、建议医疗评估优先」的范围 —— 不建来访身份、不建个案、
  // 不推任何卡，只返回 out_of_scope 让前端走拒评页。
  // 档位沿用老版本 checkCrisis()：active + action 才判红线；
  // passive（消极念头但无计划）不拦，仍可进入四评。
  const crisisLevel = String(a.crisis_level || a.crisisLevel || '').trim();
  if (['active', 'action'].includes(crisisLevel)) {
    if (a.xg_scope_status !== 'out_of_scope') {
      await updateWhere('assessments', { id: asid }, {
        xg_scope_status: 'out_of_scope', xg_scope_reason: 'crisis_red_line',
        xg_scope_level: crisisLevel, xg_scope_at: nowIso()
      });
    }
    return sendJson(res, 200, {
      out_of_scope: true, reason: 'crisis_red_line', crisis_level: crisisLevel,
      next_page: 'x1-out-of-scope.html',
      message: '当前情况不在本工具的评估范围内，建议优先进行医疗/精神科评估。'
    });
  }

  if(!/^[0-9a-f-]{36}$/i.test(asid)||a.view_token!==asid)return xgError(res,403,'XG_FORBIDDEN','请使用完整评估凭证');
  if(!['approved','contacted'].includes(a.match_request_status)||!a.match_id||!a.match_request_cid)return xgError(res,409,'XG_APPROVAL_REQUIRED','请先完成匹配审核');
  const approvedCounselor=await findOne('counselors',{id:a.match_request_cid});
  if(!approvedCounselor||approvedCounselor.is_active!==true||approvedCounselor.review_status!=='approved')return xgError(res,409,'XG_APPROVAL_REQUIRED','咨询师状态需要重新审核');

  // ② 来访身份（幂等）
  const visitorId = 'asid-' + asid;
  const openid = 'asid:' + asid;
  let v = await findOne('visitor_users', _.or([{ id: visitorId }, { openid }]));
  if (!v) {
    await insertOne('visitor_users', {
      id: visitorId, openid,
      nickname: (a.visitor_name && String(a.visitor_name).trim()) || '来访者',
      source: 'assessment', asid, created_at: nowIso()
    });
  }

  // ③ match_id（稳定：一旦生成永不变）
  let matchId = a.match_id || null;
  if (!matchId) {
    const cid = a.selected_counselor_id || a.match_request_cid || '';
    matchId = 'mk-' + asid.slice(0, 8) + (cid ? '-' + String(cid).slice(0, 8) : '');
  }
  const counselorId = a.match_request_cid;

  // ④ 个案开关（幂等）
  const cs = await findOne('xg_case_switch', { match_id: matchId });
  if(cs && (cs.counselor_id!==counselorId||cs.visitor_id!==visitorId))return xgError(res,409,'XG_SCOPE_MISMATCH','周期归属不一致，请由管理员核对');
  if (!cs) {
    await insertOne('xg_case_switch', {
      match_id: matchId, counselor_id: counselorId, visitor_id: visitorId,
      enable_reminder: false, enable_cst: false,
      updated_by: 'bridge', created_at: nowIso(), updated_at: nowIso()
    });
  }

  if (a.match_id !== matchId) {
    await updateWhere('assessments', { id: asid }, { match_id: matchId });
  }

  const consent = await findOne('xg_consent', { user_id: visitorId });
  const hasConsent = !!(consent && (consent.agreed === true || consent.agreed === 'true'));

  sendJson(res, 200, {
    asid,
    visitor_id: visitorId,
    visitor_token: visitorId,
    match_id: matchId,
    counselor_id: counselorId,
    has_consent: hasConsent,
    next_page: hasConsent ? 'v2-prompts.html' : 'v1-consent.html',
    next_scale: hasConsent ? null : 'xg_m0_baseline'
  });
}

// ---------------------------------------------------------------------------
// 2.10 POST /m4/close（service）
// ---------------------------------------------------------------------------
async function handleM4Close(res, body, identity) {
  if (identity.role !== 'service') return xgError(res, 401, 'XG_UNAUTHORIZED', '须系统令牌');
  const { match_id, user_id, counselor_id, closed_at } = body;
  if (!match_id || !user_id) return xgError(res, 400, 'XG_BAD_PARAM', '缺少 match_id / user_id');
  const closedAt = closed_at || nowIso();
  const d1 = new Date(closedAt); d1.setMonth(d1.getMonth() + 1);
  const d3 = new Date(closedAt); d3.setMonth(d3.getMonth() + 3);
  const ep = await findOne('xg_end_profile', { user_id });
  const patch = {
    match_id, counselor_id: counselor_id || (ep ? ep.counselor_id : null),
    closed_at: closedAt,
    follow_1m_due_at: d1.toISOString(), follow_3m_due_at: d3.toISOString()
  };
  if (ep) await updateWhere('xg_end_profile', { user_id }, patch);
  else await insertOne('xg_end_profile', {
    user_id, ...patch,
    end_total: null, eval_total: null, end_open: null, supp_end_total: null,
    follow_1m_total: null, follow_3m_total: null,
    supp_follow_1m_total: null, supp_follow_3m_total: null, recommend: null,
    follow_1m_sent_at: null, follow_3m_sent_at: null,
    follow_1m_result: null, follow_3m_result: null,
    notify_channel: 'miniprogram', created_at: nowIso(), updated_at: nowIso()
  });
  sendJson(res, 201, {
    ok: true, follow_scheduled: ['1m', '3m'],
    follow_1m_due_at: to08(d1.toISOString()), follow_3m_due_at: to08(d3.toISOString())
  });
}

// ---------------------------------------------------------------------------
// 2.11 POST /jobs/follow-dispatch（service）
// ---------------------------------------------------------------------------
async function handleFollowDispatch(res, identity) {
  if (identity.role !== 'service') return xgError(res, 401, 'XG_UNAUTHORIZED', '须系统令牌');
  const now = nowIso();
  const sent = [];
  const profiles = await findMany('xg_end_profile', { closed_at: _.neq(null) }, { limit: 200 });
  for (const ep of profiles) {
    for (const rd of ['1m', '3m']) {
      const dueKey = 'follow_' + rd + '_due_at';
      const sentKey = 'follow_' + rd + '_sent_at';
      const resKey = 'follow_' + rd + '_result';
      if (ep[dueKey] && !ep[sentKey] && new Date(ep[dueKey]) <= new Date(now)) {
        // 阶段一无真实推送通道：发起即写 sent_at，result 记 miniprogram 通道 sent
        const patch = { [sentKey]: now, [resKey]: 'sent', notify_channel: 'miniprogram' };
        await updateWhere('xg_end_profile', { user_id: ep.user_id }, patch);
        sent.push({ user_id: ep.user_id, round: rd, channel: 'miniprogram', result: 'sent' });
      }
    }
  }
  sendJson(res, 200, { sent });
}

// ---------------------------------------------------------------------------
// 2.12 POST /jobs/dynamic-refresh（service）
// ---------------------------------------------------------------------------
async function handleDynamicRefresh(res, identity) {
  if (identity.role !== 'service') return xgError(res, 401, 'XG_UNAUTHORIZED', '须系统令牌');
  const cfg = await getConfig();
  const refreshEvery = cfgInt(cfg, 'dynamic_refresh_sessions', 10);
  const now = nowIso();
  const refreshed = [];
  const profiles = await findMany('xg_baseline_profile', {}, { limit: 200 });
  for (const bp of profiles) {
    const lastM1 = await findMany('xg_assessment_events',
      { user_id: bp.user_id, scale_code: 'xg_m1_state', status: 'submitted' },
      { orderBy: 'session_no', orderDir: 'desc', limit: 1 });
    if (!lastM1.length) continue;
    const since = lastM1[0].session_no - (bp.focus_updated_session || 0);
    if (since < refreshEvery) continue;
    // 阶段一无 LLM：保守取全局兜底文案（LLM 接入后改为从结案/基线提炼）
    const focusText = '最近最困扰我的那件事';
    await updateWhere('xg_baseline_profile', { user_id: bp.user_id },
      { focus_text: focusText, focus_updated_session: lastM1[0].session_no });
    refreshed.push({ user_id: bp.user_id, focus_text: focusText });
  }
  sendJson(res, 200, { refreshed });
}

// ---------------------------------------------------------------------------
// 2.13 GET/POST /me/consent
// ---------------------------------------------------------------------------
async function handleConsentGet(res, q, identity) {
  if (!requireRole(res, identity, ['visitor'])) return;
  const scope = q.get('scope') || 'assessment';
  const rows = await findMany('xg_consent',
    { user_id: identity.userId, scope, revoked_at: null },
    { orderBy: 'agreed_at', orderDir: 'desc', limit: 1 });
  const row = rows[0] || null;
  sendJson(res, 200, {
    scope,
    agreed: !!row,
    version: row ? row.version : null,
    agreed_at: row ? to08(row.agreed_at) : null,
    required_version: CONSENT_VERSION
  });
}

async function handleConsentPost(res, body, identity) {
  if (!requireRole(res, identity, ['visitor'])) return;
  const scope = body.scope || 'assessment';
  if (!['assessment', 'followup'].includes(scope)) {
    return xgError(res, 400, 'XG_BAD_PARAM', 'scope 须为 assessment / followup');
  }
  const version = body.version || CONSENT_VERSION;
  if (body.agreed === false) {
    // 软撤销：只改 revoked_at
    await updateWhere('xg_consent', { user_id: identity.userId, scope, version, revoked_at: null }, { revoked_at: nowIso() });
    return sendJson(res, 200, { scope, version, agreed: false, revoked: true });
  }
  const existing = await findOne('xg_consent', { user_id: identity.userId, scope, version });
  const now = nowIso();
  if (existing) {
    await updateWhere('xg_consent', { id: existing.id }, { revoked_at: null, agreed_at: now, channel: body.channel || existing.channel });
  } else {
    await insertOne('xg_consent', {
      id: uuid(), user_id: identity.userId, scope, version,
      channel: body.channel || 'miniprogram', agreed_at: now, revoked_at: null,
      created_at: now, updated_at: now
    });
  }
  sendJson(res, 201, { scope, version, agreed_at: to08(now) });
}

// ---------------------------------------------------------------------------
// 2.14 POST /internal/llm-score（service）— 阶段一 stub：主分已在 events 落库
// ---------------------------------------------------------------------------
async function handleLlmScore(res, body, identity) {
  if (identity.role !== 'service') return xgError(res, 401, 'XG_UNAUTHORIZED', '须系统令牌');
  const job = await findOne('xg_llm_jobs', { event_id: body.event_id });
  if (!job) return xgError(res, 404, 'XG_NOT_FOUND', '任务不存在');
  if (job.status === 'done') return sendJson(res, 200, { ok: true, duplicated: true });
  // 阶段一：LLM 未接入，标记 done（response 整体替换，避免在 null 字段上点路径更新）
  await updateWhere('xg_llm_jobs', { id: job.id }, {
    status: 'done',
    response: _.set({ note: 'llm-not-connected-phase1' }),
    attempts: (job.attempts || 0) + 1
  });
  sendJson(res, 200, { ok: true, note: '阶段一 LLM 未接入，仅关闭任务' });
}

// ---------------------------------------------------------------------------
// 2.15 GET /admin/stats
// ---------------------------------------------------------------------------
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function handleAdminStats(res, q, identity) {
  if (!requireRole(res, identity, ['admin'])) return;
  const metric = q.get('metric') || 'all';
  const events = await findMany('xg_assessment_events', {}, { limit: 1000 });
  const alerts = await findMany('xg_alerts', {}, { limit: 1000 });
  const jobs = await findMany('xg_llm_jobs', {}, { limit: 1000 });
  const endProfiles = await findMany('xg_end_profile', {}, { limit: 1000 });

  const m = {};

  // fill_duration_ms（仅 submitted）
  const durs = events.filter((e) => e.status === 'submitted' && e.duration_ms != null)
    .map((e) => e.duration_ms).sort((a, b) => a - b);
  m.fill_duration_ms = durs.length >= 5
    ? { p50: percentile(durs, 50), p90: percentile(durs, 90), n: durs.length } : null;

  // abandon_rate：同一 (user, card, session) 计一次
  const seen = new Map();
  events.forEach((e) => {
    const k = `${e.user_id}|${e.scale_code}|${e.session_no}`;
    const cur = seen.get(k) || { started: 0, abandoned: 0 };
    if (e.status === 'started' || e.status === 'abandoned' || e.status === 'submitted') cur.started++;
    if (e.status === 'abandoned') cur.abandoned++;
    seen.set(k, cur);
  });
  const totStarted = [...seen.values()].reduce((a, x) => a + x.started, 0);
  const totAbandoned = [...seen.values()].reduce((a, x) => a + x.abandoned, 0);
  m.abandon_rate = totStarted >= 5 ? Math.round((totAbandoned / totStarted) * 100) / 100 : null;

  // low_quality_rate
  const submitted = events.filter((e) => e.status === 'submitted');
  const lowQ = submitted.filter((e) => e.quality_flag === 'low');
  m.low_quality_rate = submitted.length >= 5 ? Math.round((lowQ.length / submitted.length) * 100) / 100 : null;

  // alert_handle_time_h（仅 closed）
  const handled = alerts.filter((a) => a.status === 'closed' && a.handled_at && a.triggered_at)
    .map((a) => (new Date(a.handled_at) - new Date(a.triggered_at)) / 3600000).sort((a, b) => a - b);
  m.alert_handle_time_h = handled.length >= 5
    ? { p50: Math.round(percentile(handled, 50) * 10) / 10, p90: Math.round(percentile(handled, 90) * 10) / 10, n: handled.length } : null;

  // remind_action_rate：有 cst_note 或 closed 的 L2/L3 ÷ 全部 L2/L3
  const l23 = alerts.filter((a) => ['L2', 'L3'].includes(a.alert_level));
  const acted = l23.filter((a) => a.cst_note || a.status === 'closed');
  m.remind_action_rate = l23.length >= 5 ? Math.round((acted.length / l23.length) * 100) / 100 : null;

  // follow_return_rate：按期回收随访 ÷ 到期应推
  const rates = {};
  ['1m', '3m'].forEach((rd) => {
    const due = endProfiles.filter((p) => p['follow_' + rd + '_due_at'] && new Date(p['follow_' + rd + '_due_at']) <= new Date());
    const done = due.filter((p) => p['follow_' + rd + '_result'] === 'sent');
    rates[rd] = due.length >= 5 ? Math.round((done.length / due.length) * 100) / 100 : null;
  });
  m.follow_return_rate = rates['1m'] != null || rates['3m'] != null ? rates : null;

  // llm_success_rate
  const doneJobs = jobs.filter((j) => j.status === 'done');
  m.llm_success_rate = jobs.length >= 5 ? Math.round((doneJobs.length / jobs.length) * 100) / 100 : null;

  if (metric !== 'all' && m[metric] !== undefined) {
    return sendJson(res, 200, { metric, value: m[metric] });
  }
  sendJson(res, 200, { range: { from: q.get('from') || null, to: q.get('to') || null }, metrics: m });
}

// ---------------------------------------------------------------------------
// 2.16 GET /llm-results（咨询师/管理员，禁用词过滤）
// ---------------------------------------------------------------------------
async function handleLlmResults(res, q, identity) {
  if (!requireRole(res, identity, ['counselor', 'admin'])) return;
  const where = {};
  if (q.get('event_id')) where.event_id = q.get('event_id');
  else if (q.get('user_id')) where.user_id = q.get('user_id');
  else if (identity.role === 'counselor') where.counselor_id = identity.counselorId;

  const rows = await findMany('xg_llm_results', where,
    { orderBy: 'scored_at', orderDir: 'desc', limit: Math.min(Number(q.get('limit') || 50), 200) });
  const results = [];
  for (const r of rows) {
    if (identity.role === 'counselor' && r.counselor_id && r.counselor_id !== identity.counselorId) continue;
    // 禁用词过滤：命中则不返回，并记 job 待人工复核
    if (r.summary && BANNED_WORDS.some((w) => r.summary.includes(w))) {
      await updateWhere('xg_llm_jobs', { event_id: r.event_id },
        { status: 'pending', last_error: 'banned-word-hit:manual-review' });
      continue;
    }
    const ev = await findOne('xg_assessment_events', { id: r.event_id });
    results.push({
      event_id: r.event_id, session_no: ev ? ev.session_no : null,
      dim_scores: r.dim_scores, summary: r.summary, suggest_actions: r.suggest_actions,
      model: r.model, prompt_version: r.prompt_version, scored_at: to08(r.scored_at)
    });
  }
  sendJson(res, 200, { results });
}

// ---------------------------------------------------------------------------
// 路由（云函数 / 云托管共用）
// ---------------------------------------------------------------------------
async function dispatch(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'authorization,content-type,x-service-token'
    });
    return res.end();
  }
  const parsed = new URL(req.url, 'http://localhost');
  const path = parsed.pathname;
  const q = parsed.searchParams;

  if (path === '/health') {
    return sendJson(res, 200, { ok: true, mode: 'cloudbase-nosql-xg-fn', version: 'V3.2' });
  }
  if (!path.startsWith('/v1/xg/')) {
    return xgError(res, 404, 'XG_NOT_FOUND', 'Not found');
  }

  const identity = await resolveIdentity(req);
  const sub = path.slice('/v1/xg'.length);
  const body = (req.method === 'POST') ? await readBody(req) : {};

  if(['/jobs/follow-dispatch','/jobs/dynamic-refresh','/internal/llm-score'].includes(sub))return xgError(res,503,'XG_FEATURE_DISABLED','该自动任务尚未开放');
  if(identity.role==='counselor'||identity.role==='visitor'){
    const claimedUser=body.user_id||q.get('user_id');
    let userId=claimedUser|| (identity.role==='visitor'?identity.userId:null);
    let matchId=body.match_id||q.get('match_id');
    if(identity.role==='visitor'&&claimedUser&&claimedUser!==identity.userId)return xgError(res,403,'XG_FORBIDDEN','不能访问其他来访者');
    if(body.event_id){
      const event=await findOne('xg_assessment_events',{id:body.event_id});
      if(event){
        if((body.scale_code&&body.scale_code!==event.scale_code)||(body.session_no!==undefined&&Number(body.session_no)!==event.session_no))return xgError(res,403,'XG_FORBIDDEN','不能更改已开始答卷的卡片或节次');
        if((userId&&event.user_id!==userId)||(matchId&&event.match_id!==matchId))return xgError(res,403,'XG_FORBIDDEN','答卷归属不一致');
        if(req.method==='POST'&&(event.role!==identity.role||(identity.role==='counselor'&&event.counselor_id!==identity.counselorId)))return xgError(res,403,'XG_FORBIDDEN','不能替其他角色修改答卷');
        userId=event.user_id;matchId=event.match_id;
      }
    }
    if(matchId){
      const a=await findOne('assessments',{match_id:matchId});
      if(!a||!['approved','contacted'].includes(a.match_request_status)||(identity.role==='counselor'&&a.match_request_cid!==identity.counselorId)||(userId&&userId!=='asid-'+a.id))return xgError(res,403,'XG_FORBIDDEN','无权访问该咨询周期');
      userId='asid-'+a.id;
      if(body.visitor_id&&body.visitor_id!==userId)return xgError(res,403,'XG_FORBIDDEN','来访者归属不一致');
      if(sub==='/case-switch'&&req.method==='POST')body.visitor_id=userId;
      if(body.counselor_id&&body.counselor_id!==a.match_request_cid)return xgError(res,403,'XG_FORBIDDEN','咨询师归属不一致');
      if(req.method==='POST')body.counselor_id=a.match_request_cid;
    }
    if(identity.role==='counselor'&&userId&&!await counselorCanAccessUser(identity.counselorId,userId))return xgError(res,403,'XG_FORBIDDEN','无权访问该来访者');
    if(['/events/start','/events'].includes(sub)&&req.method==='POST'){
      if(!matchId||!userId)return xgError(res,400,'XG_BAD_PARAM','缺少咨询周期或来访者');
      const meta=await findOne('xg_scales',{scale_code:body.scale_code});
      if(meta&&meta.fill_role!==identity.role)return xgError(res,403,'XG_FORBIDDEN','只能填写本角色卡片');
      if(body.counselor_id&&identity.role==='counselor'&&body.counselor_id!==identity.counselorId)return xgError(res,403,'XG_FORBIDDEN','咨询师归属不一致');
      if(body.client_event_id){const prior=await findOne('xg_assessment_events',{client_event_id:body.client_event_id});if(prior&&(prior.user_id!==userId||prior.match_id!==matchId||prior.role!==identity.role))return xgError(res,403,'XG_FORBIDDEN','作答标识属于其他周期');}
    }
  }

  if (sub === '/scales' && req.method === 'GET') return handleScales(res, q);
  if (sub === '/prompts/next' && req.method === 'GET') return handlePromptsNext(res, q, identity);

  // ---- 公开：原问卷 → 四评 桥接 ----
  if (sub === '/bridge/enter' && req.method === 'POST') return handleBridgeEnter(res, body);

  if (sub === '/events/start' && req.method === 'POST') return handleEventsStart(res, body, identity);
  if (sub === '/events/abandon' && req.method === 'POST') return handleEventsAbandon(res, body, identity);
  if (sub === '/events' && req.method === 'POST') return handleEventsSubmit(res, body, identity);
  if (sub === '/events' && req.method === 'GET') return handleGetEvents(res, q, identity);

  if (sub === '/trend' && req.method === 'GET') return handleTrend(res, q, identity);
  if (sub === '/person-compare' && req.method === 'GET') return handlePersonCompare(res, q, identity);

  if (sub === '/counselor/inbox' && req.method === 'GET') return handleInbox(res, q, identity);
  if (sub === '/case-switch' && req.method === 'GET') return handleCaseSwitchGet(res, q, identity);
  if (sub === '/case-switch' && req.method === 'POST') return handleCaseSwitchPost(res, body, identity);
  if (sub === '/llm-results' && req.method === 'GET') return handleLlmResults(res, q, identity);

  let m;
  if ((m = sub.match(/^\/alerts\/([^/]+)\/ack$/)) && req.method === 'POST') return handleAlertAck(res, m[1], body, identity);
  if ((m = sub.match(/^\/alerts\/([^/]+)\/cst$/)) && req.method === 'POST') return handleAlertCst(res, m[1], body, identity);

  if (sub === '/me/consent' && req.method === 'GET') return handleConsentGet(res, q, identity);
  if (sub === '/me/consent' && req.method === 'POST') return handleConsentPost(res, body, identity);

  if (sub === '/m4/close' && req.method === 'POST') return handleM4Close(res, body, identity);
  if (sub === '/jobs/follow-dispatch' && req.method === 'POST') return handleFollowDispatch(res, identity);
  if (sub === '/jobs/dynamic-refresh' && req.method === 'POST') return handleDynamicRefresh(res, identity);
  if (sub === '/internal/llm-score' && req.method === 'POST') return handleLlmScore(res, body, identity);

  if (sub === '/admin/stats' && req.method === 'GET') return handleAdminStats(res, q, identity);

  xgError(res, 404, 'XG_NOT_FOUND', 'Not found');
}

// 统一兜底：避免未捕获异常变成无信息 500（FUNCTIONS_INVOCATION_FAILED）
async function handleRequest(req, res) {
  try {
    await dispatch(req, res);
  } catch (e) {
    try {
      xgError(res,500,'XG_INTERNAL','服务端异常，请稍后重试');
    } catch (_) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'XG_INTERNAL', message: '服务端异常' } }));
    }
  }
}

module.exports = { handleRequest };
