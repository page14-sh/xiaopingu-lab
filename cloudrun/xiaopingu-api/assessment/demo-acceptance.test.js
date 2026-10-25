const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {cases,verifyMainDemo}=require('../../../scripts/fixtures/assessment-acceptance.cjs');
const {buildMainDemo,summarizeDemo,C}=require('../../../scripts/fixtures/assessment-demo.cjs');
const {createIdentityRepository}=require('./identity-repository');
const {createStatisticsRepository}=require('./statistics');
const {createRequestHandler,signSession}=require('../app');
for(const [id,title,run]of cases)test(`T20 ${id} ${title}`,run);

test('T20 repaired main fixture has valid frozen scores, scope, lifecycle and due dates',async()=>{
 const f=await buildMainDemo(),report=await verifyMainDemo(f);assert.equal(report.events.length,21);assert.equal(report.synthetic,true);assert.equal(report.importable,false);
 const first=report.events.find(e=>e.label==='main/s1-pro');assert.equal(first.scores.total,null);assert.equal('p6'in first.answers,false);
 assert.equal(report.events.find(e=>e.label==='main/s4-pro').answers.p6,5);assert.equal(report.events.find(e=>e.label==='main/s5-pro').answers.p6,5);
});

test('T20 rerunning fixtures is deterministic and invokes no external fetch',async(t)=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('External network forbidden in fixture generator');};t.after(()=>{globalThis.fetch=original;});
 const first=await summarizeDemo(await buildMainDemo()),second=await summarizeDemo(await buildMainDemo());assert.deepEqual(first,second);assert.equal(calls,0);
 assert.doesNotMatch(JSON.stringify(first),/accessKey|apiKey|authorization|lease_token|openid|手机号|身份证/);
});

async function httpFixture(t){
 const f=await buildMainDemo(),secret='t20-synthetic-local-http-secret',counselors=[...f.cases.values()].map(c=>c.counselor_id);
 const store={assessment:f.repo,identity:createIdentityRepository(f.db),consent:f.consent,lifecycle:f.flow,statistics:createStatisticsRepository(f.db,{now:f.now}),
   async list(){return [];},async findById(_table,id){return counselors.includes(id)?{id,is_active:true,review_status:'approved'}:null;}};
 const server=http.createServer(createRequestHandler({store,sessionSecret:secret}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 async function request(path,principal,method='GET',body){const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'content-type':'application/json',...(principal?{authorization:`Bearer ${signSession(principal,secret)}`}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};}
 return {f,request};
}

test('T20 HTTP new counselor cannot inherit old-cycle evidence and visitor gets no scores/LLM',async(t)=>{
 const {f,request}=await httpFixture(t),old=f.cases.get('main'),next=f.cases.get('new-cycle');
 for(const [principal,match]of [[f.actor('counselor',next.counselor_id),old],[f.actor('counselor',old.counselor_id),next],[f.actor('visitor','not-a-visitor'),old]]){
   assert.equal((await request(`/v1/xg/events?match_id=${match.match_id}`,principal)).status,403);
 }
 const visitor=f.actor('visitor',old.visitor_id),events=await request(`/v1/xg/events?match_id=${old.match_id}`,visitor);assert.equal(events.status,200);
 assert.doesNotMatch(JSON.stringify(events.body),/"(?:scores|total|pct|ors_total|add_total|raw_answers|summary|dim_scores)"/);
 for(const endpoint of ['trend','llm-results','counselor/inbox'])assert.equal((await request(`/v1/xg/${endpoint}?match_id=${old.match_id}`,visitor)).status,403);
 const llm=await request(`/v1/xg/llm-results?match_id=${old.match_id}`,f.actor('counselor',old.counselor_id));assert.equal(llm.status,200);assert.equal(llm.body.results[0].model,'synthetic-t20-no-network');
});

test('T20 HTTP synthetic demo sessions and all private collections stay outside generic access',async(t)=>{
 const {f,request}=await httpFixture(t),match=f.cases.get('main');
 assert.equal((await request('/v1/xg/me',{...f.actor('visitor',match.visitor_id),demo:true})).status,403);
 assert.equal((await request('/v1/xg/me')).status,401);
 for(const collection of Object.values(C)){
   const response=await request(`/rest/v1/${collection}`,f.actor('admin','fixture-admin'));assert.notEqual(response.status,200);
 }
 const forged=await request('/v1/xg/events/start',f.actor('visitor',match.visitor_id),'POST',{match_id:f.cases.get('new-cycle').match_id,scale_code:'xg_m1_state',session_no:2,client_event_id:'forged',counselor_id:'attacker',scores:{total:70}});
 assert.equal(forged.status,400);
 const stats=await request('/v1/xg/admin/stats?from=2026-01-01&to=2026-04-30',f.actor('admin','fixture-admin'));assert.equal(stats.status,200);assert.equal(stats.body.metrics.fill_duration_ms.status,'suppressed');
});
