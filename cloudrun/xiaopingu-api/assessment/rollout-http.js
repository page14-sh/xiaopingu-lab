const { AssessmentError, requireId } = require('./model');
const { fields, deny } = require('./authorization');
function params(search, allowed) {
  for (const key of search.keys()) if (!allowed.includes(key) || search.getAll(key).length !== 1) throw new AssessmentError('XG_BAD_PARAM', '查询参数不合法', 400);
}
function integer(search, key, fallback) {
  if (!search.has(key) && fallback !== undefined) return fallback;
  const value = search.get(key);
  if (!/^(0|[1-9][0-9]*)$/.test(value || '') || !Number.isSafeInteger(Number(value))) throw new AssessmentError('XG_BAD_PARAM', '分页或修订号不合法', 400);
  return Number(value);
}
async function handleRollout({ req, res, url, principal, repository, readJson, sendJson }) {
  const root = '/v1/xg/admin/rollout', inbox = '/v1/xg/counselor/inbox';
  if (![root, `${root}/rollback`, `${root}/history`, inbox].includes(url.pathname)) return false;
  if (url.pathname === inbox ? !['admin','counselor'].includes(principal.role) : principal.role !== 'admin') deny();
  if (url.pathname === inbox && req.method === 'GET') {
    params(url.searchParams, ['match_id','session_no','alert_type','status','limit','offset']);
    const result = await repository.reminderInbox(principal, requireId(url.searchParams.get('match_id'), 'match_id'), {
      session_no: url.searchParams.has('session_no') ? integer(url.searchParams, 'session_no') : undefined,
      alert_type: url.searchParams.get('alert_type') ?? undefined,
      status: url.searchParams.get('status') ?? 'pending',
      limit: integer(url.searchParams, 'limit', 50), offset: integer(url.searchParams, 'offset', 0)
    });
    sendJson(res, 200, result);
  } else if (url.pathname === `${root}/history` && req.method === 'GET') {
    params(url.searchParams, ['scope','match_id','revision']);
    const scope = url.searchParams.get('scope');
    if (scope === 'global' && url.searchParams.has('match_id')) throw new AssessmentError('XG_BAD_PARAM', '全局历史不接受周期参数', 400);
    sendJson(res, 200, await repository.rolloutHistory(principal, scope, url.searchParams.get('match_id'), integer(url.searchParams, 'revision')));
  } else if (url.pathname === root && req.method === 'GET') {
    params(url.searchParams, []); sendJson(res, 200, await repository.getRollout());
  } else if ([root, `${root}/rollback`].includes(url.pathname) && req.method === 'POST') {
    params(url.searchParams, []);
    const body = await readJson(req), rollback = url.pathname.endsWith('/rollback');
    const flags = ['enable_reminder','enable_cst','emergency_stop','collection_paused'];
    fields(body, rollback ? ['expected_revision','reason'] : ['expected_revision','reason', ...flags]);
    const patch = Object.fromEntries(flags.filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]]));
    sendJson(res, 200, await repository.updateRollout(principal, { expected_revision: body.expected_revision, patch, reason: body.reason }, { rollback }));
  } else sendJson(res, 405, { error: { code: 'XG_METHOD_NOT_ALLOWED', message: '该接口不支持此方法' } });
  return true;
}
module.exports = { handleRollout };
