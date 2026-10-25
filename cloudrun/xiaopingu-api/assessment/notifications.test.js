const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createAssessmentRepository}=require('./repository');
const {createConsentRepository}=require('./consent');
const {createEventLifecycle}=require('./event-lifecycle');
const {createFollowupRepository}=require('./followups');
const {createIdentityRepository}=require('./identity-repository');
const {createRolloutRepository}=require('./rollout');
const {createNotificationWorker}=require('./notification-worker');
const {createNotificationService}=require('./notification-service');
const {alertTaskId,recipientId}=require('./notification-source');
const {memoryAssessmentStore}=require('./test-support');
const {COLLECTIONS:C,SCALES:S,documentKey}=require('./model');
const {createRequestHandler,signSession}=require('../app');
const actor=(role='visitor',subject=role==='visitor'?'v':role==='counselor'?'c':'admin')=>({role,subject,aud:'xg-assessment',demo:false,exp:Date.now()+3600000,auth_method:role==='visitor'?'wechat-cloud':role==='counselor'?'counselor-edit':'admin-password'});
async function fixture() {
  let time=Date.parse('2026-01-01T00:00:00Z'),serial=0,inside=0;
  const db=memoryAssessmentStore(), store={...db,transaction:(work)=>db.transaction(async(tx)=>{inside++;try{return await work(tx);}finally{inside--;}})};
  const repo=createAssessmentRepository(store,{now:()=>new Date(time).toISOString()}),consent=createConsentRepository(store),rollout=createRolloutRepository(store);
  const flow=createEventLifecycle(store,consent,{now:()=>time}),followups=createFollowupRepository(store,{now:()=>time});
  const service=createNotificationService(store,{now:()=>time,validateCounselor:async(id)=>id==='c'});
  await store.transaction((tx)=>tx.put(C.visitors,'v',{visitor_id:'v',provider:'wechat-cloud'}));
  for(const scope of ['assessment','followup'])await consent.publishPolicy({scope,version:'test',title:'TEST',content:'Synthetic only.',published_by:'test',expected_revision:0});
  async function sign(scope='followup',agreed=true){const state=await consent.getStatus('v',scope);return consent.decide(actor(),{scope,version:agreed?state.required_version:state.version,document_hash:agreed?state.required_document.content_hash:state.document_hash,agreed,channel:'web',client_event_id:`consent-${++serial}`,expected_revision:state.revision});}
  await sign('assessment');await sign();
  await repo.createMatch({match_id:'case',visitor_id:'v',counselor_id:'c',assessment_id:'intake'});
  async function configure(patch){const current=await rollout.get();return rollout.update(actor('admin'),{expected_revision:current.revision,patch,reason:'test'});}
  async function card(scale,session,value=6,extras={}){
    const who=actor(scale===S.pro?'counselor':'visitor'),event=(await flow.start(who,{match_id:'case',scale_code:scale,session_no:session,client_event_id:`start-${++serial}`})).event;
    const answers=Object.fromEntries(event.basis.items.filter(i=>i.applicable).map(i=>[i.code,i.item_type==='single_choice'?0:value]));Object.assign(answers,extras);
    return (await flow.submit(who,{match_id:'case',event_id:event.event_id,request_id:`submit-${++serial}`,answers})).event;
  }
  async function followup(){const closed=await repo.closeMatch('case',3);time=Date.parse(closed.followup_due['1m']);const batch=await followups.dispatchDue();return batch.results[0].job_id;}
  async function alert(safety=false){
    if(safety){await card(S.baseline,0,7,{d1:2});return {id:documentKey('case',0,'DISSOC'),task:alertTaskId(documentKey('case',0,'DISSOC'))};}
    await card(S.feel,1,6);await card(S.feel,2,6);return {id:documentKey('case',2,'ALL-TOTAL'),task:alertTaskId(documentKey('case',2,'ALL-TOTAL'))};
  }
  const calls=[];
  function worker(send=async()=>({kind:'accepted',code:'OK',provider_receipt_id:'receipt-1'}),options={}) {
    return createNotificationWorker(store,{now:()=>time,provider:{async send(input){assert.equal(inside,0,'external send must be outside transactions');calls.push(input);return send(input);}},...options});
  }
  return {db,store,repo,consent,rollout,flow,followups,service,calls,worker,followup,alert,configure,sign,card,advance:(ms)=>{time+=ms;},now:()=>time};
}

