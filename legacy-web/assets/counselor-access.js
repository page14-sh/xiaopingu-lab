(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const isShared = location.pathname.endsWith('/counselor.html') && params.get('invite') === '1';
  const sharedDemo = isShared && params.get('demo') === '1';
  let sharedSecret = isShared ? new URLSearchParams(location.hash.slice(1)).get('invite') : null;
  let profileToken = '';
  if (isShared) history.replaceState(null, '', location.pathname + location.search);
  const endpoint = path => SUPABASE_CONFIG.url + path;
  function node(tag, text, className) {
    const el = document.createElement(tag); if (text) el.textContent = text; if (className) el.className = className; return el;
  }
  function status(el, text, error) { el.textContent = text; el.dataset.error = String(!!error); }
  async function parse(response) {
    let data; try { data = await response.json(); } catch (_) { throw Error('服务返回异常，请稍后重试。'); }
    if (!response.ok) throw Error(data.message || '操作失败，请稍后重试。');
    return data;
  }
  async function post(path, data, token, retry, onRetry) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 110000);
    try {
      for (let i = 0; i < (retry ? 3 : 1); i++) {
        try {
          const response = await fetch(endpoint(path), { method: 'POST', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || 'phone-login') }, body: JSON.stringify(data) });
          if (![502, 503, 504].includes(response.status) || !retry || i === 2) return await parse(response);
        } catch (error) {
          if (!(error instanceof TypeError) || controller.signal.aborted || !retry || i === 2) throw error;
        }
        if (onRetry) onRetry();
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) throw Error('未能连接服务，请稍后重试。');
      throw error;
    } finally { clearTimeout(timer); }
  }
  function installPhoneForm(box) {
    const form = node('form', '', 'c-access-form'); form.setAttribute('aria-label', '手机号登录');
    const note = node('p', '使用档案中保存的手机号。首次密码为手机号后 6 位，验证后必须设置新密码。', 'c-access-note');
    const normal = node('div'), setup = node('div'); setup.hidden = true;
    function field(parent, label, name, type, autocomplete) {
      const wrap = node('label', label), input = document.createElement('input'); input.name = name; input.type = type;
      input.autocomplete = autocomplete; input.required = true; wrap.append(input); parent.append(wrap); return input;
    }
    const phone = field(normal, '手机号', 'phone', 'tel', 'username'); phone.inputMode = 'tel'; phone.maxLength = 20;
    const password = field(normal, '登录密码', 'password', 'password', 'current-password'); password.maxLength = 128;
    const newPassword = field(setup, '设置新密码（至少 10 位，含字母和数字）', 'new_password', 'password', 'new-password');
    const confirm = field(setup, '再次输入新密码', 'confirm_password', 'password', 'new-password');
    newPassword.disabled = confirm.disabled = true; newPassword.maxLength = confirm.maxLength = 128;
    const feedback = node('p', '', 'c-access-status'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
    const actions = node('div', '', 'c-access-actions'), submit = node('button', '手机号登录', 'c-access-button'), restart = node('button', '返回登录', 'c-access-button secondary');
    submit.type = 'submit'; restart.type = 'button'; restart.hidden = true; actions.append(submit, restart);
    form.append(note, normal, setup, feedback, actions); box.append(form); let setupToken = '';
    restart.onclick = () => {
      setupToken = ''; setup.hidden = true; normal.hidden = false; restart.hidden = true;
      newPassword.value = confirm.value = password.value = ''; newPassword.disabled = confirm.disabled = true;
      phone.disabled = password.disabled = false; submit.textContent = '手机号登录'; status(feedback, '');
    };
    form.onsubmit = async event => {
      event.preventDefault(); if (submit.disabled) return;
      if (localStorage.getItem('xpg_demo_active') === '1') { status(feedback, '当前为演示模式，请先退出演示，再使用本人手机号登录。', true); return; }
      if (setupToken && newPassword.value !== confirm.value) { status(feedback, '两次输入的新密码不一致。', true); return; }
      submit.disabled = restart.disabled = true; status(feedback, setupToken ? '正在保存新密码…' : '正在验证手机号和密码…');
      try {
        const result = setupToken ? await post('/auth/counselor/password', { new_password: newPassword.value }, setupToken, false) :
          await post('/auth/counselor/phone', { phone: phone.value.trim(), password: password.value }, '', true,
            () => status(feedback, '登录服务正在启动，正在自动重试…'));
        if (result.must_change_password) {
          if (!result.setup_token) throw Error('登录响应异常。');
          setupToken = result.setup_token; password.value = ''; normal.hidden = true; setup.hidden = false; restart.hidden = false;
          phone.disabled = password.disabled = true; newPassword.disabled = confirm.disabled = false;
          submit.textContent = '设置密码并登录'; status(feedback, '默认密码验证成功。设置新密码后才能查看档案和工作台。'); newPassword.focus(); return;
        }
        if (!result.token || !result.counselor?.id) throw Error('登录响应异常。');
        localStorage.setItem('xiaopingu_counselor_token', result.token);
        localStorage.setItem('xiaopingu_counselor_id', result.counselor.id);
        sessionStorage.removeItem('xiaopingu_admin_token');
        setupToken = ''; password.value = newPassword.value = confirm.value = '';
        status(feedback, '登录成功，正在打开工作台。'); location.href = 'counselor.html?panel=1';
      } catch (error) { status(feedback, error.message + (setupToken ? ' 若已改密但网络中断，可返回登录并使用新密码。' : ''), true); }
      finally { submit.disabled = restart.disabled = false; }
    };
  }
  async function copy(text) {
    if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(text); return; } catch (_) { /* fallback */ } }
    const area = document.createElement('textarea'); area.value = text; area.style.cssText = 'position:fixed;opacity:0'; document.body.append(area);
    try { area.select(); if (!document.execCommand('copy')) throw Error('复制失败，请手动选择链接并复制。'); } finally { area.remove(); }
  }
  function openShare(id) {
    const dialog = node('dialog', '', 'c-access-dialog'); dialog.setAttribute('aria-label', '分享资料填写链接');
    const title = node('h2', '分享资料填写链接'), note = node('p', '链接有效 7 天，仅用于填写这位咨询师的资料。生成新链接会使旧链接失效，请单独发给本人。', 'c-access-note');
    const link = document.createElement('input'); link.readOnly = true; link.setAttribute('aria-label', '资料填写链接'); link.placeholder = '生成后在这里显示';
    const feedback = node('p', '', 'c-access-status'); feedback.setAttribute('role', 'status');
    const actions = node('div', '', 'c-access-actions');
    const generate = node('button', '生成新链接', 'c-access-button'), copyButton = node('button', '复制链接', 'c-access-button secondary'); copyButton.disabled = true;
    const revoke = node('button', '撤销链接', 'c-access-button secondary'), reset = node('button', '重置手机号登录', 'c-access-button secondary');
    const close = node('button', '关闭', 'c-access-button secondary'); actions.append(generate, copyButton, revoke, reset, close);
    async function action(kind) {
      generate.disabled = revoke.disabled = reset.disabled = true; status(feedback, '正在处理…');
      try {
        const token = currentApiToken(); if (!token) throw Error('请先登录管理员账号。');
        const data = await post('/v1/xg/portal/counselor-access', { action: kind, counselor_id: id }, token, false);
        if (kind === 'issue') {
          const url = new URL('counselor.html', location.href); url.search = '?invite=1' + (token.startsWith('xpgdemo.') ? '&demo=1' : '');
          url.hash = new URLSearchParams({ invite: data.invite }).toString(); link.value = url.href; copyButton.disabled = false;
          status(feedback, '已生成，有效至 ' + new Date(data.expires_at).toLocaleString('zh-CN') + '。点击复制后单独发给本人。');
        } else if (kind === 'revoke') { link.value = ''; copyButton.disabled = true; status(feedback, '已撤销；旧链接和已打开的填写会话均已失效。'); }
        else status(feedback, '已重置 ' + data.phone_masked + ' 的手机号登录。请本人使用手机号后 6 位首次登录并设置新密码。');
      } catch (error) { status(feedback, error.message, true); }
      finally { generate.disabled = revoke.disabled = reset.disabled = false; }
    }
    generate.onclick = () => action('issue'); revoke.onclick = () => action('revoke');
    reset.onclick = () => { if (window.confirm('重置后，此手机号的已有登录将失效，并重新使用手机号后 6 位作为初始密码。确认重置？')) action('reset_phone'); };
    copyButton.onclick = async () => { try { await copy(link.value); status(feedback, '填写链接已复制，请单独发给本人。'); } catch (e) { status(feedback, e.message, true); } };
    const dismiss = () => { link.value = ''; dialog.close(); dialog.remove(); };
    close.onclick = dismiss; dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
    dialog.append(title, note, link, feedback, actions); document.body.append(dialog); dialog.showModal();
  }
  function sharedStatus(message, error) {
    let box = document.getElementById('shared-profile-status');
    if (!box) { box = node('p', '', 'c-access-status c-access-shared-status'); box.id = 'shared-profile-status'; box.setAttribute('role', 'status'); document.getElementById('panel-area').prepend(box); }
    status(box, message, error);
  }
  async function openSharedProfile() {
    document.getElementById('form_area').style.display = 'none';
    document.getElementById('panel-area').style.display = 'block';
    document.getElementById('panel-content').style.display = 'none';
    document.getElementById('panel-edit-btn').style.display = 'none';
    document.getElementById('panel-login').style.display = 'none';
    document.querySelector('.page-header .brand-name').textContent = '补充本人资料';
    sharedStatus('正在验证填写链接…');
    try {
      if (!sharedSecret) throw Error('填写链接已从地址栏移除。请重新打开管理员发来的完整链接。');
      const secret = sharedSecret; sharedSecret = null;
      const result = await post('/auth/counselor/invite', { invite: secret }, sharedDemo ? 'xpgdemo.unauthenticated' : 'profile-link', true);
      if (!result.token) throw Error('填写链接验证失败。'); profileToken = result.token;
      document.getElementById('panel-edit').style.display = 'block';
      await loadCounselorProfile();
      sharedStatus('请补充本人资料并点击「保存档案」。此页面不会进入来访者工作台，保存成功后可直接关闭。');
    } catch (error) { profileToken = ''; document.getElementById('panel-edit').style.display = 'none'; sharedStatus(error.message, true); }
  }
  function profileRequest(method, body) {
    if (!profileToken) return Promise.reject(Error('填写会话已失效，请重新打开管理员发来的链接。'));
    return fetch(endpoint('/v1/xg/portal/shared-profile'), { method, cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + profileToken }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  function mount() {
    for (const box of document.querySelectorAll('[data-counselor-phone-login]')) installPhoneForm(box);
  }
  window.XPG_COUNSELOR_ACCESS = { isShared, openShare, openSharedProfile, profileRequest, sharedStatus };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
