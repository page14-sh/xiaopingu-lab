const { createLegacyRest } = require('./legacy-rest');
const { SETUP_AUDIENCE, PROFILE_AUDIENCE } = require('./counselor-access');
const { AUDIENCE, fields } = require('../assessment/authorization');
const { AssessmentError } = require('../assessment/model');
const { LoginRateLimiter } = require('./login-code');
const { createHash } = require('node:crypto');

function createAccessHttp({ portal, photos, signSession, sessionSecret, readJson, sendJson }) {
  const access = portal.access, rest = createLegacyRest({ db: portal.db, hooks: portal, photos });
  const limiter = new LoginRateLimiter();
  const routes = ['/auth/counselor/phone', '/auth/counselor/password', '/auth/counselor/invite',
    '/v1/xg/portal/counselor-access', '/v1/xg/portal/shared-profile'];
  function signed(data, setup = false) {
    const exp = Date.now() + (setup ? 10 * 60000 : 24 * 3600000);
    const token = signSession({ role: 'counselor', subject: data.id, demo: false, exp,
      aud: setup ? SETUP_AUDIENCE : AUDIENCE, auth_method: setup ? 'counselor-phone-initial' : 'counselor-phone',
      account_revision: data.revision }, sessionSecret);
    return setup ? { must_change_password: true, setup_token: token, expires_at: exp } :
      { token, expires_at: exp, counselor: { id: data.id }, must_change_password: false };
  }
  return async function handle(req, res, url, session) {
    if (!routes.includes(url.pathname)) return false;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Vary', 'Authorization');
    try {
      if (url.search) throw new AssessmentError('XPG_BAD_PARAM', '此接口不接受链接查询参数', 400);
      const p = url.pathname;
      if (p === '/v1/xg/portal/shared-profile') {
        if (!['GET', 'PATCH'].includes(req.method)) throw new AssessmentError('XPG_METHOD', '不支持的操作', 405);
        const row = await access.validateInvite(session);
        if (req.method === 'PATCH') req.__bodyRaw = JSON.stringify(await readJson(req, 3 * 1024 * 1024));
        await rest(req, res, 'counselors', new URLSearchParams({ id: 'eq.' + row.id }),
          { role: 'counselor', counselorId: row.id, counselor: row, principal: session, profileOnly: true });
        return true;
      }
      if (req.method !== 'POST') throw new AssessmentError('XPG_METHOD', '不支持的操作', 405);
      const body = await readJson(req, 4096);
      if (p === '/auth/counselor/phone') {
        fields(body, ['phone', 'password']);
        // Per-account counters persist in NoSQL. The coarse process limiter
        // also bounds unknown-account attempts without creating arbitrary rows.
        const key = createHash('sha256').update(String(body.phone || '').slice(0, 32)).digest('hex');
        const ip = String(req.socket?.remoteAddress || 'gateway');
        if (!limiter.allowed(ip, key)) throw new AssessmentError('XPG_LOGIN_THROTTLED', '尝试过多，请稍后再试。', 429);
        let result;
        try { result = await access.login(body.phone, body.password); }
        catch (error) { if ([401, 429].includes(error.statusCode)) limiter.recordFailure(ip, key); throw error; }
        limiter.reset(key); sendJson(res, 200, signed(result, result.must_change));
      } else if (p === '/auth/counselor/password') {
        fields(body, ['new_password']); sendJson(res, 200, signed(await access.setPassword(session, body.new_password)));
      } else if (p === '/auth/counselor/invite') {
        fields(body, ['invite']); const grant = await access.exchangeInvite(body.invite);
        const token = signSession({ role: 'counselor', subject: grant.id, aud: PROFILE_AUDIENCE, auth_method: 'profile-invite',
          demo: false, invite_generation: grant.generation, exp: grant.expires_at }, sessionSecret);
        sendJson(res, 200, { token, expires_at: grant.expires_at });
      } else {
        fields(body, ['action', 'counselor_id']);
        if (body.action === 'issue') sendJson(res, 200, await access.issueInvite(session, body.counselor_id));
        else if (body.action === 'revoke') sendJson(res, 200, await access.revokeInvite(session, body.counselor_id));
        else if (body.action === 'reset_phone') sendJson(res, 200, await access.resetPhone(session, body.counselor_id));
        else throw new AssessmentError('XPG_BAD_PARAM', '不支持的操作', 400);
      }
    } catch (error) {
      sendJson(res, error.statusCode || 503, { code: error.code || 'XPG_ACCESS_UNAVAILABLE',
        message: error.statusCode ? error.message : '服务暂不可用，请稍后重试。' });
    }
    return true;
  };
}
module.exports = { createAccessHttp };