test('T17 followup accepted result is distinct from queue, start and user read',async()=>{
 const f=await fixture(),id=await f.followup(),w=f.worker();
 assert.equal((await f.db.get(C.notificationTasks,id)).status,'queued');
 const result=await w.processTask(id);assert.equal(result.status,'sent');assert.equal(f.calls.length,1);
 const task=await f.db.get(C.notificationTasks,id);assert.equal(task.delivery_result,'provider_accepted');assert.ok(task.sent_at);assert.ok(task.notified_at);
 const profile=(await f.repo.getProfiles('case')).end;assert.equal(profile.follow_1m_result,'sent');assert.equal(profile.follow_1m_notify_channel,'miniprogram');
 assert.equal(f.db.snapshot()[C.notificationInbox].size,0);
 const before=f.db.snapshot();await w.processTask(id);assert.deepEqual(f.db.snapshot(),before);assert.equal(f.calls.length,1);
});

test('T17 concurrent workers only one lease can reach the provider',async()=>{
 const f=await fixture(),id=await f.followup(),w=f.worker();
 await Promise.all(Array.from({length:10},()=>w.processTask(id)));assert.equal(f.calls.length,1);assert.equal(f.db.snapshot()[C.notificationAttempts].size,1);
});

test('T17 explicit temporary rejection backs off and respects its attempt budget before inapp fallback',async()=>{
 const f=await fixture(),id=await f.followup(),w=f.worker(async()=>({kind:'retryable',code:'BUSY'}));
 assert.equal((await w.processTask(id)).status,'retry_wait');const first=await f.db.get(C.notificationTasks,id);
 assert.equal(Date.parse(first.next_attempt_at)-f.now(),60000);assert.equal((await w.processTask(id)).status,'not_due');
 f.advance(60000);assert.equal((await w.processTask(id)).status,'retry_wait');
 assert.equal(Date.parse((await f.db.get(C.notificationTasks,id)).next_attempt_at)-f.now(),120000);
 f.advance(120000);assert.equal((await w.processTask(id)).status,'sent');assert.equal(f.calls.length,3);
 const task=await f.db.get(C.notificationTasks,id);assert.equal(task.delivered_channel,'inapp');assert.equal(task.primary_failed,true);assert.equal(task.delivery_result,'inapp_stored');
 assert.equal(f.db.snapshot()[C.notificationAttempts].size,3);assert.equal(f.db.snapshot()[C.notificationInbox].size,1);
});

test('T17 permanent rejection stores one inapp fallback without falsely claiming primary success',async()=>{
 const f=await fixture(),id=await f.followup();await f.worker(async()=>({kind:'rejected',code:'WX_43101',raw:'secret response'})).processTask(id);
 const task=await f.db.get(C.notificationTasks,id);assert.equal(task.delivered_channel,'inapp');assert.equal(task.last_result.kind,'rejected');
 assert.equal(task.last_result.raw,undefined);const attempt=[...f.db.snapshot()[C.notificationAttempts].values()][0];assert.equal(attempt.state,'rejected');
 const messages=await f.service.messages(actor());assert.equal(messages.messages.length,1);assert.equal(messages.messages[0].read_at,null);
 const read=await f.service.markRead(actor(),id);assert.equal((await f.service.messages(actor())).messages[0].read_at,read.read_at);
 assert.equal((await f.db.get(C.notificationTasks,id)).status,'sent');
});

test('T17 missing provider configuration falls back to real persisted inapp, never a fake network success',async()=>{
 const f=await fixture(),id=await f.followup();const w=createNotificationWorker(f.store,{now:f.now});
 await w.processTask(id);assert.equal((await f.db.get(C.notificationTasks,id)).delivery_result,'inapp_stored');assert.equal(f.calls.length,0);
});

