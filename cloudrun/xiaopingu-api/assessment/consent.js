const { isDeepStrictEqual } = require('node:util');
const { COLLECTIONS: C, SCALES, AssessmentError, requireId, documentKey } = require('./model');
const { requirePrincipal, deny } = require('./authorization');

const SCOPES = ['assessment', 'followup'];
const CHANNELS = ['miniprogram', 'web', 'app'];
function validScope(scope) {
  if (!SCOPES.includes(scope)) throw new AssessmentError('XG_BAD_PARAM', '无效同意用途', 400);
  return scope;
}
function scopeForCard(scale) {
  if (!Object.values(SCALES).includes(scale)) throw new AssessmentError('XG_BAD_PARAM', '无效卡片', 400);
  return [SCALES.end, SCALES.evaluation, SCALES.follow].includes(scale) ? 'followup' : 'assessment';
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new AssessmentError('XG_BAD_PARAM', '缺少有效的 expected_revision', 400);
}
function scopedState(state, visitorId, scope) {
  if (state && (state.visitor_id !== visitorId || state.scope !== scope)) {
    throw new AssessmentError('XG_SCOPE_MISMATCH', '同意记录归属异常');
  }
}
function active(state, policy) {
  return Boolean(policy && state?.agreed === true && state.version === policy.version &&
    state.document_hash === policy.document_hash && state.policy_revision === policy.revision);
}
function statusView(scope, state, policy, document) {
  return {
    scope, configured: Boolean(policy), agreed: active(state, policy),
    version: state?.version ?? null, document_hash: state?.document_hash ?? null,
    agreed_at: state?.agreed_at ?? null, revoked_at: state?.revoked_at ?? null,
    revision: state?.revision || 0, required_version: policy?.version ?? null,
    required_document: document ? {
      version: document.version, title: document.title, content: document.content,
      content_hash: document.document_hash, published_at: document.published_at
    } : null
  };
}
function actionView(row) {
  return Object.fromEntries(['action_id', 'scope', 'version', 'document_hash', 'action', 'channel', 'occurred_at', 'revision']
    .map((key) => [key, row[key]]));
}

