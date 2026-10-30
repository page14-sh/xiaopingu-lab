/* Demo accounts use the formal pages; backend-issued routing tokens isolate data. */
(function(){
 const TOKEN_PREFIX='xpgdemo.';
 const stateKeys=['xiaopingu_admin_token','xiaopingu_counselor_token','xiaopingu_counselor_id','xpg_v2_visitor_token','xpg_v2_visitor_credential','xiaopingu_assessment_id','xiaopingu_my_asid','xiaopingu_assessment_backup','xiaopingu_draft','xg_match_id','xg_visitor_openid'];
 const relevant=k=>stateKeys.includes(k)||k.startsWith('xiaopingu_web_session_')||k.startsWith('xpg_v2_draft_');
 function enterDemo(){if(localStorage.getItem('xpg_demo_active')==='1')return;for(const store of [localStorage,sessionStorage]){const saved={};for(const k of Object.keys(store))if(relevant(k)){saved[k]=store.getItem(k);store.removeItem(k);}store.setItem('xpg_formal_session_backup',JSON.stringify(saved));}localStorage.setItem('xpg_demo_active','1');}
 function exitDemo(){for(const store of [localStorage,sessionStorage]){for(const k of Object.keys(store))if(relevant(k))store.removeItem(k);const saved=JSON.parse(store.getItem('xpg_formal_session_backup')||'{}');for(const [k,v]of Object.entries(saved))store.setItem(k,v);store.removeItem('xpg_formal_session_backup');}localStorage.removeItem('xpg_demo_active');location.href='index.html';}
 async function login(role,username,password){
  var lastErr=null;
  for(var attempt=0;attempt<4;attempt++){
    var r=null,d=null;
    try{
      r=await fetch(SUPABASE_CONFIG.url+'/auth/account',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role,username,password})});
      d=await r.json().catch(function(){return {};});
    }catch(e){
      lastErr=Error('网络异常');
      await new Promise(function(s){setTimeout(s,7000);});
      continue;
    }
    if(r.ok&&d&&d.token){
      if(!d.token.startsWith(TOKEN_PREFIX))throw Error('演示账号配置尚未就绪');
      enterDemo();
      if(role==='visitor'){localStorage.setItem('xpg_v2_visitor_token',d.token);localStorage.setItem('xpg_v2_visitor_credential',d.client_credential);}
      else if(role==='counselor'){localStorage.setItem('xiaopingu_counselor_token',d.token);localStorage.setItem('xiaopingu_counselor_id',d.counselor.id);}
      else sessionStorage.setItem('xiaopingu_admin_token',d.token);
      return d;
    }
    var msg=(d&&d.message)||'登录失败';
    var retryable=/演示服务|暂不可用|不可用|超时|timeout/i.test(msg)||(r&&r.status>=500);
    if(!retryable)throw Error(msg);
    lastErr=Error(msg);
    if(typeof window.onDemoLoginRetry==='function'){try{window.onDemoLoginRetry(attempt+1,3,msg);}catch(e){}}
    await new Promise(function(s){setTimeout(s,7000+attempt*4000);});
  }
  throw lastErr||Error('登录失败');
}
 function dialog(){const box=document.createElement('dialog');box.setAttribute('aria-label','演示账号登录');box.className='demo-account-dialog';box.innerHTML='<form><h2>演示账号登录</h2><p>操作仅保存为测试数据。</p><label>账号<input name="username" autocomplete="username" required></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><p role="alert"></p><button type="button">取消</button><button type="submit">登录</button></form>';const form=box.querySelector('form');form.querySelector('button[type=button]').onclick=()=>{box.close();box.remove();};form.onsubmit=async e=>{e.preventDefault();const submit=form.querySelector('button[type=submit]');const alertEl=form.querySelector('[role=alert]');submit.disabled=true;window.onDemoLoginRetry=function(n,total){alertEl.style.color='#8a6d1f';alertEl.textContent='演示服务正在启动，正在第 '+n+'/'+total+' 次重试…（约需 20–40 秒，请勿关闭）';};try{const username=form.elements.username.value.trim(),role=({demo_visitor:'visitor',demo_counselor:'counselor',demo_admin:'admin'})[username];await login(role,username,form.elements.password.value);location.href=role==='visitor'?'index.html?demo=visitor':role==='counselor'?'counselor.html?panel=1':'admin.html';}catch(e){alertEl.style.color='#a33';alertEl.textContent=e.message||'登录失败';}finally{window.onDemoLoginRetry=null;submit.disabled=false;}};box.addEventListener('cancel',()=>box.remove());document.body.append(box);box.showModal();form.elements.username.focus();}
 function mount(){if(SUPABASE_CONFIG.accountLogin===true)return;const style=document.createElement('style');style.textContent='.demo-account-dialog{max-width:400px;width:88vw;border:1px solid #E6E3DC;border-radius:14px;padding:24px;color:#2E2E2C;background:white;font:15px/1.7 "PingFang SC",sans-serif}.demo-account-dialog label{display:block;margin:12px 0}.demo-account-dialog input{display:block;box-sizing:border-box;width:100%;padding:10px;border:1px solid #ccc;border-radius:8px}.demo-account-dialog button{padding:9px 18px;margin-right:10px;border:0;border-radius:8px;background:#5C7A52;color:white}.demo-account-dialog [role=alert]{color:#a33}.demo-account-bar{position:relative;z-index:10000;padding:8px 18px;background:#FFF4CC;color:#57471c;font:13px/1.6 "PingFang SC",sans-serif}.demo-account-bar a,.demo-account-bar button{margin:0 6px}';document.head.append(style);
 const bar=document.createElement('aside');bar.className='demo-account-bar';const active=localStorage.getItem('xpg_demo_active')==='1';bar.append(document.createTextNode(active?'演示账号 · 仅使用测试资料':'演示体验'));const b=document.createElement('button');b.textContent=active?'切换演示账号':'演示账号登录';b.onclick=dialog;bar.append(b);if(active){for(const [text,url]of [['来访档案','portal.html'],['咨询师工作台','counselor.html?panel=1'],['运营后台','admin.html']]){const a=document.createElement('a');a.textContent=text;a.href=url;bar.append(a);}const exit=document.createElement('button');exit.textContent='退出演示';exit.onclick=exitDemo;bar.append(exit);}document.body.prepend(bar);
 if(new URLSearchParams(location.search).get('demo')==='visitor'&&active&&typeof window.enterAssessment==='function')window.enterAssessment();
 }
 window.XPG_DEMO_ACCOUNTS={login,dialog,exitDemo};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
})();
