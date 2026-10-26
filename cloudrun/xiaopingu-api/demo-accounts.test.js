const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto');
const {createDemoRouter,configFromEnv,PREFIX,TARGET}=require('./demo-accounts');
const {signSession,verifySession}=require('./app');
const password='synthetic-unit-password',a={salt:'unit',password_hash:crypto.scryptSync(password,'unit',64).toString('hex'),usernames:{visitor:'demo_visitor',counselor:'demo_counselor',admin:'demo_admin'},backend:{api_url:TARGET,prefix:'xg_preview_7d0a8e2622_',synthetic:true,visitor:{credential:'visitor-secret'},counselor:{id:'demo-counselor',credential:'counselor-secret'},admin:{password:'admin-secret'}}};
test('runtime cannot enable demo routing with production data or arbitrary upstream',()=>{assert.equal(configFromEnv({}),null);assert.throws(()=>configFromEnv({XPG_DEMO_ACCOUNTS_JSON:JSON.stringify(a)}));assert.throws(()=>configFromEnv({XPG_DEPLOYMENT_MODE:'production',XPG_COLLECTION_PREFIX:'xg_v2_59875df34c_',XPG_DEMO_ACCOUNTS_JSON:JSON.stringify({...a,backend:{...a.backend,api_url:'https://attacker.invalid'}})}));assert.deepEqual(configFromEnv({XPG_DEPLOYMENT_MODE:'production',XPG_COLLECTION_PREFIX:'xg_v2_59875df34c_',XPG_DEMO_ACCOUNTS_JSON:JSON.stringify(a)}),a);});
test('three aliases use preview authorization; invalid or production tokens never fall through into real data',async()=>{
 let productionCalls=0;const calls=[];const previewSecret='separate-preview-secret',productionSecret='separate-production-secret';
 const upstream=async(url,opts)=>{calls.push({url,opts});assert.ok(url.startsWith(TARGET+'/'));assert.equal(opts.headers['x-cloudbase-context'],undefined);if(url.includes('/auth/')){const role=url.endsWith('/auth/admin')?'admin':url.endsWith('/auth/counselor')?'counselor':'visitor';return new Response(JSON.stringify({token:signSession({role,subject:'demo-'+role,exp:Date.now()+60000},previewSecret),counselor:{id:'demo-counselor'}}),{status:200});}const token=opts.headers.authorization.slice(7);if(!verifySession(token,previewSecret))return new Response('{"message":"unauthorized"}',{status:401});return new Response(JSON.stringify(url.includes('counselors')?[{id:'demo-counselor'},{id:'other-test-counselor'}]:{source:'preview'}),{status:200});};
 const server=http.createServer(createDemoRouter({accounts:a,fetchImpl:upstream,next:(_q,r)=>{productionCalls++;r.end('{"source":"production"}');}}));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const request=(p,body,token)=>fetch(base+p,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),'x-cloudbase-context':'must-never-be-forwarded'},...(body?{body:JSON.stringify(body)}:{})});
 try{let visitor;for(const role of ['visitor','counselor','admin']){const r=await request('/auth/account',{role,username:'demo_'+role,password});assert.equal(r.status,200);const d=await r.json();assert.ok(d.token.startsWith(PREFIX));assert.equal(verifySession(d.token.slice(PREFIX.length),previewSecret).role,role);assert.ok(!JSON.stringify(d).includes('admin-secret'));if(role==='visitor')visitor=d.token;}
 assert.equal((await request('/auth/account',{role:'admin',username:'demo_visitor',password})).status,401);
 assert.equal((await request('/v1/xg/portal/cases',null,PREFIX+'bad-token')).status,401);
 const formal=signSession({role:'admin',subject:'real-admin',exp:Date.now()+60000},productionSecret);
 assert.equal((await request('/v1/xg/portal/cases',null,PREFIX+formal)).status,401);
 assert.equal(productionCalls,0);
 assert.deepEqual(await(await request('/v1/xg/portal/cases',null,visitor)).json(),{source:'preview'});
 assert.deepEqual(await(await request('/rest/v1/counselors?is_active=eq.true&review_status=eq.approved',null,visitor)).json(),[{id:'demo-counselor'}]);
 assert.equal((await request('/not-allowed',null,visitor)).status,404);
 assert.equal(productionCalls,0);
 assert.deepEqual(await(await request('/v1/xg/portal/cases',null,formal)).json(),{source:'production'});assert.equal(productionCalls,1);
 }finally{await new Promise(r=>server.close(r));}
});
