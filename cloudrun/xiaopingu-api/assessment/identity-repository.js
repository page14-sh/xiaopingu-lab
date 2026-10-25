const { randomUUID } = require('node:crypto');
const { COLLECTIONS: C, AssessmentError, documentKey, requireId } = require('./model');
const { requirePrincipal, deny } = require('./authorization');
const { createRolloutRepository } = require('./rollout');

function createIdentityRepository(store) {
  return {
    async exchangeIdentity(claims) {
      const id = `wx_${documentKey(claims.appid, claims.openid)}`;
      return store.transaction(async (tx) => {
        if (claims.exp * 1000 <= Date.now()) throw new AssessmentError('XG_UNAUTHORIZED', '身份凭证已过期', 401);
        if (await tx.get(C.assertions, claims.jti)) {
          throw new AssessmentError('XG_IDENTITY_REPLAY', '身份凭证已使用，请重新获取', 401);
        }
        const previous = await tx.get(C.visitors, id);
        if (previous?.disabled) deny('该身份已停用');
        const visitor = previous || { visitor_id: id, provider: 'wechat-cloud', created_at: new Date().toISOString() };
        await tx.put(C.assertions, claims.jti, { visitor_id: id, expires_at: claims.exp * 1000 });
        if (!previous) await tx.put(C.visitors, id, visitor);
        const contactId = documentKey('visitor', id);
        if (!await tx.get(C.notificationRecipients, contactId)) await tx.put(C.notificationRecipients, contactId, {
          recipient_role: 'visitor', recipient_id: id, openid: claims.openid, appid: claims.appid,
          disabled: false, revision: 1, source: 'verified_wechat_assertion', updated_at: new Date().toISOString()
        });
        return { id: visitor.visitor_id };
      });
    },
    async requireVisitor(id) {
      const visitor = await store.get(C.visitors, requireId(id, 'visitor_id'));
      if (!visitor || visitor.disabled || visitor.provider !== 'wechat-cloud') deny('无有效来访身份');
      return visitor;
    },
    async createIntake(principal, data) {
      requirePrincipal(principal);
      if (principal.role !== 'visitor') deny();
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      return store.transaction(async (tx) => {
        const visitor = await tx.get(C.visitors, principal.subject);
        if (!visitor || visitor.disabled || visitor.provider !== 'wechat-cloud') deny();
        await tx.put('assessments', id, {
          ...data, id, visitor_user_id: principal.subject, xg_managed: true,
          match_request_status: 'pending', created_at: timestamp
        });
        await tx.put(C.intakes, id, { assessment_id: id, visitor_id: principal.subject, created_at: timestamp });
        return { assessment_id: id };
      });
    },
    async requestMatch(principal, { assessment_id, counselor_id }) {
      requirePrincipal(principal);
      if (principal.role !== 'visitor') deny();
      requireId(assessment_id, 'assessment_id'); requireId(counselor_id, 'counselor_id');
      const id = randomUUID();
      return store.transaction(async (tx) => {
        const owner = await tx.get(C.intakes, assessment_id);
        if (!owner || owner.visitor_id !== principal.subject) deny('评估记录不属于当前可信来访身份');
        const request = { request_id: id, assessment_id, visitor_id: principal.subject, counselor_id,
          status: 'pending', created_at: new Date().toISOString() };
        await tx.put(C.requests, id, request);
        return request;
      });
    },
    async approveRequest(principal, id) {
      requirePrincipal(principal); requireId(id, 'request_id');
      return store.transaction(async (tx) => {
        const request = await tx.get(C.requests, id);
        if (!request || !(principal.role === 'admin' ||
            (principal.role === 'counselor' && request.counselor_id === principal.subject))) deny();
        if (request.status === 'approved') return request;
        if (request.status !== 'pending') throw new AssessmentError('XG_REQUEST_STATE', '申请状态不可审批');
        const approved = { ...request, status: 'approved', approved_by: principal.subject,
          approved_role: principal.role, approved_at: new Date().toISOString() };
        await tx.put(C.requests, id, approved);
        return approved;
      });
    },
    async approvedRequest(principal, id) {
      requirePrincipal(principal); requireId(id, 'request_id');
      const request = await store.get(C.requests, id);
      if (!request || !(principal.role === 'admin' ||
          (principal.role === 'counselor' && request.counselor_id === principal.subject))) deny();
      if (request.status !== 'approved') throw new AssessmentError('XG_MATCH_NOT_APPROVED', '须先审批匹配申请');
      return request;
    },
    caseSwitch(principal, matchId, patch, options) {
      return createRolloutRepository(store).caseSwitch(principal, matchId, patch, options);
    }
  };
}

module.exports = { createIdentityRepository };
