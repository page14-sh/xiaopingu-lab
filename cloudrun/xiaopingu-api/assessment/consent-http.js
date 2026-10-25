const { AssessmentError, requireId } = require('./model');
const { fields, deny } = require('./authorization');
const { validScope } = require('./consent');

function parameters(params, allowed) {
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new AssessmentError('XG_BAD_PARAM', '查询参数不合法', 400);
  }
}
function pagination(params) {
  function get(key, fallback, min, max) {
    if (!params.has(key)) return fallback;
    const raw = params.get(key);
    if (!/^(0|[1-9][0-9]*)$/.test(raw) || Number(raw) < min || Number(raw) > max) {
      throw new AssessmentError('XG_BAD_PARAM', '分页参数不合法', 400);
    }
    return Number(raw);
  }
  return { limit: get('limit', 50, 1, 200), offset: get('offset', 0, 0, 100000) };
}

async function handleConsent({ req, res, url, principal, consent, scopedMatch, readJson, sendJson, collectionPaused, riskStatus, followups }) {
  const own = url.pathname === '/v1/xg/me/consent';
  const history = url.pathname === '/v1/xg/me/consent/history';
  const admin = url.pathname === '/v1/xg/admin/consents';
  const prompts = url.pathname === '/v1/xg/prompts/next';
  if (!own && !history && !admin && !prompts) return false;
  if (prompts ? !['visitor', 'counselor'].includes(principal.role)
    : admin ? principal.role !== 'admin' : principal.role !== 'visitor') deny('无权访问该同意记录');
  if (!consent) throw new AssessmentError('XG_NOT_READY', '同意记录存储尚未配置', 503);
  if (prompts && req.method === 'GET') {
    parameters(url.searchParams, ['match_id', 'session_no', 'role', 'scope']);
    if (url.searchParams.has('role') && url.searchParams.get('role') !== principal.role) deny();
    if (url.searchParams.has('session_no')) {
      const number = url.searchParams.get('session_no');
      if (!/^(0|[1-9][0-9]*)$/.test(number) || !Number.isSafeInteger(Number(number))) {
        throw new AssessmentError('XG_BAD_PARAM', '节次不合法', 400);
      }
    }
    const match = await scopedMatch(principal, url.searchParams.get('match_id'));
    if(riskStatus){const risk=await riskStatus(match.match_id);if(risk.out_of_scope){sendJson(res,200,{prompts:[],...risk,next_action:'out_of_scope'});return true;}}
    if (collectionPaused && await collectionPaused()) {
      sendJson(res, 200, { prompts: [] });
      return true;
    }
    const scope = validScope(url.searchParams.get('scope') ?? (match.status === 'closed' ? 'followup' : 'assessment'));
    const status = await consent.getStatus(match.visitor_id, scope);
    if (!status.agreed) sendJson(res, 200, { prompts: [] });
    else if (followups) sendJson(res, 200, { prompts: await followups.prompts(principal, match.match_id, {
      scope, session_no: url.searchParams.has('session_no') ? Number(url.searchParams.get('session_no')) : undefined
    }) });
    else throw new AssessmentError('XG_NOT_READY', '卡片排程存储尚未配置', 503);
    return true;
  }
  if (prompts) {
    sendJson(res, 405, { error: { code: 'XG_METHOD_NOT_ALLOWED', message: '该接口仅支持读取' } });
    return true;
  }
  if (req.method === 'GET') {
    parameters(url.searchParams, admin ? ['visitor_id', 'scope', 'limit', 'offset']
      : history ? ['scope', 'limit', 'offset'] : ['scope']);
    const scope = validScope(url.searchParams.get('scope') ?? 'assessment');
    const visitorId = admin ? requireId(url.searchParams.get('visitor_id'), 'visitor_id') : principal.subject;
    if (history) sendJson(res, 200, { scope, history: await consent.history(visitorId, scope, pagination(url.searchParams)) });
    else {
      const status = await consent.getStatus(visitorId, scope);
      sendJson(res, 200, admin ? { ...status, history: await consent.history(visitorId, scope, pagination(url.searchParams)) } : status);
    }
  } else if (own && req.method === 'POST') {
    parameters(url.searchParams, []);
    const body = await readJson(req);
    fields(body, ['scope', 'version', 'document_hash', 'agreed', 'channel', 'client_event_id', 'expected_revision']);
    const result = await consent.decide(principal, body);
    sendJson(res, result.duplicated ? 200 : 201, result);
  } else sendJson(res, 405, { error: { code: 'XG_METHOD_NOT_ALLOWED', message: '该接口只允许规定的读写方法' } });
  return true;
}

module.exports = { handleConsent };
