const { isDeepStrictEqual } = require('node:util');
const { COLLECTIONS: C, AssessmentError, documentKey, requireId, scopeOf, assertScope } = require('./model');
const { requirePrincipal, authorizeMatch, deny } = require('./authorization');
const { requireMatch } = require('./event-storage');
const FLAGS = ['enable_reminder', 'enable_cst', 'emergency_stop', 'collection_paused'];
const DEFAULTS = Object.freeze({ revision: 0, enable_reminder: false, enable_cst: false, emergency_stop: false, collection_paused: false });
function boolPatch(patch, allowed) {
  if (!patch || Object.getPrototypeOf(patch) !== Object.prototype || !Object.keys(patch).length ||
      Object.entries(patch).some(([key, value]) => !allowed.includes(key) || typeof value !== 'boolean')) {
    throw new AssessmentError('XG_BAD_PARAM', '开关只接受规定的布尔字段', 400);
  }
}
function revision(value) { if (!Number.isSafeInteger(value) || value < 0) throw new AssessmentError('XG_BAD_PARAM', '缺少有效修订号', 400); }
function reasonText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new AssessmentError('XG_BAD_PARAM', '请填写1至500字符的变更原因', 400);
  return value.trim();
}
async function globalIn(tx) {
  const row = await tx.get(C.rollout, 'current');
  if (!row) return { ...DEFAULTS };
  revision(row.revision);
  if (FLAGS.some((key) => typeof row[key] !== 'boolean')) throw new AssessmentError('XG_ROLLOUT_INVALID', '阶段配置不完整', 503);
  return row;
}
function globalView(row) {
  return { revision: row.revision, ...Object.fromEntries(FLAGS.map((key) => [key, row[key]])), safety_always_on: true,
    stage: row.emergency_stop ? 'emergency_paused' : row.enable_reminder ? 'phase_two' : 'phase_one',
    updated_by: row.updated_by || null, updated_at: row.updated_at || null, reason: row.reason || null };
}
async function caseIn(tx, match) {
  const row = await tx.get(C.switches, match.match_id);
  assertScope(row, match);
  if (row) revision(row.revision ?? 0);
  if (row && (typeof row.enable_reminder !== 'boolean' || typeof row.enable_cst !== 'boolean')) throw new AssessmentError('XG_ROLLOUT_INVALID', '单案配置不完整', 503);
  return row ? { ...row, revision: row.revision ?? 0 } : { ...scopeOf(match), revision: 0, enable_reminder: false, enable_cst: false };
}
function effectivePolicy(global, local) {
  return { global_revision: global.revision, case_revision: local.revision,
    stage: global.emergency_stop ? 'emergency_paused' : global.enable_reminder ? 'phase_two' : 'phase_one',
    l1_visible: !global.emergency_stop,
    l2_visible: !global.emergency_stop && (global.enable_reminder || local.enable_reminder),
    l3_visible: !global.emergency_stop && global.enable_reminder,
    cst_enabled: !global.emergency_stop && (global.enable_cst || local.enable_cst),
    safety_visible: true, collection_paused: global.collection_paused };
}
async function policyIn(tx, match, { lock = false } = {}) {
  const global = await globalIn(tx), local = await caseIn(tx, match);
  if (lock) {
    await tx.put(C.rollout, 'current', { ...global, access_revision: (global.access_revision || 0) + 1 });
    await tx.put(C.switches, match.match_id, { ...local, access_revision: (local.access_revision || 0) + 1 });
  }
  return effectivePolicy(global, local);
}
async function collectionPausedIn(tx) { return (await globalIn(tx)).collection_paused; }
async function requireCollectionOpen(tx) {
  const global = await globalIn(tx);
  if (global.collection_paused) throw new AssessmentError('XG_COLLECTION_PAUSED', '暂不开放新的填卡，已开始的填卡仍可完成', 409);
  // Serialize opening a NEW form against collection pause. Semantic revision is
  // unchanged, so a form opening does not invalidate an admin's settings version.
  await tx.put(C.rollout, 'current', { ...global, access_revision: (global.access_revision || 0) + 1 });
}
function createRolloutRepository(store, { now = () => new Date().toISOString() } = {}) {
  async function history(tx, scope, matchId, next, previous, actor, reason, action) {
    const id = documentKey(scope, matchId, next.revision);
    if (await tx.get(C.rolloutHistory, id)) throw new AssessmentError('XG_ROLLOUT_HISTORY_CONFLICT', '开关修订历史已存在', 503);
    const allowed = scope === 'global' ? FLAGS : ['enable_reminder', 'enable_cst'];
    const pick = (value) => Object.fromEntries(allowed.map((key) => [key, value[key]]));
    await tx.put(C.rolloutHistory, id, { scope, match_id: matchId, revision: next.revision,
      ...(scope === 'case' ? scopeOf(next) : {}), before: pick(previous), after: pick(next),
      changed_by: actor.subject, changed_role: actor.role, reason, action, changed_at: next.updated_at });
  }
  return {
    get() { return store.transaction(async (tx) => globalView(await globalIn(tx))); },
    async collectionPaused() { return (await globalIn(store)).collection_paused; },
    async update(principal, { expected_revision, patch, reason }, { rollback = false } = {}) {
      requirePrincipal(principal); if (principal.role !== 'admin') deny();
      revision(expected_revision); const why = reasonText(reason);
      if (!rollback) boolPatch(patch, FLAGS);
      const change = { expected_revision, patch: rollback ? { enable_reminder: false, enable_cst: false, emergency_stop: true } : patch,
        reason: why, actor_id: principal.subject, action: rollback ? 'rollback' : 'configure' };
      return store.transaction(async (tx) => {
        const current = await globalIn(tx);
        if (isDeepStrictEqual(current.last_change, change)) return { ...globalView(current), duplicated: true };
        if (current.revision !== expected_revision) throw new AssessmentError('XG_ROLLOUT_CONFLICT', '阶段配置已变化，请重新读取');
        if (Object.entries(change.patch).every(([key, value]) => current[key] === value)) return { ...globalView(current), duplicated: true };
        const next = { ...current, ...change.patch, revision: current.revision + 1, reason: why,
          updated_at: now(), updated_by: principal.subject, last_change: change };
        await history(tx, 'global', '', next, current, principal, why, change.action);
        await tx.put(C.rollout, 'current', next);
        return { ...globalView(next), duplicated: false };
      });
    },
    async caseSwitch(principal, matchId, patch, { expected_revision, reason = '咨询师调整单案开关' } = {}) {
      requirePrincipal(principal); requireId(matchId, 'match_id');
      if (patch) { boolPatch(patch, ['enable_reminder','enable_cst']); if (expected_revision !== undefined) revision(expected_revision); }
      const why = patch ? reasonText(reason) : null;
      return store.transaction(async (tx) => {
        const match = await requireMatch(tx, matchId); authorizeMatch(principal, match);
        if (principal.role === 'visitor' || (patch && principal.role !== 'counselor')) deny();
        const current = await caseIn(tx, match), global = await globalIn(tx);
        const view = (row) => ({ match_id: matchId, revision: row.revision, enable_reminder: row.enable_reminder,
          enable_cst: row.enable_cst, effective: effectivePolicy(global, row) });
        if (!patch) return view(current);
        const change = { expected_revision: expected_revision ?? current.revision, patch, reason: why, actor_id: principal.subject };
        if (expected_revision !== undefined && isDeepStrictEqual(current.last_change, change)) return view(current);
        if (expected_revision !== undefined && current.revision !== expected_revision) throw new AssessmentError('XG_ROLLOUT_CONFLICT', '单案配置已变化，请重新读取');
        if (Object.entries(patch).every(([key, value]) => current[key] === value)) return view(current);
        const next = { ...current, ...patch, ...scopeOf(match), revision: current.revision + 1,
          updated_by: principal.subject, updated_at: now(), last_change: change };
        await history(tx, 'case', matchId, next, current, principal, why, 'case_switch');
        await tx.put(C.switches, matchId, next);
        return view(next);
      });
    },
    async readHistory(principal, scope, matchId, requestedRevision) {
      requirePrincipal(principal); if (principal.role !== 'admin') deny();
      if (!['global','case'].includes(scope)) throw new AssessmentError('XG_BAD_PARAM', '历史范围不合法', 400);
      revision(requestedRevision); if (requestedRevision < 1) throw new AssessmentError('XG_BAD_PARAM', '修订号须大于0', 400);
      return store.transaction(async (tx) => {
        const match = scope === 'case' ? await requireMatch(tx, requireId(matchId, 'match_id')) : null;
        const record = await tx.get(C.rolloutHistory, documentKey(scope, match ? matchId : '', requestedRevision));
        if (!record) throw new AssessmentError('XG_NOT_FOUND', '开关历史不存在', 404);
        if (match) assertScope(record, match);
        return Object.fromEntries(['scope','match_id','revision','before','after','changed_by','changed_role','reason','action','changed_at'].map((key) => [key, record[key]]));
      });
    }
  };
}
module.exports = { createRolloutRepository, effectivePolicy, policyIn, requireCollectionOpen, collectionPausedIn };
