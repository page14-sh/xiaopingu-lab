// 小平菇 Web 端登录会话工具
// 用于后台管理员与咨询师工作台。正式生产鉴权仍应放到服务端 / Supabase Auth。
(function() {
  var KEY_PREFIX = 'xiaopingu_web_session_';
  var DEFAULT_TTL = 2 * 60 * 60 * 1000;

  function now() {
    return Date.now();
  }

  function key(role) {
    return KEY_PREFIX + role;
  }

  function setSession(role, subjectId, meta, ttlMs) {
    var session = {
      role: role,
      subject_id: subjectId || '',
      meta: meta || {},
      created_at: now(),
      expires_at: now() + (ttlMs || DEFAULT_TTL)
    };
    sessionStorage.setItem(key(role), JSON.stringify(session));
    return session;
  }

  function getSession(role) {
    try {
      var raw = sessionStorage.getItem(key(role));
      if (!raw) return null;
      var session = JSON.parse(raw);
      if (!session || !session.expires_at || session.expires_at < now()) {
        clearSession(role);
        return null;
      }
      return session;
    } catch (e) {
      clearSession(role);
      return null;
    }
  }

  function clearSession(role) {
    sessionStorage.removeItem(key(role));
  }

  function getSubject(role) {
    var session = getSession(role);
    return session ? session.subject_id : '';
  }

  window.XPG_WEB_AUTH = {
    setSession: setSession,
    getSession: getSession,
    clearSession: clearSession,
    getSubject: getSubject
  };
})();
