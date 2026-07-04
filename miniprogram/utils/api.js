const config = require('./config');

function localApiHosts() {
  return Array.isArray(config.localApiHosts) ? config.localApiHosts.filter(Boolean) : [];
}

function fallbackUrl(url, attemptedHosts) {
  const hosts = localApiHosts();
  const current = hosts.find((host) => url.indexOf(host) === 0);
  if (!current) return '';
  return hosts
    .filter((host) => host !== current && !attemptedHosts.includes(host))
    .map((host) => host + url.slice(current.length))[0] || '';
}

function request(options) {
  const attemptedHosts = options._attemptedHosts || [];
  const wxOptions = { ...options };
  delete wxOptions._attemptedHosts;
  return new Promise((resolve, reject) => {
    wx.request({
      ...wxOptions,
      timeout: config.requestTimeoutMs || 5000,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          const data = res.data || {};
          const message = data.message || data.error || data.details || JSON.stringify(data);
          reject(new Error(message ? `HTTP ${res.statusCode}: ${message}` : `HTTP ${res.statusCode}`));
        }
      },
      fail(err) {
        const nextUrl = fallbackUrl(options.url, attemptedHosts);
        if (nextUrl) {
          const currentHost = localApiHosts().find((host) => options.url.indexOf(host) === 0);
          console.warn('[小平菇] 本地 API 请求失败，切换备用地址', options.url, '=>', nextUrl, err && err.errMsg);
          request({
            ...options,
            url: nextUrl,
            _attemptedHosts: currentHost ? attemptedHosts.concat(currentHost) : attemptedHosts
          }).then(resolve).catch(reject);
          return;
        }
        const message = err && err.errMsg ? err.errMsg : '网络请求失败';
        reject(new Error(`${message} (${options.url})`));
      }
    });
  });
}

function supabase(path, method = 'GET', data) {
  return request({
    url: `${config.supabaseUrl}/rest/v1/${path}`,
    method,
    data,
    header: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${config.supabaseAnonKey}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : 'return=minimal'
    }
  });
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function miniLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      success(loginRes) {
        if (config.apiBase) {
          request({
            url: `${config.apiBase}/wechat/login`,
            method: 'POST',
            data: { code: loginRes.code }
          }).then(resolve).catch(reject);
          return;
        }

        const visitor = {
          id: '',
          openid: config.devOpenid,
          nickname: '微信来访者'
        };

        supabase('visitor_users?on_conflict=openid', 'POST', {
          openid: visitor.openid,
          nickname: visitor.nickname,
          last_login_at: new Date().toISOString()
        }).then((rows) => {
          if (Array.isArray(rows) && rows[0]) {
            visitor.id = rows[0].id;
          }
          resolve(visitor);
        }).catch(() => resolve(visitor));
      },
      fail: reject
    });
  });
}

function createAssessment(visitor, payload) {
  const id = uuid();
  const body = {
    id,
    view_token: id,
    visitor_user_id: visitor.id || null,
    visitor_openid: visitor.openid,
    user_agent: 'wechat-miniprogram',
    ...payload
  };
  return supabase('assessments', 'POST', body).then(() => body);
}

function listMyAssessments(openid) {
  return supabase(`assessments?visitor_openid=eq.${encodeURIComponent(openid)}&select=*&order=created_at.desc`, 'GET');
}

function listApprovedCounselors() {
  return supabase('counselors?is_active=eq.true&review_status=eq.approved&select=*&order=created_at.desc', 'GET');
}

function updateAssessment(id, patch) {
  return supabase(`assessments?id=eq.${encodeURIComponent(id)}`, 'PATCH', {
    ...patch,
    updated_at: new Date().toISOString()
  });
}

function createSession(data) {
  return supabase('sessions', 'POST', data);
}

function savePcomsRating(data) {
  return supabase('pcoms_ratings', 'POST', data);
}

module.exports = {
  miniLogin,
  createAssessment,
  listMyAssessments,
  listApprovedCounselors,
  updateAssessment,
  createSession,
  savePcomsRating,
  uuid
};
