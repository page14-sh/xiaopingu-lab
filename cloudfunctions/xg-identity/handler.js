const crypto = require('node:crypto');

function createIdentityHandler({ getWXContext, parseContext, secret, appId, audience, now = Date.now }) {
  return async function main(_event, context) {
    if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || !appId || !audience) {
      throw new Error('Identity bridge is not configured');
    }
    // Check per-invocation context as well: getWXContext may otherwise retain identity
    // from a previous invocation when the platform reuses the process.
    const parsed = parseContext(context);
    const invocation = parsed.environment || parsed.environ || {};
    const wx = getWXContext();
    if (!['wx_client', 'wx_devtools'].includes(wx.SOURCE) || wx.APPID !== appId ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(wx.OPENID || '') ||
        invocation.WX_OPENID !== wx.OPENID || invocation.WX_APPID !== wx.APPID) {
      throw new Error('Verified Mini Program identity required');
    }
    const issued = Math.floor(now() / 1000);
    const payload = {
      iss: 'xpg-wechat-cloud', aud: audience, appid: appId, openid: wx.OPENID,
      jti: crypto.randomUUID(), iat: issued, exp: issued + 60
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
    return { assertion: `${encoded}.${signature}`, expires_in: 60 };
  };
}

module.exports = { createIdentityHandler };
