// Account forms attached to the existing platform pages. No workflow launcher.
(function(){
 const VERSION='fixed-platform-accounts-v1';
 if(localStorage.getItem('xpg_platform_accounts_version')!==VERSION){
  for(const s of [localStorage,sessionStorage])for(const k of Object.keys(s))if(k.startsWith('xiaopingu_web_session_')||['xiaopingu_admin_token','xiaopingu_counselor_token','xiaopingu_counselor_id','xpg_v2_visitor_token','xpg_v2_visitor_credential','xiaopingu_assessment_id','xiaopingu_my_asid','xiaopingu_assessment_backup','xiaopingu_draft','xg_match_id','xg_visitor_openid'].includes(k))s.removeItem(k);
  localStorage.setItem('xpg_platform_accounts_version',VERSION);
 }
 async function login(role,username,password){
  const r=await fetch('/api/auth/account',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role,username,password})});const d=await r.json();if(!r.ok)throw Error(d.error?.message||d.message||'登录失败');
  if(role==='visitor'){localStorage.setItem('xpg_v2_visitor_token',d.token);localStorage.setItem('xpg_v2_visitor_credential',d.client_credential);}
  else if(role==='counselor'){localStorage.setItem('xiaopingu_counselor_token',d.token);localStorage.setItem('xiaopingu_counselor_id',d.counselor.id);}
  else sessionStorage.setItem('xiaopingu_admin_token',d.token);
  localStorage.setItem('xpg_demo_username_'+role,username);return d;
 }
 function dialog(role,done){
  const box=document.createElement('dialog');box.className='platform-account-dialog';box.setAttribute('aria-label',({visitor:'来访者',counselor:'咨询师',admin:'管理员'}[role])+'登录');
  const form=document.createElement('form'),heading=document.createElement('h2');heading.textContent=({visitor:'来访者',counselor:'咨询师',admin:'管理员'}[role])+'账号登录';form.append(heading);
  function field(text,type){const label=document.createElement('label');label.textContent=text;const input=document.createElement('input');input.type=type;input.required=true;input.autocomplete=type==='password'?'current-password':'username';label.append(input);form.append(label);return input;}
  const username=field('账号','text'),password=field('密码','password'),message=document.createElement('p');message.setAttribute('role','alert');form.append(message);
  const cancel=document.createElement('button');cancel.type='button';cancel.textContent='取消';cancel.onclick=()=>{box.close();box.remove();};const submit=document.createElement('button');submit.type='submit';submit.textContent='登录';form.append(cancel,submit);
  form.onsubmit=async e=>{e.preventDefault();submit.disabled=true;try{await login(role,username.value.trim(),password.value);box.close();box.remove();done();}catch(e){message.textContent=e.message;}finally{submit.disabled=false;}};box.addEventListener('cancel',()=>box.remove());box.append(form);document.body.append(box);box.showModal();username.focus();
 }
 window.XPG_PLATFORM_ACCOUNT={login,dialog};
 document.addEventListener('DOMContentLoaded',()=>{
  const style=document.createElement('style');style.textContent='.platform-account-dialog{max-width:420px;width:90vw;border:1px solid #E6E3DC;border-radius:14px;padding:24px;color:#2E2E2C;background:white;font:15px/1.7 "PingFang SC",sans-serif}.platform-account-dialog label{display:block;margin:12px 0}.platform-account-dialog input{display:block;box-sizing:border-box;width:100%;padding:10px;border:1px solid #ccc;border-radius:8px}.platform-account-dialog button{padding:9px 18px;margin-right:10px;border:0;border-radius:8px;background:#5C7A52;color:white}.platform-account-dialog [role=alert]{color:#a33}';document.head.append(style);
  const banner=document.createElement('aside');banner.style.cssText='padding:8px 18px;background:#FFF4CC;color:#57471c;font:13px/1.6 "PingFang SC",sans-serif';banner.textContent='平台演示环境 · 仅使用测试资料 · 操作记录保存在独立 CloudBase 测试区';document.body.prepend(banner);
  const path=location.pathname;
  if(path==='/'||path.endsWith('/index.html')){
   const start=window.enterAssessment;
   window.enterAssessment=()=>{if(localStorage.getItem('xpg_v2_visitor_token'))start();else dialog('visitor',()=>start());};
   window.openCounselorLogin=()=>dialog('counselor',()=>{location.href='counselor.html?panel=1';});
   const cta=document.querySelector('.sc-cta-wrap');if(cta){const b=document.createElement('button');b.className='sc-cta-btn sc-cta-secondary';b.textContent='来访者登录';b.onclick=()=>dialog('visitor',()=>{location.href='portal.html';});cta.append(b);}
  }
  if(window.XPG_API_AUTH){
   const original=window.XPG_API_AUTH.loginCounselor;
   window.XPG_API_AUTH.loginCounselor=(credential,password)=>credential==='demo_counselor'?login('counselor',credential,password||''):original(credential,password);
   if(path.endsWith('/admin.html')){
    const password=document.getElementById('login-password'),username=document.createElement('input');username.id='demo-admin-username';username.type='text';username.placeholder='管理员账号';username.autocomplete='username';username.style.cssText=password.style.cssText;password.before(username);
    window.XPG_API_AUTH.loginAdmin=pw=>login('admin',username.value.trim(),pw);
   }
  }
  if(path.endsWith('/counselor.html')){
   const input=document.getElementById('panel-cid-input');input.placeholder='咨询师账号或编辑码';const password=document.createElement('input');password.id='panel-account-password';password.type='password';password.placeholder='账号密码（编辑码登录可留空）';password.autocomplete='current-password';input.after(password);
  }
 });
})();
