// Read-only verification through the production API. No intake/card is created.
const fs=require('node:fs'),assert=require('node:assert/strict');
const {PREFIX}=require('../../cloudrun/xiaopingu-api/demo-accounts');
const base='https://xiaopingu-assessment-308810-6-1300577165.sh.run.tcloudbase.com';
(async()=>{
 const accounts=JSON.parse(fs.readFileSync('.private/test-chain/platform-accounts.json'));
 const privateDoc=fs.readFileSync('.private/test-chain/platform-accounts.md','utf8'),password=privateDoc.match(/本组演示账号密码：([^\n]+)/)[1].trim();
 const tokens={},report={checked_at:new Date().toISOString(),endpoint:base,roles:[],writes:0};
 async function request(path,token,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(45000)});const d=await r.json();return {status:r.status,data:d};}
 for(const role of ['visitor','counselor','admin']){const r=await request('/auth/account',null,{role,username:accounts.usernames[role],password});assert.equal(r.status,200,role+' login');assert.ok(r.data.token.startsWith(PREFIX));tokens[role]=r.data.token;const me=await request('/v1/xg/me',tokens[role]);assert.equal(me.status,200);assert.equal(me.data.role,role);if(role!=='admin')assert.equal(me.data.id,accounts.backend[role].id);report.roles.push({role,authenticated:true,identity_matches:true});}
 const cases=await request('/v1/xg/portal/cases',tokens.visitor);assert.equal(cases.status,200);report.visitor_intakes=cases.data.intakes.length;report.visitor_matches=cases.data.matches.length;
 const runtime=JSON.parse(fs.readFileSync('.env.v2-runtime.json'));const real=await request('/auth/admin',null,{password:runtime.XPG_ADMIN_PASSWORD});assert.equal(real.status,200);
 const demoRows=await request('/rest/v1/counselors',tokens.admin),realRows=await request('/rest/v1/counselors',real.data.token);assert.equal(demoRows.status,200);assert.equal(realRows.status,200);assert.ok(demoRows.data.some(x=>x.id===accounts.backend.counselor.id));const ids=new Set(realRows.data.map(x=>x.id));assert.ok(demoRows.data.every(x=>!ids.has(x.id)));report.directory_isolation={demo:demoRows.data.length,production:realRows.data.length,overlap:0};
 const altered=await request('/v1/xg/me',tokens.admin.slice(PREFIX.length));assert.ok([401,403].includes(altered.status));report.removing_demo_prefix_denied=true;
 const wrong=await request('/v1/xg/me',PREFIX+real.data.token);assert.ok([401,403].includes(wrong.status));report.production_token_cannot_access_preview=true;
 fs.writeFileSync('outputs/test-chain/cloud-account-verification.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
