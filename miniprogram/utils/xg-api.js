const config = require('./config');

function createXgClient(wxApi, settings, now = Date.now) {
  let session;
  let pending;
  let initialized = false;
  function init() {
    if (!wxApi.cloud || !settings.cloudEnv) throw new Error('四评微信云环境尚未配置');
    if (!initialized) {
      wxApi.cloud.init({ env: settings.cloudEnv, traceUser: true });
      initialized = true;
    }
  }
  function send(path, method, data, token) {
    if (!settings.apiBase) return Promise.reject(new Error('四评 API 尚未配置'));
    return new Promise((resolve, reject) => wxApi.request({
      url: `${settings.apiBase}${path}`, method, data, timeout: settings.requestTimeoutMs || 10000,
      header: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(res.data);
        if (res.statusCode === 401) session = null;
        const error = new Error((res.data && res.data.error && res.data.error.message) || '四评请求失败');
        error.statusCode = res.statusCode;
        reject(error);
      },
      fail() { reject(new Error('四评服务连接失败，请稍后重试')); }
    }));
  }
  async function ensureSession() {
    if (session && session.expires_at > now() + 10000) return session;
    if (pending) return pending;
    pending = (async () => {
      init();
      const response = await wxApi.cloud.callFunction({ name: settings.identityFunction || 'xg-identity', data: {} });
      if (!response.result || typeof response.result.assertion !== 'string') throw new Error('未获取到可信微信身份');
      const result = await send('/auth/visitor', 'POST', { assertion: response.result.assertion });
      if (!result || typeof result.token !== 'string' || !result.visitor || !result.visitor.id ||
          !Number.isFinite(result.expires_at) || result.expires_at <= now()) throw new Error('四评登录响应无效');
      session = result;
      return session;
    })();
    try { return await pending; } finally { pending = null; }
  }
  return {
    init, ensureSession,
    // Call directly from a user tap handler, before awaiting login/network work.
    requestSubscription(templateId) {
      if (typeof templateId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(templateId) || typeof wxApi.requestSubscribeMessage !== 'function') {
        return Promise.reject(new Error('订阅消息尚未配置'));
      }
      return new Promise((resolve, reject) => wxApi.requestSubscribeMessage({
        tmplIds: [templateId],
        success(result) { resolve({ accepted: result[templateId] === 'accept' }); },
        fail() { reject(new Error('订阅授权未完成')); }
      }));
    },
    clearSession() { session = null; },
    async request(path, method = 'GET', data) {
      if (typeof path !== 'string' || !path.startsWith('/') || path.includes('..')) throw new Error('无效四评路径');
      const current = await ensureSession();
      return send(`/v1/xg${path}`, method, data, current.token);
    }
  };
}

let client;
function currentClient() {
  if (!client) client = createXgClient(wx, config);
  return client;
}
module.exports = {
  createXgClient,
  initXgCloud: () => currentClient().init(),
  ensureXgSession: () => currentClient().ensureSession(),
  xgRequest: (...args) => currentClient().request(...args),
  requestXgSubscription: (templateId) => currentClient().requestSubscription(templateId),
  clearXgSession: () => currentClient().clearSession()
};