test('T17 network ambiguity is quarantined, falls back once, and never automatically retries the external call',async()=>{
 const f=await fixture(),id=await f.followup(),w=f.worker(async()=>{throw new Error('secret phone/token');});
 assert.equal((await w.processTask(id)).status,'uncertain');assert.equal(f.db.snapshot()[C.notificationInbox].size,1);
 assert.equal((await f.repo.getProfiles('case')).end.follow_1m_result,'unknown');f.advance(86400000);
 await w.processTask(id);await w.runBatch();assert.equal(f.calls.length,1);
 const detail=await f.service.task(actor('admin'),id);assert.equal(JSON.stringify(detail).includes('secret phone'),false);
});

test('T17 expired prepared lease can recover; its old owner is fenced before any send',async()=>{
 const f=await fixture(),id=await f.followup(),w=f.worker(),old=await w.claim(id);f.advance(60001);
 const current=await w.claim(id);assert.equal(current.status,'claimed');assert.notEqual(current.lease_token,old.lease_token);
 assert.equal(await w.begin(old),null);assert.ok(await w.begin(current));await w.finish(current,{kind:'accepted',code:'OK'});
 assert.equal(f.calls.length,0);assert.equal((await f.db.get(C.notificationTasks,id)).status,'sent');
 const attempts=await f.store.notificationAttempts(id);assert.equal(attempts[0].state,'expired_before_dispatch');
});

test('T17 expired dispatching lease cannot resend and late acknowledgement cannot overwrite newer state',async()=>{
 const f=await fixture(),id=await f.followup(),w=f.worker(),claim=await w.claim(id);await w.begin(claim);f.advance(60001);
 assert.equal((await w.claim(id)).status,'uncertain');const task=await f.db.get(C.notificationTasks,id);
 assert.equal((await w.finish(claim,{kind:'accepted',code:'OK',provider_receipt_id:'late-id'})).status,'stale_lease');
 assert.deepEqual(await f.db.get(C.notificationTasks,id),task);
 assert.equal((await f.store.notificationAttempts(id))[0].late_result.kind,'accepted');
});

test('T17 duplicate acknowledgement never adds a second receipt or changes counters',async()=>{
 const f=await fixture(),id=await f.followup(),w=f.worker(),claim=await w.claim(id);await w.begin(claim);
 const reply={kind:'accepted',code:'OK',provider_receipt_id:'r'};await w.finish(claim,reply);const before=f.db.snapshot();
 assert.equal((await w.finish(claim,reply)).status,'already_recorded');assert.deepEqual(f.db.snapshot(),before);
});

test('T17 persistence failure after provider acknowledgement does not cause an external resend',async()=>{
 const f=await fixture(),id=await f.followup(),w=f.worker(async()=>{f.db.failNextWriteTo(C.notificationTasks);return {kind:'accepted',code:'OK'};});
 await assert.rejects(w.processTask(id),/Injected storage failure/);assert.equal(f.calls.length,1);f.advance(60001);
 assert.equal((await w.processTask(id)).status,'uncertain');assert.equal(f.calls.length,1);
});

for(const kind of ['consent','pause'])test(`T17 ${kind} change between claim and send is enforced again`,async()=>{
 const f=await fixture(),id=await f.followup(),w=f.worker(),claim=await w.claim(id);
 if(kind==='consent')await f.sign('followup',false);else await f.configure({collection_paused:true});
 assert.equal(await w.begin(claim),null);assert.equal(f.calls.length,0);assert.equal((await f.db.get(C.notificationTasks,id)).status,'blocked');
 assert.equal((await f.db.get(C.notificationTasks,id)).sent_at,undefined);
 if(kind==='consent')await f.sign();else await f.configure({collection_paused:false});f.advance(60000);
 assert.equal((await w.processTask(id)).status,'sent');
});

test('T17 stage and case switches are checked on final alert authorization; safety bypasses visibility stop',async()=>{
 const f=await fixture(),alert=await f.alert(),w=f.worker();assert.equal((await w.processTask(alert.task)).status,'blocked');
 await f.rollout.caseSwitch(actor('counselor'),'case',{enable_reminder:true});f.advance(60000);
 const claimed=await w.claim(alert.task);await f.configure({emergency_stop:true});assert.equal(await w.begin(claimed),null);assert.equal(f.calls.length,0);
 const g=await fixture(),safety=await g.alert(true);await g.configure({emergency_stop:true});await g.worker().processTask(safety.task);assert.equal(g.calls[0].channel,'sms');
});