function createConsentRepository(store, { now = () => new Date().toISOString() } = {}) {
  async function policyIn(source, scope) {
    const policy = await source.get(C.consentPolicies, scope);
    if (!policy) return { policy: null, document: null };
    const document = await source.get(C.consentDocuments, documentKey(scope, policy.version));
    if (policy.scope !== scope || !Number.isSafeInteger(policy.revision) || policy.revision < 1 ||
        !document || document.scope !== scope || document.version !== policy.version ||
        typeof document.title !== 'string' || !document.title.trim() ||
        typeof document.content !== 'string' || !document.content.trim() ||
        policy.document_hash !== document.document_hash ||
        document.document_hash !== documentKey(scope, document.version, document.title, document.content)) {
      throw new AssessmentError('XG_CONSENT_POLICY_INVALID', '同意书配置异常，暂不可签署', 503);
    }
    return { policy, document };
  }
  async function visitorIn(tx, visitorId) {
    const visitor = await tx.get(C.visitors, visitorId);
    if (!visitor || visitor.disabled || visitor.provider !== 'wechat-cloud') deny('无有效来访身份');
  }
  async function stateIn(tx, visitorId, scope) {
    const state = await tx.get(C.consentStates, documentKey(visitorId, scope));
    scopedState(state, visitorId, scope);
    return state;
  }
  async function readIn(tx, visitorId, scope) {
    const { policy, document } = await policyIn(tx, scope);
    const state = await stateIn(tx, visitorId, scope);
    return { state, policy, document };
  }
  async function requireInTransaction(tx, visitorId, scope, { lock = true } = {}) {
    requireId(visitorId, 'visitor_id'); validScope(scope);
    await visitorIn(tx, visitorId);
    const { state, policy } = await readIn(tx, visitorId, scope);
    if (!policy) throw new AssessmentError('XG_CONSENT_NOT_CONFIGURED', '该用途尚无已发布同意书', 503);
    if (!active(state, policy)) throw new AssessmentError('XG_CONSENT_REQUIRED', '需要有效知情同意', 409);
    if (lock) {
      await tx.put(C.consentPolicies, scope, { ...policy, access_revision: (policy.access_revision || 0) + 1 });
      await tx.put(C.consentStates, documentKey(visitorId, scope), { ...state, access_revision: (state.access_revision || 0) + 1 });
    }
    return { action_id: state.last_action_id, scope, version: state.version, document_hash: state.document_hash };
  }

  return {
    requireInTransaction,
    // Trusted operator entry only, not exposed by any HTTP mutation route.
    // No production policy is seeded by application startup or tests.
    async publishPolicy({ scope, version, title, content, published_by, expected_revision }) {
      validScope(scope); requireId(version, 'version'); requireId(published_by, 'published_by'); revision(expected_revision);
      if (typeof title !== 'string' || !title.trim() || title.length > 200 ||
          typeof content !== 'string' || !content.trim() || content.length > 50000) {
        throw new AssessmentError('XG_BAD_PARAM', '同意书须有完整标题和正文', 400);
      }
      const hash = documentKey(scope, version, title, content);
      return store.transaction(async (tx) => {
        const current = await tx.get(C.consentPolicies, scope);
        const existing = await tx.get(C.consentDocuments, documentKey(scope, version));
        if (existing) {
          if (existing.document_hash !== hash || existing.title !== title || existing.content !== content) {
            throw new AssessmentError('XG_CONSENT_VERSION_IMMUTABLE', '同一版本正文不可改写，请使用新版本');
          }
          if (current?.version === version && current.document_hash === hash) return current;
          throw new AssessmentError('XG_CONSENT_VERSION_REUSED', '不可重新启用旧版本，请发布新版本');
        }
        if ((current?.revision || 0) !== expected_revision) throw new AssessmentError('XG_CONSENT_CONFLICT', '必需版本已变化，请重新读取');
        const timestamp = now();
        const next = { scope, version, document_hash: hash, revision: expected_revision + 1,
          published_at: timestamp, published_by, access_revision: current?.access_revision || 0 };
        await tx.put(C.consentDocuments, documentKey(scope, version), {
          scope, version, title, content, document_hash: hash, published_at: timestamp, published_by
        });
        await tx.put(C.consentPolicies, scope, next);
        return next;
      });
    },

    async getStatus(visitorId, scope) {
      requireId(visitorId, 'visitor_id'); validScope(scope);
      return store.transaction(async (tx) => {
        const { state, policy, document } = await readIn(tx, visitorId, scope);
        return statusView(scope, state, policy, document);
      });
    },

    async decide(principal, input) {
      requirePrincipal(principal);
      if (principal.role !== 'visitor') deny('仅本人可签署或撤销');
      const { scope, version, document_hash, agreed, channel, client_event_id, expected_revision } = input;
      validScope(scope); requireId(version, 'version'); requireId(client_event_id, 'client_event_id'); revision(expected_revision);
      if (typeof agreed !== 'boolean' || !CHANNELS.includes(channel) ||
          typeof document_hash !== 'string' || !/^[a-f0-9]{64}$/.test(document_hash)) {
        throw new AssessmentError('XG_BAD_PARAM', '同意请求字段不合法', 400);
      }
      const visitorId = principal.subject;
      const operation = { scope, version, document_hash, agreed, channel, expected_revision };
      const id = documentKey(visitorId, client_event_id);
      return store.transaction(async (tx) => {
        await visitorIn(tx, visitorId);
        const existing = await tx.get(C.consentHistory, id);
        const state = await stateIn(tx, visitorId, scope);
        if (existing) {
          if (existing.visitor_id !== visitorId || !isDeepStrictEqual(existing.request, operation)) {
            throw new AssessmentError('XG_IDEMPOTENCY_CONFLICT', '同一请求标识不能用于不同操作');
          }
          const policy = state?.agreed ? (await policyIn(tx, scope)).policy : await tx.get(C.consentPolicies, scope);
          // An old grant retry after withdrawal reports current state; it never restores consent.
          return { duplicated: true, action: actionView(existing), ...statusView(scope, state, policy, null) };
        }
        if ((state?.revision || 0) !== expected_revision) throw new AssessmentError('XG_CONSENT_CONFLICT', '同意状态已变化，请重新读取');
        let policy;
        if (agreed) {
          ({ policy } = await policyIn(tx, scope));
          if (!policy) throw new AssessmentError('XG_CONSENT_NOT_CONFIGURED', '该用途尚无已发布同意书', 503);
          if (policy.version !== version || policy.document_hash !== document_hash) {
            throw new AssessmentError('XG_CONSENT_VERSION_MISMATCH', '同意书已更新，请阅读当前版本');
          }
          if (active(state, policy)) throw new AssessmentError('XG_CONSENT_ALREADY_AGREED', '当前版本已经同意，无须重复签署');
          // Serialize publication vs signing without changing the policy's semantic revision.
          await tx.put(C.consentPolicies, scope, { ...policy, access_revision: (policy.access_revision || 0) + 1 });
        } else {
          if (!state?.agreed || state.version !== version || state.document_hash !== document_hash) {
            throw new AssessmentError('XG_CONSENT_NOT_ACTIVE', '指定的签署记录当前不可撤销');
          }
          // Withdrawal must work even after a version upgrade or while no policy is configured.
          policy = await tx.get(C.consentPolicies, scope);
        }
        const timestamp = now();
        const next = {
          visitor_id: visitorId, scope, version, document_hash, agreed,
          revision: expected_revision + 1, policy_revision: agreed ? policy.revision : state.policy_revision,
          agreed_at: agreed ? timestamp : state.agreed_at, revoked_at: agreed ? null : timestamp,
          last_action_id: id, access_revision: state?.access_revision || 0
        };
        const action = { action_id: id, visitor_id: visitorId, scope, version, document_hash,
          action: agreed ? 'agreed' : 'revoked', channel, occurred_at: timestamp,
          revision: next.revision, request: operation };
        await tx.put(C.consentHistory, id, action);
        await tx.put(C.consentStates, documentKey(visitorId, scope), next);
        return { duplicated: false, action: actionView(action), ...statusView(scope, next, policy, null) };
      });
    },

    async history(visitorId, scope, { limit = 50, offset = 0 } = {}) {
      requireId(visitorId, 'visitor_id'); validScope(scope);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
          !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) {
        throw new AssessmentError('XG_BAD_PARAM', '分页参数不合法', 400);
      }
      const rows = await store.consentHistoryForVisitor(visitorId, scope, { limit, offset });
      for (const row of rows) scopedState(row, visitorId, scope);
      return rows.map(actionView);
    },

    async assertCurrent(visitorId, scope) {
      const status = await this.getStatus(visitorId, scope);
      if (!status.configured) throw new AssessmentError('XG_CONSENT_NOT_CONFIGURED', '该用途尚无已发布同意书', 503);
      if (!status.agreed) throw new AssessmentError('XG_CONSENT_REQUIRED', '需要有效知情同意', 409);
    },

    // T09/T10 and dispatchers must put the actual write/claim in this transaction.
    // A standalone preflight read does NOT serialize a submission against withdrawal.
    async runWithConsent(visitorId, scope, work) {
      requireId(visitorId, 'visitor_id'); validScope(scope);
      return store.transaction(async (tx) => {
        return work(tx, await requireInTransaction(tx, visitorId, scope));
      });
    }
  };
}

module.exports = { createConsentRepository, validScope, scopeForCard };
