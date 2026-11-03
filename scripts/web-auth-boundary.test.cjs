const fs=require('fs'),vm=require('vm'),test=require('node:test'),assert=require('node:assert/strict');
for(const file of ['web/supabase-config.js','legacy-web/supabase-config.js'])test(file+' attaches credentials only to the exact API boundary and respects explicit identity',async()=>{
 const calls=[],session=new Map([['xiaopingu_admin_token','synthetic-admin']]),local=new Map([['xiaopingu_counselor_token','synthetic-counselor']]);
 const storage=m=>({getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)});
 const native=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({token:'new-synthetic-counselor',counselor:{id:'synthetic-subject'}})};};
 const context={window:{fetch:native,location:{href:'https://synthetic.invalid/admin.html',pathname:'/admin.html',hostname:'synthetic.invalid'}},sessionStorage:storage(session),localStorage:storage(local),Headers,URL,console,AbortController,setTimeout,clearTimeout};
 context.location=context.window.location;
 vm.createContext(context);vm.runInContext(fs.readFileSync(file,'utf8'),context);context.fetch=context.window.fetch;const base=context.SUPABASE_CONFIG.url;
 await context.fetch(base+'.attacker.invalid/collect',{});assert.equal(calls.at(-1).options.headers,undefined);
 await context.fetch('https://attacker.invalid/collect',{});assert.equal(calls.at(-1).options.headers,undefined);
 await context.fetch(base+'/rest/v1/counselors',{headers:{Authorization:'Bearer explicit-counselor'}});assert.equal(calls.at(-1).options.headers.get('Authorization'),'Bearer explicit-counselor');
 await context.fetch(base+'/rest/v1/counselors',{headers:{Authorization:'Bearer '}});assert.equal(calls.at(-1).options.headers.get('Authorization'),'Bearer synthetic-admin');
 await context.loginCounselor('synthetic-edit-code','');assert.equal(session.has('xiaopingu_admin_token'),false);assert.equal(local.get('xiaopingu_counselor_token'),'new-synthetic-counselor');
});
test('demo intake refresh remains on the isolated route and never becomes a production receipt',async()=>{
 const calls=[],local=new Map([['xpg_v2_visitor_token','xpgdemo.synthetic-token'],['xpg_v2_visitor_credential','synthetic-claim'],['xpg_demo_active','1']]);
 const storage=m=>({getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)});
 const native=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({token:'xpgdemo.refreshed-token'})};};
 const c={window:{fetch:native},location:{href:'https://synthetic.invalid/index.html',pathname:'/index.html'},localStorage:storage(local),sessionStorage:storage(new Map()),Headers,URL,console,AbortController,setTimeout,clearTimeout};vm.createContext(c);vm.runInContext(fs.readFileSync('legacy-web/supabase-config.js','utf8'),c);
 await c.window.fetch(c.SUPABASE_CONFIG.url+'/rest/v1/assessments',{method:'POST',body:JSON.stringify({id:'synthetic'})});assert.equal(calls[0].options.headers.get('Authorization'),'Bearer xpgdemo.synthetic-token');assert.equal(calls[1].options.headers.Authorization,'Bearer xpgdemo.synthetic-token');assert.equal(local.get('xpg_v2_visitor_token'),'xpgdemo.refreshed-token');
 local.delete('xpg_v2_visitor_token');await c.window.fetch(c.SUPABASE_CONFIG.url+'/rest/v1/counselors',{});assert.equal(calls.at(-1).options.headers.get('Authorization'),'Bearer xpgdemo.unauthenticated');
});

test('real counselor edit code is not sent to the preview service in demo mode',async()=>{
 const context={window:{fetch:()=>{throw Error('unexpected network request');}},localStorage:{getItem:k=>k==='xpg_demo_active'?'1':null},Headers,URL,console};
 vm.createContext(context);vm.runInContext(fs.readFileSync('legacy-web/supabase-config.js','utf8'),context);context.fetch=context.window.fetch;
 await assert.rejects(context.loginCounselor('synthetic-edit-code',''),/退出演示/);
});

test('counselor login retries transient gateway failures, never a rejected credential',async()=>{
 for(const statuses of [[503,200],[401],[503,503,503]]) {
  let calls=0,retries=0;
  const store={getItem:()=>null,setItem(){},removeItem(){}};
  const c={window:{fetch:async()=>{const status=statuses[calls++]; return {status,ok:status===200,json:async()=>({token:'synthetic',counselor:{id:'test'}})};}},location:{href:'https://test.invalid/index.html',pathname:'/index.html'},localStorage:store,sessionStorage:store,AbortController,Headers,URL,setTimeout:(cb,ms)=>ms===2000?queueMicrotask(cb):0,clearTimeout(){}};
  vm.createContext(c);vm.runInContext(fs.readFileSync('legacy-web/supabase-config.js','utf8'),c);c.fetch=c.window.fetch;
  const action=c.loginCounselor('synthetic','',()=>retries++);
  if(statuses.at(-1)===200)assert.equal((await action).token,'synthetic');else await assert.rejects(action,statuses[0]===401?/编辑码未通过验证/:/服务暂不可用/);
  assert.equal(calls,statuses.length);assert.equal(retries,calls-1);
 }
});
