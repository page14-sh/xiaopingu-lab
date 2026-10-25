/* 小平菇 · 四评　共享配置与身份
 * 所有页面共用。API 走腾讯云云函数 xg-api（四评 V3.2）。
 */
(function (global) {
  'use strict';

  var CONFIG = {
    API_BASE: 'https://xpg-demo-d3gzsswtcc3233ea0-1300577165.ap-shanghai.app.tcloudbase.com/xg-api',
    // 不提供默认身份；令牌只来自实际登录或受保护的初评桥接。
    DEMO: { visitorOpenid:'', counselorToken:'', adminToken:'' }
  };

  var K = {
    role: 'xg_role',
    visitorOpenid: 'xg_visitor_openid',
    counselorToken: 'xg_counselor_token',
    adminToken: 'xg_admin_token',
    matchId: 'xg_match_id',
    sessionNo: 'xg_session_no',
    focusUser: 'xg_focus_user'
  };

  function ls(k, v) {
    if (typeof v === 'undefined') {
      try { return localStorage.getItem(k); } catch (e) { return null; }
    }
    try { localStorage.setItem(k, v); } catch (e) {}
    return v;
  }

  var Identity = {
    keys: K,
    getRole: function () { return ls(K.role) || 'visitor'; },
    setRole: function (r) { ls(K.role, r); },
    getToken: function (role) {
      role = role || Identity.getRole();
      if (role === 'counselor') return ls('xiaopingu_counselor_token') || ls(K.counselorToken) || '';
      if (role === 'admin') return sessionStorage.getItem('xiaopingu_admin_token') || ls(K.adminToken) || '';
      return ls(K.visitorOpenid) || '';
    },
    setToken: function (role, v) {
      if (role === 'counselor') ls(K.counselorToken, v);
      else if (role === 'admin') ls(K.adminToken, v);
      else ls(K.visitorOpenid, v);
    },
    getMatchId: function () {
      var q = new URLSearchParams(location.search).get('match_id');
      return q || ls(K.matchId) || '';
    },
    setMatchId: function (v) { ls(K.matchId, v); },
    getSessionNo: function () {
      var q = new URLSearchParams(location.search).get('session_no');
      return q ? parseInt(q, 10) : (parseInt(ls(K.sessionNo) || '0', 10) || 0);
    },
    setSessionNo: function (v) { ls(K.sessionNo, String(v)); },
    getFocusUser: function () {
      var q = new URLSearchParams(location.search).get('user_id');
      return q || ls(K.focusUser) || '';
    },
    setFocusUser: function (v) { ls(K.focusUser, v); },
    clear: function () {
      [K.role, K.visitorOpenid, K.counselorToken, K.adminToken, K.matchId, K.sessionNo, K.focusUser]
        .forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
    }
  };

  global.XG = global.XG || {};
  global.XG.CONFIG = CONFIG;
  global.XG.Identity = Identity;
})(window);
