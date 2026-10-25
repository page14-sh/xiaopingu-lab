const { AssessmentError, documentKey, requireId } = require('./model');
const { AUDIENCE, requirePrincipal, verifyAssertion, fields, deny, authorizeMatch } = require('./authorization');
const { handleAssessmentRead } = require('./read-http');
const { handleConsent } = require('./consent-http');
const { formView } = require('./event-lifecycle');
const { handleRollout } = require('./rollout-http');
const { handleService } = require('./service-http');
const { handleNotifications } = require('./notification-http');
const { handleLlm } = require('./llm-http');

function createAssessmentHttp({ store, signSession, sessionSecret, identityBridge, serviceSecrets, readJson: readRequestJson, sendJson, demoCounselorIds }) {
  async function readJson(req) {
    try { return await readRequestJson(req); }
    catch (error) {
      if (error.statusCode === 400) throw new AssessmentError('XG_BAD_PARAM', '请求必须为合法JSON', 400);
      if (error.statusCode === 413) throw new AssessmentError('XG_BAD_PARAM', '请求内容过大', 413);
      throw error;
    }
  }
  const identity = store.identity;
  const repository = store.assessment;
  async function member(session) {
    const principal = requirePrincipal(session);
    if (!identity || !repository) throw new AssessmentError('XG_NOT_READY', '四评存储尚未配置', 503);
    if (principal.role === 'visitor') await identity.requireVisitor(principal.subject,principal.auth_method);
    if (principal.role === 'counselor') {
      const counselor = await store.findById('counselors', principal.subject);
      if (!counselor || !counselor.is_active || counselor.review_status !== 'approved' ||
          counselor.is_demo || demoCounselorIds.includes(counselor.id)) deny('无有效咨询师身份');
    }
    return principal;
  }
  async function scopedMatch(principal, id) {
    const match = await repository.getMatch(id);
    authorizeMatch(principal, match);
    return match;
  }
  function metadata(match) {
    return Object.fromEntries(['match_id', 'visitor_id', 'counselor_id', 'status', 'opened_at', 'closed_at']
      .map((field) => [field, match[field]]));
  }
  return async function handle(req, res, url, session) {
    if (url.pathname !== '/auth/visitor' && !url.pathname.startsWith('/v1/xg/')) return false;
    // Authenticated responses (including errors) must never be shared or stored by caches.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Authorization');
    try {
      if (await handleService({ req, res, url, store, secrets: serviceSecrets, readJson, sendJson })) return true;
      if (url.pathname === '/auth/visitor' && req.method === 'POST') {
        const body = await readJson(req);
        fields(body, ['assertion']);
        const claims = verifyAssertion(body.assertion, identityBridge || {});
        if (!identity) throw new AssessmentError('XG_NOT_READY', '四评存储尚未配置', 503);
        const visitor = await identity.exchangeIdentity(claims);
        const expires = Date.now() + 60 * 60 * 1000;
        const token = signSession({ role: 'visitor', subject: visitor.id, aud: AUDIENCE,
          auth_method: 'wechat-cloud', demo: false, exp: expires }, sessionSecret);
        sendJson(res, 200, { token, expires_at: expires, visitor });
        return true;
      }
      const principal = await member(session);
      if (await handleLlm({req,res,url,principal,service:store.llm,readJson,sendJson})) return true;
      try {
        if (await handleNotifications({ req, res, url, principal, service: store.notifications, readJson, sendJson })) return true;
      } catch (error) { if (error.code === 'XG_SCOPE_MISMATCH') deny(); throw error; }
      try {
        if (await handleRollout({ req, res, url, principal, repository, readJson, sendJson })) return true;
      } catch (error) { if (error.code === 'XG_SCOPE_MISMATCH') deny(); throw error; }
      if (await handleConsent({ req, res, url, principal, consent: store.consent, scopedMatch, readJson, sendJson,
        collectionPaused: () => repository.collectionPaused(), riskStatus: (id)=>repository.riskStatus(id), followups: store.followups })) return true;
      if (await handleAssessmentRead({ req, res, url, principal, repository, scopedMatch, sendJson })) return true;
      if (url.pathname === '/v1/xg/bridge/enter' && req.method==='POST'){const body=await readJson(req);fields(body,['asid']);sendJson(res,200,await store.admission.enter(principal,body));
      } else if (url.pathname === '/v1/xg/me' && req.method === 'GET') {
        sendJson(res, 200, { id: principal.subject, role: principal.role, auth_method:principal.auth_method });
      } else if (url.pathname === '/v1/xg/admin/stats' && req.method === 'GET') {
        if (principal.role !== 'admin') deny();
        for (const key of url.searchParams.keys()) if (!['metric','from','to'].includes(key) || url.searchParams.getAll(key).length !== 1) throw new AssessmentError('XG_BAD_PARAM','统计查询参数不合法',400);
        if (!store.statistics) throw new AssessmentError('XG_NOT_READY','统计服务尚未配置',503);
        sendJson(res,200,await store.statistics.report(Object.fromEntries(url.searchParams)));
      } else if (url.pathname === '/v1/xg/admin/rule-thresholds' && ['GET', 'POST'].includes(req.method)) {
        if (principal.role !== 'admin') deny();
        if ([...url.searchParams.keys()].length) throw new AssessmentError('XG_BAD_PARAM', '此接口不接受查询参数', 400);
        if (!store.provenance) throw new AssessmentError('XG_NOT_READY', '规则存储尚未配置', 503);
        if (req.method === 'GET') sendJson(res, 200, await store.provenance.getThresholds());
        else {
          const body = await readJson(req);
          fields(body, ['rule_version', 'expected_revision', 'thresholds', 'reason']);
          const result = await store.provenance.publishThresholds({ ...body, published_by: principal.subject });
          sendJson(res, result.duplicated ? 200 : 201, result);
        }
      } else if (url.pathname === '/v1/xg/admin/session-combination' && req.method === 'GET') {
        if (principal.role !== 'admin') deny();
        for (const key of url.searchParams.keys()) {
          if (!['match_id', 'session_no', 'revision'].includes(key) || url.searchParams.getAll(key).length !== 1) throw new AssessmentError('XG_BAD_PARAM', '查询参数不合法', 400);
        }
        const integer = (key) => {
          const value = url.searchParams.get(key);
          if (!/^(0|[1-9][0-9]*)$/.test(value || '') || !Number.isSafeInteger(Number(value))) throw new AssessmentError('XG_BAD_PARAM', '节次或修订号不合法', 400);
          return Number(value);
        };
        const match = await scopedMatch(principal, requireId(url.searchParams.get('match_id'), 'match_id'));
        try {
          const result = await repository.getCombination(match.match_id, integer('session_no'), url.searchParams.has('revision') ? integer('revision') : undefined);
          if (!result) throw new AssessmentError('XG_NOT_FOUND', '组合记录不存在', 404);
          sendJson(res, 200, result);
        } catch (error) { if (error.code === 'XG_SCOPE_MISMATCH') deny(); throw error; }
      } else if (['/v1/xg/admin/event-basis', '/v1/xg/admin/event-score-replay'].includes(url.pathname) && req.method === 'GET') {
        if (principal.role !== 'admin') deny();
        for (const key of url.searchParams.keys()) {
          if (!['match_id', 'event_id'].includes(key) || url.searchParams.getAll(key).length !== 1) {
            throw new AssessmentError('XG_BAD_PARAM', '查询参数不合法', 400);
          }
        }
        const match = await scopedMatch(principal, requireId(url.searchParams.get('match_id'), 'match_id'));
        const replay = url.pathname.endsWith('/event-score-replay');
        if (!replay && !store.provenance) throw new AssessmentError('XG_NOT_READY', '历史计分依据存储尚未配置', 503);
        try {
          sendJson(res, 200, replay ? await repository.replayScores(match.match_id, url.searchParams.get('event_id'))
            : await store.provenance.eventBasis(match.match_id, url.searchParams.get('event_id')));
        } catch (error) {
          if (error.code === 'XG_SCOPE_MISMATCH') deny();
          throw error;
        }
      } else if (url.pathname === '/v1/xg/intakes' && req.method === 'POST') {
        const body = await readJson(req);
        fields(body, ['answers', 'visitor_name']);
        if (!body.answers || Object.getPrototypeOf(body.answers) !== Object.prototype ||
            (body.visitor_name !== undefined && typeof body.visitor_name !== 'string')) {
          throw new AssessmentError('XG_BAD_PARAM', '评估输入格式错误', 400);
        }
        // These are intake answers, not four-assessment scores. No scores are trusted here.
        sendJson(res, 201, await identity.createIntake(principal, {
          answers: body.answers, visitor_name: (body.visitor_name || '').slice(0, 100)
        }));
      } else if (url.pathname === '/v1/xg/match-requests' && req.method === 'POST') {
        const body = await readJson(req);
        fields(body, ['assessment_id', 'counselor_id']);
        requireId(body.counselor_id, 'counselor_id');
        const counselor = await store.findById('counselors', body.counselor_id);
        if (!counselor || !counselor.is_active || counselor.review_status !== 'approved' ||
            counselor.is_demo || demoCounselorIds.includes(counselor.id)) deny('咨询师不可申请');
        const request = await identity.requestMatch(principal, body);
        sendJson(res, 201, { request_id: request.request_id, status: request.status });
      } else if (/^\/v1\/xg\/match-requests\/[^/]+\/approve$/.test(url.pathname) && req.method === 'POST') {
        fields(await readJson(req), []);
        const request = await identity.approveRequest(principal, url.pathname.split('/')[4]);
        sendJson(res, 200, { request_id: request.request_id, status: request.status });
      } else if (url.pathname === '/v1/xg/matches' && req.method === 'POST') {
        const body = await readJson(req);
        fields(body, ['request_id', 'previous_match_id']);
        const request = await identity.approvedRequest(principal, body.request_id);
        await identity.requireVisitor(request.visitor_id);
        const counselor = await store.findById('counselors', request.counselor_id);
        if (!counselor || !counselor.is_active || counselor.review_status !== 'approved' ||
            counselor.is_demo || demoCounselorIds.includes(counselor.id)) deny();
        const match = await repository.createMatch({
          match_id: documentKey('match-request', request.request_id),
          visitor_id: request.visitor_id, counselor_id: request.counselor_id,
          assessment_id: request.assessment_id, previous_match_id: body.previous_match_id
        });
        sendJson(res, 200, metadata(match));
      } else if (/^\/v1\/xg\/matches\/[^/]+$/.test(url.pathname) && req.method === 'GET') {
        sendJson(res, 200, metadata(await scopedMatch(principal, url.pathname.split('/')[4])));
      } else if (url.pathname === '/v1/xg/case-switch' && ['GET', 'POST'].includes(req.method)) {
        let id, patch, options;
        if (req.method === 'GET') {
          for (const key of url.searchParams.keys()) if (key !== 'match_id' || url.searchParams.getAll(key).length !== 1) throw new AssessmentError('XG_BAD_PARAM', '查询参数不合法', 400);
          id = url.searchParams.get('match_id');
        } else {
          if ([...url.searchParams.keys()].length) throw new AssessmentError('XG_BAD_PARAM', '此接口不接受查询参数', 400);
          const body = await readJson(req);
          fields(body, ['match_id', 'enable_reminder', 'enable_cst', 'expected_revision', 'reason']);
          id = body.match_id;
          options = { expected_revision: body.expected_revision, reason: body.reason };
          patch = Object.fromEntries(['enable_reminder', 'enable_cst'].filter((key) => key in body).map((key) => [key, body[key]]));
          if (!Object.keys(patch).length || Object.values(patch).some((value) => typeof value !== 'boolean')) {
            throw new AssessmentError('XG_BAD_PARAM', '开关必须为布尔值', 400);
          }
        }
        const result = await identity.caseSwitch(principal, id, patch, options);
        sendJson(res, 200, result);
      } else if (['/v1/xg/events/start', '/v1/xg/events', '/v1/xg/events/abandon'].includes(url.pathname) && req.method === 'POST') {
        const body = await readJson(req);
        const operation = url.pathname.endsWith('/start') ? 'start' : url.pathname.endsWith('/abandon') ? 'abandon' : 'submit';
        fields(body, operation === 'start' ? ['match_id', 'scale_code', 'session_no', 'follow_round', 'client_event_id', 'request_id']
          : operation === 'abandon' ? ['match_id', 'event_id', 'reason', 'request_id']
            : ['match_id', 'event_id', 'scale_code', 'session_no', 'follow_round', 'client_event_id', 'answers', 'duration_ms', 'request_id']);
        if (operation !== 'start' || body.request_id !== undefined) requireId(body.request_id, 'request_id');
        if (!store.lifecycle) throw new AssessmentError('XG_NOT_READY', '作答状态服务尚未配置', 503);
        let result;
        try { result = await store.lifecycle[operation](principal, body); }
        catch (error) { if (error.code === 'XG_SCOPE_MISMATCH') deny(); throw error; }
        const event = result.event;
        const response = { event_id: event.event_id, scale_code: event.scale_code, status: event.status,
          revision: event.event_revision || 0, duplicated: result.duplicated === true,
          replayed: result.replayed === true, request_status: result.request_status, request_revision: result.request_revision };
        if (result.error) response.error = result.error;
        else if (operation === 'start') {
          response.started_at = event.started_at || event.created_at;
          response.expires_at = event.expires_at || null;
          response.form = formView(event);
        } else if (operation === 'submit' && event.status === 'submitted') {
          response.saved = true;
          if(event.scale_code==='xg_risk_recheck'&&event.raw_answers.k1>=event.basis.rules.risk_recheck.urgent_min){response.out_of_scope=true;response.reason='risk_recheck_red_line';response.next_action='out_of_scope';}
          if (principal.role === 'visitor') response.visitor_view = { message: response.out_of_scope?'当前周期已停止评估，请联系咨询师核对后续安排。':'已记下，谢谢你照实说。' };
          else { response.total = event.scores.total; response.pct = event.scores.pct; }
        } else if (operation === 'abandon') response.abandoned_at = event.abandoned_at;
        sendJson(res, result.statusCode || (operation !== 'abandon' && !result.duplicated ? 201 : 200), response);
      } else {
        sendJson(res, 404, { error: { code: 'XG_NOT_FOUND', message: '接口不存在' } });
      }
    } catch (error) {
      const known = error instanceof AssessmentError;
      sendJson(res, known ? error.statusCode : 500, {
        error: { code: known ? error.code : 'XG_INTERNAL', message: known ? error.message : '服务暂时不可用' }
      });
    }
    return true;
  };
}

module.exports = { createAssessmentHttp };