test('T17 safety SMS failure creates an inapp fallback and an explicit telephone-followup requirement',async()=>{
 const f=await fixture(),a=await f.alert(true);await f.worker(async()=>({kind:'rejected',code:'SMS_NOT_CONFIGURED'})).processTask(a.task);
 const action=await f.db.get(C.alertActions,a.id);assert.equal(action.phone_followup_required,true);assert.equal(action.status,'open');
 assert.equal((await f.service.messages(actor('counselor'))).messages.length,1);
 assert.equal((await f.service.messages(actor())).messages.length,0);
 await f.configure({enable_cst:true});let rev=action.revision;
 const call=async(step,close=false,phone=false)=>f.service.act(actor('counselor'),a.id,'cst',{match_id:'case',expected_revision:rev,note:'已核对并记录',cst_step:step,close,phone_followup_done:phone});
 rev=(await call(1)).revision;rev=(await call(2)).revision;
 await assert.rejects(call(3,true),{code:'XG_CST_INCOMPLETE'});const closed=await call(3,true,true);assert.equal(closed.status,'closed');
 assert.equal(closed.phone_followup_done,true);assert.equal((await f.db.get(C.notificationTasks,a.task)).status,'sent');
});

test('T17 delivery alone never acknowledges or closes an alert; CST requires enabled sequential actions',async()=>{
 const f=await fixture(),a=await f.alert();await f.configure({enable_reminder:true});await f.worker().processTask(a.task);
 assert.equal((await f.db.get(C.alertActions,a.id)).status,'open');
 const input={match_id:'case',expected_revision:0,note:'已查看'};const ack=await f.service.act(actor('counselor'),a.id,'ack',input);assert.equal(ack.status,'acked');
 const before=f.db.snapshot();await f.service.act(actor('counselor'),a.id,'ack',input);assert.deepEqual(f.db.snapshot(),before);
 await assert.rejects(f.service.act(actor('counselor'),a.id,'cst',{...input,expected_revision:1,cst_step:1}),{code:'XG_CST_DISABLED'});
 await f.configure({enable_cst:true});await assert.rejects(f.service.act(actor('counselor'),a.id,'cst',{...input,expected_revision:1,cst_step:3,close:true}),{code:'XG_CST_ORDER'});
 assert.equal((await f.repo.reminderInbox(actor('counselor'),'case')).items.length,1);
 assert.equal((await f.repo.reminderInbox(actor('counselor'),'case',{status:'open'})).items.length,0);
 assert.equal((await f.repo.reminderInbox(actor('counselor'),'case',{status:'acked'})).items.length,1);
});

test('T17 already completed followup cannot be delivered after a lease is prepared',async()=>{
 const f=await fixture(),id=await f.followup(),w=f.worker(),claim=await w.claim(id);
 const event=(await f.flow.start(actor(),{match_id:'case',scale_code:S.follow,session_no:3,follow_round:'1m',client_event_id:'follow'})).event;
 await f.flow.submit(actor(),{match_id:'case',event_id:event.event_id,request_id:'answer',answers:Object.fromEntries(event.basis.items.map(i=>[i.code,6]))});
 assert.equal(await w.begin(claim),null);assert.equal((await f.db.get(C.notificationTasks,id)).status,'cancelled');assert.equal(f.calls.length,0);
});

test('T17 manual resolution is admin-only, revision-guarded and requires evidence before retry or success',async()=>{
 const f=await fixture(),id=await f.followup(),w=f.worker(async()=>({kind:'unknown',code:'TIMEOUT'}));await w.processTask(id);
 const task=await f.db.get(C.notificationTasks,id),input={expected_revision:task.revision,outcome:'not_sent',reason:'已核对服务商记录',evidence_reference:'review-1'};
 await assert.rejects(f.service.resolve(actor('counselor'),id,input),{code:'XG_FORBIDDEN'});
 await assert.rejects(f.service.resolve(actor('admin'),id,{...input,evidence_reference:''}),{code:'XG_BAD_PARAM'});
 await f.service.resolve(actor('admin'),id,input);assert.equal((await f.db.get(C.notificationTasks,id)).status,'retry_wait');
 await assert.rejects(f.service.resolve(actor('admin'),id,input),{code:'XG_NOTIFICATION_CONFLICT'});
 await f.worker().processTask(id);assert.equal((await f.db.get(C.notificationTasks,id)).status,'sent');assert.equal(f.db.snapshot()[C.notificationInbox].size,1);
});

