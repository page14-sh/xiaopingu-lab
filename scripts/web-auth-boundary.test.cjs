const fs=require('fs'),vm=require('vm'),test=require('node:test'),assert=require('node:assert/strict');
for(const file of ['web/supabase-config.js','legacy-web/supabase-config.js'])test(file+' attaches credentials only to the exact API boundary and respects explicit identity',async()=>{
 const calls=[],session=new Map([['xiaopingu_admin_token','synthetic-admin']]),local=new Map([['xiaopingu_counselor_token','synthetic-counselor']]);
 const storage=m=>({getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)});
 const native=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({token:'new-synthetic-counselor'})};};
 const context={window:{fetch:native,location:{href:'https://synthetic.invalid/admin.html',pathname:'/admin.html',hostname:'synthetic.invalid'}},sessionStorage:storage(session),localStorage:storage(local),Headers,URL,console};
 context.location=context.window.location;
 vm.createContext(context);vm.runInContext(fs.readFileSync(file,'utf8'),context);context.fetch=context.window.fetch;const base=context.SUPABASE_CONFIG.url;
 await context.fetch(base+'.attacker.invalid/collect',{});assert.equal(calls.at(-1).options.headers,undefined);
 await context.fetch('https://attacker.invalid/collect',{});assert.equal(calls.at(-1).options.headers,undefined);
 await context.fetch(base+'/rest/v1/counselors',{headers:{Authorization:'Bearer explicit-counselor'}});assert.equal(calls.at(-1).options.headers.get('Authorization'),'Bearer explicit-counselor');
 await context.fetch(base+'/rest/v1/counselors',{headers:{Authorization:'Bearer '}});assert.equal(calls.at(-1).options.headers.get('Authorization'),'Bearer synthetic-admin');
 await context.loginCounselor('synthetic-edit-code','');assert.equal(session.has('xiaopingu_admin_token'),false);assert.equal(local.get('xiaopingu_counselor_token'),'new-synthetic-counselor');
});
