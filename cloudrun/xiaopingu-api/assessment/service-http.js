const { createHash, timingSafeEqual } = require('node:crypto');
const { AssessmentError, requireId } = require('./model');
const { fields } = require('./authorization');
function authenticateService(req, secret, otherSecret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || secret === otherSecret) {
    throw new AssessmentError('XG_SERVICE_NOT_CONFIGURED', '专用服务凭据尚未配置', 503);
  }
  const value = req.headers.authorization;
  const token = typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : '';
  const digest = (text) => createHash('sha256').update(text).digest();
  if (!token || !timingSafeEqual(digest(token), digest(secret))) throw new AssessmentError('XG_UNAUTHORIZED', '服务身份无效', 401);
}
async function handleService({ req, res, url, store, secrets = {}, readJson, sendJson }) {
  const closing = url.pathname === '/v1/xg/m4/close';
  const dispatch = url.pathname === '/v1/xg/jobs/follow-dispatch';
  const deliver = url.pathname === '/v1/xg/jobs/notification-deliver';
  const reap = url.pathname === '/v1/xg/jobs/events-expire';
  const llmRun = url.pathname === '/v1/xg/jobs/llm-run';
  const llmRecover = url.pathname === '/v1/xg/jobs/llm-recover';
  const llmOne = url.pathname === '/v1/xg/internal/llm-score';
  if (!closing && !dispatch && !deliver && !reap && !llmRun && !llmRecover && !llmOne) return false;
  authenticateService(req, closing ? secrets.matching : secrets.scheduler, closing ? secrets.scheduler : secrets.matching);
  if (req.method !== 'POST') { sendJson(res, 405, { error: { code: 'XG_METHOD_NOT_ALLOWED', message: '服务入口仅支持POST' } }); return true; }
  if ([...url.searchParams.keys()].length) throw new AssessmentError('XG_BAD_PARAM', '服务入口不接受查询参数', 400);
  const body = await readJson(req);
  if (closing) {
    fields(body, ['match_id','session_no']);
    const match = await store.assessment.closeMatch(requireId(body.match_id, 'match_id'), body.session_no);
    sendJson(res, 200, { match_id: match.match_id, status: match.status, closed_at: match.closed_at,
      closing_session_no: match.closing_session_no, follow_scheduled: ['1m','3m'],
      follow_1m_due_at: match.followup_due['1m'], follow_3m_due_at: match.followup_due['3m'] });
  } else if (llmRun || llmRecover || llmOne) {
    fields(body,llmOne?['event_id']:['limit']);
    if (!store.llmWorker) throw new AssessmentError('XG_NOT_READY','模型任务尚未配置',503);
    const result=llmOne?await store.llmWorker.processTask(requireId(body.event_id,'event_id')):llmRecover?await store.llmWorker.recover(body):await store.llmWorker.runBatch(body);
    sendJson(res,200,result);
  } else if (reap) {
    fields(body, ['limit']);
    if (!store.lifecycle) throw new AssessmentError('XG_NOT_READY','作答服务尚未配置',503);
    sendJson(res,200,await store.lifecycle.reapExpired(body));
  } else if (deliver) {
    fields(body, ['limit']);
    if (!store.notificationWorker) throw new AssessmentError('XG_NOT_READY', '通知发送尚未配置', 503);
    sendJson(res, 200, await store.notificationWorker.runBatch(body));
  } else {
    fields(body, ['limit']);
    if (!store.followups) throw new AssessmentError('XG_NOT_READY', '随访调度尚未配置', 503);
    sendJson(res, 200, await store.followups.dispatchDue(body));
  }
  return true;
}
module.exports = { handleService };