test('T17 messages and actions enforce recipient and cycle ownership without exposing private contacts',async()=>{
 const f=await fixture(),id=await f.followup();await f.worker(async()=>({kind:'rejected',code:'NO_QUOTA'})).processTask(id);
 assert.equal((await f.service.messages(actor('counselor'))).messages.length,0);
 await assert.rejects(f.service.markRead(actor('visitor','other'),id),{code:'XG_FORBIDDEN'});
 await f.sign('followup',false);assert.deepEqual((await f.service.messages(actor())).messages,[]);
 const g=await fixture(),a=await g.alert();await g.configure({enable_reminder:true});
 await assert.rejects(g.service.act(actor('counselor','other'),a.id,'ack',{match_id:'case',expected_revision:0}),{code:'XG_FORBIDDEN'});
 await assert.rejects(g.service.task(actor(),a.task),{code:'XG_FORBIDDEN'});
});

test('T17 corrupt recipient binding stops outbound calls rather than using another user address',async()=>{
 const f=await fixture(),id=await f.followup();await f.store.transaction(tx=>tx.put(C.notificationRecipients,recipientId('visitor','v'),{recipient_role:'visitor',recipient_id:'other',openid:'private'}));
 await f.worker().processTask(id);assert.equal(f.calls.length,0);assert.equal((await f.db.get(C.notificationTasks,id)).status,'failed');
});

test('T17 counselor contact bindings are private, verified, revisioned and can be disabled without losing addresses',async()=>{
 const f=await fixture();const input={counselor_id:'c',expected_revision:0,disabled:false,phone_e164:'+8613800000000',phone_verified:true,openid:'test-openid',appid:'wx-test',reason:'管理员核对'};
 await assert.rejects(f.service.bindRecipient(actor(),input),{code:'XG_FORBIDDEN'});
 await assert.rejects(f.service.bindRecipient(actor('admin'),{...input,phone_verified:false}),{code:'XG_BAD_PARAM'});
 const bound=await f.service.bindRecipient(actor('admin'),input);assert.equal(bound.has_phone,true);assert.equal(JSON.stringify(bound).includes('138000'),false);
 await f.service.bindRecipient(actor('admin'),{counselor_id:'c',expected_revision:1,disabled:true,reason:'暂时停用'});
 const stored=await f.db.get(C.notificationRecipients,recipientId('counselor','c'));assert.equal(stored.phone_e164,input.phone_e164);assert.equal(stored.disabled,true);
});

