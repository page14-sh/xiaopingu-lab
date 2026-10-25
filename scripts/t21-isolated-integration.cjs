// Opt-in real database verification. CLI credentials stay in memory; only this
// run's uniquely named synthetic resources can be modified or deleted.
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {open,safeCode}=require('./integration/t21-cloud.cjs');
const base='../cloudrun/xiaopingu-api/';
const {createRequestHandler,createCloudBaseStore,signSession}=require(base+'app');
const {createCloudBaseAssessmentStore}=require(base+'assessment/cloudbase-store');
const {createAssessmentRepository}=require(base+'assessment/repository');
const {createEventLifecycle}=require(base+'assessment/event-lifecycle');
const {createConsentRepository}=require(base+'assessment/consent');
const {createProvenanceRepository,defaultVersionBundle}=require(base+'assessment/provenance');
const {createFollowupRepository}=require(base+'assessment/followups');
const {createNotificationWorker}=require(base+'assessment/notification-worker');
const {createLlmWorker}=require(base+'assessment/llm-worker');
const {createLlmService}=require(base+'assessment/llm-service');
const {createStatisticsRepository}=require(base+'assessment/statistics');
const {createIdentityHandler}=require('../cloudfunctions/xg-identity/handler');
const {COLLECTIONS:C,SCALES:S}=require(base+'assessment/model');
async function run(context){
 const {db,mapped,report,persist,physical}=context;let clock=Date.now(),notificationCalls=0,llmCalls=0;
 const now=()=>clock,iso=()=>new Date(clock).toISOString();
 const internal=createCloudBaseAssessmentStore(mapped,{onTransactionEvent:e=>{report.transaction_events[e.type]=(report.transaction_events[e.type]||0)+1;}});
 const consent=createConsentRepository(internal,{now:iso}),repo=createAssessmentRepository(internal,{now:iso}),flow=createEventLifecycle(internal,consent,{now}),provenance=createProvenanceRepository(internal,{now:iso});
 const provider={async send(){notificationCalls++;return {kind:'rejected',code:'SYNTHETIC_PROVIDER_REJECTION'};}};
 const llm={ready:true,model:'synthetic-t21',async generate(p){llmCalls++;return JSON.stringify({summary:'合成问卷结果用于接口联调。',dim_scores:Object.fromEntries(Object.entries(p.available_dimensions).map(([k,v])=>[k,v?60:null])),suggest_actions:[],tag_weight_adjust:[]});}};
 const store={...createCloudBaseStore(mapped),assessment:repo,consent,lifecycle:flow,provenance,followups:createFollowupRepository(internal,{now}),notificationWorker:createNotificationWorker(internal,{now,provider}),llmWorker:createLlmWorker(internal,{now,provider:llm}),llm:createLlmService(internal,{now}),statistics:createStatisticsRepository(internal,{now})};
 const secret=randomBytes(32).toString('hex'),scheduler=randomBytes(32).toString('hex'),matching=randomBytes(32).toString('hex'),bridgeSecret=randomBytes(32).toString('hex');
 const admin=signSession({role:'admin',subject:'t21-admin',aud:'xg-assessment',demo:false,auth_method:'admin-password',exp:Date.now()+3600000},secret);
 const counselor=signSession({role:'counselor',subject:'t21-c',aud:'xg-assessment',demo:false,auth_method:'counselor-edit',exp:Date.now()+3600000},secret);
 const server=http.createServer(createRequestHandler({store,sessionSecret:secret,serviceSecrets:{scheduler,matching},identityBridge:{secret:bridgeSecret,appId:'wx-t21',audience:'t21-aud'}}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const requestTimes=[];async function request(url,token=admin,body,expected=200){const started=Date.now();const res=await fetch(`http://127.0.0.1:${server.address().port}${url}`,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await res.json();requestTimes.push(Date.now()-started);assert.equal(res.status,expected,`${url}: ${data.error?.code||res.status}`);return data;}
 async function check(name,work){console.log('RUN '+name);const started=Date.now();await work();report.tests.push({name,passed:true,duration_ms:Date.now()-started});persist();console.log('PASS '+name);}
 async function retry(work){for(let i=0;i<5;i++){try{return await work();}catch(e){if(!['XG_TRANSACTION_BUSY','XG_COMMIT_UNKNOWN'].includes(e.code)||i===4)throw e;await new Promise(resolve=>setTimeout(resolve,250+Math.random()*500));}}}
 const clients=[];
 try{
  await provenance.publishVersions({...defaultVersionBundle(),item_version:'t21-items',rule_version:'t21-rules',published_by:'t21-admin',expected_revision:0});
  for(const scope of ['assessment','followup'])await consent.publishPolicy({scope,version:'t21-synthetic',title:'TEST ONLY',content:'Synthetic isolated integration consent; not production.',published_by:'t21-admin',expected_revision:0});
  context.checked(await db.collection(physical('counselors')).doc('t21-c').set({id:'t21-c',is_active:true,review_status:'approved',is_demo:false}));
  await check('signed identity, consent, intake, approval and cycle through HTTP',async()=>{
   for(let n=0;n<5;n++){
    const bridge=createIdentityHandler({getWXContext:()=>({SOURCE:'wx_client',APPID:'wx-t21',OPENID:`t21-synthetic-${n}`}),parseContext:()=>({environment:{WX_OPENID:`t21-synthetic-${n}`,WX_APPID:'wx-t21'}}),secret:bridgeSecret,appId:'wx-t21',audience:'t21-aud'});
    const assertion=await bridge({},{}),login=await request('/auth/visitor','',assertion.assertion?{assertion:assertion.assertion}:{},200);
    const token=login.token,visitor=login.visitor.id;await request('/auth/visitor','',{assertion:assertion.assertion},401);
    const who={role:'visitor',subject:visitor,aud:'xg-assessment',demo:false,auth_method:'wechat-cloud',exp:Date.now()+3600000};
    for(const scope of ['assessment','followup']){const state=await consent.getStatus(visitor,scope);await consent.decide(who,{scope,version:state.required_version,document_hash:state.required_document.content_hash,agreed:true,channel:'web',client_event_id:`consent-${n}-${scope}`,expected_revision:0});}
    const intake=await request('/v1/xg/intakes',token,{answers:{synthetic:true}},201),pending=await request('/v1/xg/match-requests',token,{assessment_id:intake.assessment_id,counselor_id:'t21-c'},201);
    await request(`/v1/xg/match-requests/${pending.request_id}/approve`,counselor,{});
    const match=await request('/v1/xg/matches',counselor,{request_id:pending.request_id});clients.push({token,visitor,who,match_id:match.match_id});
   }
  });
  async function start(c,label,scale=S.baseline,session=0,round=''){return request('/v1/xg/events/start',c.token,{match_id:c.match_id,scale_code:scale,session_no:session,follow_round:round,client_event_id:label},201);}
  async function submit(c,started,label){const event=await internal.get(C.events,started.event_id);const answers=Object.fromEntries(event.basis.items.filter(i=>i.applicable).map((i,n)=>[i.code,i.item_type==='text'?'Synthetic integration':i.item_type==='single_choice'?i.options[0].value:5+n%4]));return request('/v1/xg/events',c.token,{match_id:c.match_id,event_id:started.event_id,request_id:label,answers},201);}
  await check('five valid submissions atomically enqueue LLM and replay frozen scores',async()=>{
   for(let n=0;n<clients.length;n++){const c=clients[n];c.started=await start(c,`baseline-${n}`);clock+=120000;await submit(c,c.started,`submit-${n}`);const replay=await request(`/v1/xg/admin/event-score-replay?match_id=${c.match_id}&event_id=${c.started.event_id}`);assert.equal(replay.matches,true);assert.equal((await internal.get(C.llmJobs,c.started.event_id)).status,'pending');}
  });
  await check('real aggregate projection and declared indexes produce five-person cohort',async()=>{const date=new Date(clock+8*3600000).toISOString().slice(0,10);const stats=await request(`/v1/xg/admin/stats?from=${date}&to=${date}`);assert.equal(stats.metrics.fill_duration_ms.n,5);assert.equal(stats.metrics.abandon_rate.value,0);assert.equal(stats.metrics.llm_success_rate.value,0);assert.doesNotMatch(JSON.stringify(stats),/visitor_id|match_id|event_id/);});
  await check('cross-cycle reads, visitor scores, generic collections and service secrets fail closed',async()=>{
   await request(`/v1/xg/events?match_id=${clients[1].match_id}`,clients[0].token,undefined,403);
   const result=await request(`/v1/xg/events?match_id=${clients[0].match_id}`,clients[0].token);assert.doesNotMatch(JSON.stringify(result),/raw_answers|ors_total|"scores"/);
   await request(`/v1/xg/llm-results?match_id=${clients[0].match_id}`,clients[0].token,undefined,403);await request('/v1/xg/jobs/events-expire',admin,{},401);
   for(const name of Object.values(C))await request(`/rest/v1/${name}`,admin,undefined,404);
  });
  await check('concurrent real workers publish one result per job and maintain success denominator',async()=>{
   const id=clients[0].started.event_id;const settled=await Promise.allSettled(Array.from({length:5},()=>retry(()=>store.llmWorker.processTask(id))));for(const r of settled)if(r.status==='rejected')throw r.reason;const outcomes=settled.map(r=>r.value);assert.ok(outcomes.some(r=>r.status==='done'));assert.equal(llmCalls,1);
   const batch=await request('/v1/xg/jobs/llm-run',scheduler,{limit:5});assert.equal(batch.errors.length,0);assert.equal(llmCalls,5);
   const date=new Date(clock+8*3600000).toISOString().slice(0,10),stats=await request(`/v1/xg/admin/stats?metric=llm_success&from=${date}&to=${date}`);assert.equal(stats.metrics.llm_success_rate.value,1);
  });
  await check('server timeout query and competing reapers make one durable terminal transition',async()=>{
   const c=clients[0],pending=await start(c,'expiring',S.feel,1);clock+=1800000;
   const settled=await Promise.allSettled([retry(()=>flow.reapExpired()),retry(()=>flow.reapExpired())]);for(const r of settled)if(r.status==='rejected')throw r.reason;const outcomes=settled.map(r=>r.value);assert.equal(outcomes.flatMap(r=>r.results).filter(r=>r.outcome==='reaped').length,1);
   const event=await internal.get(C.events,pending.event_id);assert.equal(event.status,'abandoned');assert.equal(event.duration_ms,1800000);assert.equal(event.event_revision,2);
  });
  await check('closed-cycle followup queue, provider rejection, private fallback and return',async()=>{
   const c=clients[1];const closed=await request('/v1/xg/m4/close',matching,{match_id:c.match_id,session_no:1});clock=Date.parse(closed.follow_1m_due_at);
   const batch=await request('/v1/xg/jobs/follow-dispatch',scheduler,{limit:10});assert.equal(batch.errors.length,0);const job=batch.results.find(r=>r.job_id);assert.ok(job);
   const delivery=await request('/v1/xg/jobs/notification-deliver',scheduler,{limit:10});assert.equal(delivery.errors.length,0);assert.equal(notificationCalls,1);
   const task=await internal.get(C.notificationTasks,job.job_id);assert.equal(task.delivery_result,'inapp_stored');assert.equal(task.primary_failed,true);assert.ok(await internal.get(C.notificationInbox,job.job_id));
   const started=await start(c,'followup',S.follow,1,'1m');clock+=120000;await submit(c,started,'followup-submit');assert.equal((await internal.get(C.followupJobs,job.job_id)).status,'completed');
  });
  await check('consent revocation blocks writes and leaves submitted scores unchanged',async()=>{const c=clients[2],state=await consent.getStatus(c.visitor,'assessment');await consent.decide(c.who,{scope:'assessment',version:state.version,document_hash:state.document_hash,agreed:false,channel:'web',client_event_id:'revoke',expected_revision:state.revision});await request('/v1/xg/events/start',c.token,{match_id:c.match_id,scale_code:S.feel,session_no:1,client_event_id:'after-revoke'},409);assert.equal((await internal.get(C.events,c.started.event_id)).status,'submitted');});
  report.mock_calls={notifications:notificationCalls,llm:llmCalls};requestTimes.sort((a,b)=>a-b);report.local_http_observation={requests:requestTimes.length,p50_ms:requestTimes[Math.floor(requestTimes.length*.5)],p95_ms:requestTimes[Math.min(requestTimes.length-1,Math.floor(requestTimes.length*.95))],sla_claim:false};
 }finally{await new Promise(resolve=>server.close(resolve));}
}
async function main(){
 if(!['--run','--cleanup','--probe-conflicts'].includes(process.argv[2]))throw new Error('Use --run, --probe-conflicts or --cleanup <report path>');
 let previous;if(process.argv[2]==='--cleanup'){const file=path.resolve(process.argv[3]||'');assert.equal(path.dirname(file),path.resolve(__dirname,'../outputs/t21'));previous=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(previous.env,'xpg-demo-d3gzsswtcc3233ea0');}
 const c=await open(previous);
 if(previous){await c.cleanup();console.log('CLEANUP VERIFIED');return;}
 try{
  if(process.argv[2]==='--probe-conflicts'){
   c.report.scope.probe='conflict_observability';await c.prepare([C.matches]);const observations=[];
   const store=createCloudBaseAssessmentStore(c.mapped,{onTransactionEvent:e=>{observations.push({type:e.type,...(e.code?{code:safeCode({code:e.code})}:{})});}});
   await store.transaction(tx=>tx.put(C.matches,'probe',{count:0}));
   const results=await Promise.allSettled(Array.from({length:5},()=>store.transaction(async tx=>{const row=await tx.get(C.matches,'probe');await tx.put(C.matches,'probe',{count:row.count+1});})));
   for(const r of results)if(r.status==='rejected')throw r.reason;
   assert.equal((await store.get(C.matches,'probe')).count,5);assert.ok(observations.some(e=>e.type==='conflict'));
   c.report.observations=observations;c.report.tests.push({name:'five concurrent increments preserve every commit; record rollback codes',passed:true});
  }else{await c.prepare();await run(c);}
  c.report.passed=true;
 }
 catch(e){c.report.passed=false;c.report.error={code:safeCode(e),phase:c.report.tests.length};c.persist();console.error(`FAIL ${safeCode(e)}; ${e.code==='ERR_ASSERTION'?e.message:'see sanitized report'}`);process.exitCode=1;}
 finally{await c.cleanup();c.persist();console.log('REPORT '+c.output);}
}
if(require.main===module)main().catch(e=>{console.error('T21 FAILED '+safeCode(e));process.exitCode=1;});
