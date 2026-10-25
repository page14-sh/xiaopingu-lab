const { createHmac, timingSafeEqual } = require('node:crypto');
const { AssessmentError, SCALES, requireId, eventPosition } = require('./model');

const AUDIENCE = 'xg-assessment';
function deny(message = '无权操作该资源') { throw new AssessmentError('XG_FORBIDDEN', message, 403); }
function unauthorized() { throw new AssessmentError('XG_UNAUTHORIZED', '请重新登录', 401); }

function requirePrincipal(session) {
  if (!session || !Number.isFinite(session.exp) || session.exp <= Date.now() ||
      session.aud !== AUDIENCE || typeof session.subject !== 'string') unauthorized();
  if (session.demo !== false) deny('演示会话不可访问四评');
  const methods = { visitor: 'wechat-cloud', counselor: 'counselor-edit', admin: 'admin-password' };
  if (!Object.hasOwn(methods, session.role) || session.auth_method !== methods[session.role]) unauthorized();
  requireId(session.subject, 'subject');
  return session;
}

function fields(body, allowed) {
  if (!body || Object.getPrototypeOf(body) !== Object.prototype ||
      Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new AssessmentError('XG_BAD_PARAM', '请求含不支持的字段', 400);
  }
}

function verifyAssertion(assertion, { secret, appId, audience }, now = Date.now()) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || !appId || !audience) {
    throw new AssessmentError('XG_AUTH_NOT_CONFIGURED', '四评微信身份服务尚未配置', 503);
  }
  if (typeof assertion !== 'string' || assertion.length > 4096) unauthorized();
  const parts = assertion.split('.');
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) unauthorized();
  const expected = Buffer.from(createHmac('sha256', secret).update(parts[0]).digest('base64url'));
  const signature = Buffer.from(parts[1]);
  if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) unauthorized();
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch { unauthorized(); }
  const seconds = Math.floor(now / 1000);
  if (!payload || payload.iss !== 'xpg-wechat-cloud' || payload.aud !== audience || payload.appid !== appId ||
      !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
      payload.iat > seconds + 5 || payload.exp <= seconds || payload.exp <= payload.iat ||
      payload.exp - payload.iat > 60 || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.openid || '') ||
      !/^[a-f0-9-]{36}$/.test(payload.jti || '')) unauthorized();
  return payload;
}

function authorizeMatch(principal, match) {
  requirePrincipal(principal);
  if (principal.role === 'admin') return;
  if (principal.role === 'visitor' && match.visitor_id === principal.subject) return;
  if (principal.role === 'counselor' && match.counselor_id === principal.subject) return;
  deny();
}

function cardActor(principal, match, input) {
  authorizeMatch(principal, match);
  eventPosition(input);
  const role = input.scale_code === SCALES.pro ? 'counselor' : 'visitor';
  if (principal.role !== role) deny('只能填写自己角色的卡片，管理员也不可代填');
  if (input.scale_code === SCALES.follow && match.status !== 'closed') {
    throw new AssessmentError('XG_RELATION_ACTIVE', '该周期尚未结案', 409);
  }
  if (match.status === 'closed' && ![SCALES.end, SCALES.evaluation, SCALES.follow].includes(input.scale_code)) {
    throw new AssessmentError('XG_RELATION_CLOSED', '该周期已结案', 409);
  }
  return { actor_id: principal.subject, actor_role: role };
}

module.exports = { AUDIENCE, deny, unauthorized, fields, requirePrincipal, verifyAssertion, authorizeMatch, cardActor };