test('T17 HTTP protects scheduler delivery, private audit, message read and action mutation endpoints',async(t)=>{
 const f=await fixture(),id=await f.followup(),secret='session-test',scheduler='scheduler-test-only-'.repeat(3);
 const store={assessment:f.repo,identity:createIdentityRepository(f.store),consent:f.consent,lifecycle:f.flow,followups:f.followups,notifications:f.service,
 notificationWorker:f.worker(async()=>({kind:'rejected',code:'NO_QUOTA'})),async list(){return[];},async findById(_table,id){return{id,is_active:true,review_status:'approved'};}};
 const server=http.createServer(createRequestHandler({store,sessionSecret:secret,serviceSecrets:{scheduler,matching:'matching-test-only-'.repeat(3)}}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 async function req(path,who=actor(),method='GET',body,rawToken){const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/xg${path}`,{method,headers:{'content-type':'application/json',authorization:`Bearer ${rawToken||signSession(who,secret)}`},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json(),cache:response.headers.get('cache-control')};}
 assert.equal((await req('/jobs/notification-deliver',actor('admin'),'POST',{})).status,401);
 assert.equal((await req('/jobs/notification-deliver',actor(),'POST',{task_id:id},scheduler)).status,400);
 assert.equal((await req('/jobs/notification-deliver',actor(),'POST',{limit:10},scheduler)).body.results[0].status,'sent');
 const messages=await req('/messages');assert.equal(messages.status,200);assert.equal(messages.cache,'no-store');assert.equal(messages.body.messages.length,1);
 assert.equal((await req(`/messages/${id}/read`,actor(),'POST',{})).status,200);
 assert.equal((await req(`/messages/${id}/read`,actor('counselor'),'POST',{})).status,403);
 assert.equal((await req(`/admin/notifications/${id}`,actor())).status,403);
 const audit=await req(`/admin/notifications/${id}`,actor('admin'));assert.equal(audit.status,200);assert.equal('lease_token' in audit.body.task,false);
 assert.equal((await req('/messages?limit=0')).status,400);
 assert.equal((await req('/admin/notification-recipient',actor(),'POST',{})).status,403);
});

test('T17 closing CST fences an in-flight worker and late receipt remains only in the attempt audit',async()=>{
 const f=await fixture(),a=await f.alert();await f.configure({enable_reminder:true,enable_cst:true});
 const w=f.worker(),claim=await w.claim(a.task);await w.begin(claim);
 let rev=0;for(const step of [1,2,3]){const result=await f.service.act(actor('counselor'),a.id,'cst',{match_id:'case',expected_revision:rev,note:'已核对处理',cst_step:step,close:step===3});rev=result.revision;}
 const before=await f.db.get(C.alertActions,a.id);assert.equal((await f.db.get(C.notificationTasks,a.task)).status,'cancelled');
 assert.equal((await w.finish(claim,{kind:'accepted',code:'OK'})).status,'stale_lease');
 assert.deepEqual(await f.db.get(C.alertActions,a.id),before);assert.equal((await f.db.get(C.notificationTasks,a.task)).status,'cancelled');
});

test('T17 alert source and notification task are atomic; repeat composition never duplicates the ledger',async()=>{
 const f=await fixture();await f.card(S.feel,1,6);f.db.failNextWriteTo(C.notificationTasks);
 await assert.rejects(f.card(S.feel,2,6),{code:'XG_COMBINATION_PENDING'});
 const id=documentKey('case',2,'ALL-TOTAL');assert.equal(await f.db.get(C.alertActions,id),null);
 await f.repo.getCombination('case',2);assert.ok(await f.db.get(C.alertActions,id));
 assert.equal([...f.db.snapshot()[C.notificationTasks].values()].filter(t=>t.alert_id===id).length,1);
});

test('T17 even a temporary SMS failure immediately creates safety fallback and telephone follow-up',async()=>{
 const f=await fixture(),a=await f.alert(true);const w=f.worker(async()=>({kind:'retryable',code:'SMS_RequestLimitExceeded'}));
 assert.equal((await w.processTask(a.task)).status,'retry_wait');assert.equal(f.db.snapshot()[C.notificationInbox].size,1);
 assert.equal((await f.db.get(C.alertActions,a.id)).phone_followup_required,true);
 assert.equal((await f.db.get(C.notificationTasks,a.task)).fallback_inapp,true);
});

test('T18 first trigger and first CST timestamps survive recomputation and subsequent actions',async()=>{
 const f=await fixture(),a=await f.alert();await f.configure({enable_reminder:true,enable_cst:true});
 const initial=await f.db.get(C.alertActions,a.id);assert.equal(initial.initial_level,'L2');assert.equal(initial.alert_type,'alliance');assert.ok(initial.triggered_at);
 f.advance(3600000);await f.service.act(actor('counselor'),a.id,'ack',{match_id:'case',expected_revision:0,note:'已查看'});
 assert.equal((await f.db.get(C.alertActions,a.id)).cst_started_at,undefined);
 const times=[];let revision=1;for(const step of [1,2,3]){
   f.advance(3600000);const result=await f.service.act(actor('counselor'),a.id,'cst',{match_id:'case',expected_revision:revision,note:'已处理',cst_step:step,close:step===3});revision=result.revision;
   times.push((await f.db.get(C.alertActions,a.id)).cst_started_at);
 }
 assert.equal(new Set(times).size,1);
 f.advance(3600000);await f.card(S.pro,2,6);
 const final=await f.db.get(C.alertActions,a.id);assert.equal(final.triggered_at,initial.triggered_at);assert.equal(final.initial_level,'L2');assert.equal(final.cst_started_at,times[0]);
 assert.equal(final.status,'closed');assert.ok(Date.parse(final.handled_at)>Date.parse(final.cst_started_at));
});
