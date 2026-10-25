const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {AsyncLocalStorage}=require('node:async_hooks');
const {createAssessmentRepository}=require('./repository');
const {createEventLifecycle}=require('./event-lifecycle');
const {createConsentRepository}=require('./consent');
const {createIdentityRepository}=require('./identity-repository');
const {createRolloutRepository}=require('./rollout');
const {createLlmWorker,nextRecovery}=require('./llm-worker');
const {createLlmService}=require('./llm-service');
const {validateOutput,DIMENSIONS,buildSnapshot}=require('./llm-contract');
const {llmView}=require('./read-views');
const {memoryAssessmentStore}=require('./test-support');
const {COLLECTIONS:C,SCALES:S,documentKey}=require('./model');
const {createRequestHandler,signSession}=require('../app');
const actor=(role='visitor',subject=role==='visitor'?'v':role==='counselor'?'c':'admin')=>({role,subject,aud:'xg-assessment',demo:false,auth_method:role==='visitor'?'wechat-cloud':role==='counselor'?'counselor-edit':'admin-password',exp:Date.now()+3600000});
function output(payload,{adjust=true}={}) { const available=payload.available_dimensions;return JSON.stringify({summary:'本次问卷记录了各项自评分。',dim_scores:Object.fromEntries(DIMENSIONS.map(k=>[k,available[k]?60:null])),suggest_actions:['可以讨论本次填写感受'],
  tag_weight_adjust:adjust&&available.ORS?[{tag:'ORS',delta:.1,reason:'供后续辅助分析复核'}]:[]}); }
async function fixture(){
  const db=memoryAssessmentStore();let time=Date.parse('2026-10-25T01:00:00.000Z'),serial=0;const transactionContext=new AsyncLocalStorage();
  const store={...db,transaction:work=>db.transaction(tx=>transactionContext.run(true,()=>work(tx)))};
  const repo=createAssessmentRepository(store,{now:()=>new Date(time).toISOString()}),consent=createConsentRepository(store),flow=createEventLifecycle(store,consent,{now:()=>time}),service=createLlmService(store,{now:()=>time});
  await db.transaction(tx=>tx.put(C.visitors,'v',{visitor_id:'v',provider:'wechat-cloud'}));
  for(const scope of ['assessment','followup'])await consent.publishPolicy({scope,version:'test',title:'TEST',content:'Synthetic test only.',published_by:'test',expected_revision:0});
  async function sign(scope='assessment',agreed=true){const state=await consent.getStatus('v',scope);return consent.decide(actor(),{scope,version:agreed?state.required_version:state.version,document_hash:agreed?state.required_document.content_hash:state.document_hash,agreed,channel:'web',client_event_id:`consent-${++serial}`,expected_revision:state.revision});}
  await sign();await sign('followup');await repo.createMatch({match_id:'case',visitor_id:'v',counselor_id:'c',assessment_id:'intake'});
  async function prepare(scale=S.baseline,session=0){const who=actor(scale===S.pro?'counselor':'visitor');const input={match_id:'case',scale_code:scale,session_no:session,client_event_id:`start-${++serial}`};
    const event=(await flow.start(who,input)).event;const answers=Object.fromEntries(event.basis.items.filter(i=>i.applicable).map((i,index)=>[i.code,i.item_type==='text'?'PRIVATE TEXT 张三 13800138000':i.item_type==='single_choice'?i.options[0].value:5+index%4]));
    return {who,event,input:{match_id:'case',event_id:event.event_id,request_id:`submit-${serial}`,answers}};
  }
  async function card(scale=S.baseline,session=0,low=false){const p=await prepare(scale,session);time+=low?1000:120000;return (await flow.submit(p.who,p.input)).event;}
  const calls=[];
  const worker=(generate=async p=>output(p),model='test-model')=>createLlmWorker(store,{now:()=>time,provider:{ready:true,model,async generate(payload){assert.notEqual(transactionContext.getStore(),true);calls.push(structuredClone(payload));return generate(payload);}}});
  return {db,store,repo,consent,flow,service,prepare,card,worker,calls,sign,advance:ms=>{time+=ms;},setTime:t=>{time=t;},now:()=>time,job:id=>db.get(C.llmJobs,id)};
}

test('T19 accepted submission atomically queues one eligible job without calling provider',async()=>{
 const f=await fixture(),p=await f.prepare();f.advance(120000);await f.flow.submit(p.who,p.input);await f.flow.submit(p.who,p.input);
 assert.equal(f.db.snapshot()[C.llmJobs].size,1);assert.equal((await f.job(p.event.event_id)).status,'pending');assert.equal(f.calls.length,0);
 const g=await fixture(),q=await g.prepare();g.advance(120000);const before=g.db.snapshot();g.db.failNextWriteTo(C.llmJobs);
 await assert.rejects(g.flow.submit(q.who,q.input),/Injected/);assert.deepEqual(g.db.snapshot(),before);
 assert.equal((await g.flow.submit(q.who,q.input)).event.status,'submitted');assert.equal(g.db.snapshot()[C.llmJobs].size,1);
});

test('T19 rejected, abandoned and low-quality submissions never create model jobs',async()=>{
 const f=await fixture(),p=await f.prepare();await f.flow.submit(p.who,{...p.input,answers:{}});
 await f.flow.abandon(p.who,{match_id:'case',event_id:p.event.event_id});await f.card(S.baseline,0,true);
 assert.equal(f.db.snapshot()[C.llmJobs].size,0);await assert.rejects(f.worker().processTask(p.event.event_id),{code:'XG_NOT_FOUND'});
});

test('T19 missing model configuration leaves pending jobs and retry budget untouched',async()=>{
 const f=await fixture(),event=await f.card(),before=f.db.snapshot();const w=createLlmWorker(f.store,{now:f.now});
 assert.equal((await w.runBatch()).configured,false);assert.equal((await w.processTask(event.event_id)).status,'unconfigured');assert.deepEqual(f.db.snapshot(),before);
});

test('T19 success separates results, immutable history, pending weights and deterministic scores',async()=>{
 const f=await fixture(),event=await f.card(),original=await f.db.get(C.events,event.event_id),baseline=await f.db.get(C.baselines,'case');
 assert.equal((await f.worker().processTask(event.event_id)).status,'done');assert.deepEqual(await f.db.get(C.events,event.event_id),original);assert.deepEqual(await f.db.get(C.baselines,'case'),baseline);
 const state=f.db.snapshot();assert.equal(state[C.llmResults].size,1);assert.equal(state[C.llmHistory].size,1);assert.equal(state[C.tagWeightProposals].size,1);assert.equal(state[C.tagWeights].size,0);
 const result=await f.db.get(C.llmResults,event.event_id);assert.equal(result.dim_scores['联盟'],null);assert.equal(llmView(result).advisory_only,true);
 assert.equal((await f.worker().processTask(event.event_id)).status,'done');assert.equal(f.calls.length,1);
});

test('T19 10 concurrent workers acquire one lease and call the model once',async()=>{
 const f=await fixture(),event=await f.card(),w=f.worker();const results=await Promise.all(Array.from({length:10},()=>w.processTask(event.event_id)));
 assert.equal(f.calls.length,1);assert.equal(results.filter(r=>r.status==='done').length,1);assert.equal((await f.job(event.event_id)).attempts,1);
});

test('T19 payload is numerical, cycle-scoped, excludes low-quality context and freezes retries',async()=>{
 const f=await fixture();await f.card(S.feel,2,true);const p=await f.card(S.pro,2);const state=await f.card(S.state,2);
 const w=f.worker(async()=>{throw {code:'XG_LLM_TIMEOUT'};});await w.processTask(state.event_id);
 const payload=f.calls[0];assert.equal(payload.available_dimensions['联盟'],false);assert.ok(payload.cards.some(c=>c.scale_code===S.pro));assert.ok(!payload.cards.some(c=>c.scale_code===S.feel));
 assert.doesNotMatch(JSON.stringify(payload),/visitor_id|counselor_id|match_id|event_id|PRIVATE|张三|13800138000|focus_text/);
 f.advance(1000);await w.processTask(state.event_id);assert.deepEqual(f.calls[1],payload);
 assert.equal((await f.job(p.event_id)).attempts,0);
});

test('T19 first-session missing p6 does not invent alliance and trend preserves actual gaps',async()=>{
 const f=await fixture();await f.card(S.feel,1);const pro=await f.card(S.pro,1);await f.worker().processTask(pro.event_id);
 assert.equal(f.calls[0].available_dimensions['联盟'],false);assert.equal('p6' in f.calls[0].cards.find(c=>c.scale_code===S.pro).answers,false);
 await f.card(S.state,2);const later=await f.card(S.state,4);await f.worker().processTask(later.event_id);
 assert.deepEqual(f.calls.at(-1).trend.map(p=>p.session_no),[2,4]);
});

test('T19 1s/4s retries, next 04:00 recovery and total five-attempt cap',async()=>{
 const f=await fixture(),event=await f.card(),w=f.worker(async()=>{throw {code:'XG_LLM_UPSTREAM_5XX'};});
 assert.equal((await w.processTask(event.event_id)).status,'retry_wait');assert.equal((await w.processTask(event.event_id)).status,'not_due');
 f.advance(1000);assert.equal((await w.processTask(event.event_id)).status,'retry_wait');f.advance(4000);
 assert.equal((await w.processTask(event.event_id)).status,'failed');const job=await f.job(event.event_id);assert.equal(job.attempts,3);
 assert.equal(job.recover_at,'2026-10-25T20:00:00.000Z');assert.equal((await w.recover()).scanned,0);
 f.setTime(Date.parse(job.recover_at));const recovery=await Promise.all([w.recover(),w.recover()]);assert.equal(recovery.flatMap(r=>r.results).filter(r=>r.status==='pending').length,1);
 assert.equal((await w.processTask(event.event_id)).status,'retry_wait');f.advance(4000);assert.equal((await w.processTask(event.event_id)).status,'review_required');
 assert.equal((await f.job(event.event_id)).attempts,5);assert.equal(f.calls.length,5);assert.equal((await w.recover()).scanned,0);
 assert.equal(nextRecovery(Date.parse('2026-10-24T19:59:59.999Z')),'2026-10-24T20:00:00.000Z');
});

for(const [code,status]of [['XG_LLM_UPSTREAM_4XX','failed'],['XG_LLM_UNSAFE_OUTPUT','review_required']])test(`T19 ${code} does not auto-retry`,async()=>{
 const f=await fixture(),event=await f.card(),w=f.worker(async()=>{throw {code,message:'PRIVATE secret provider body'};});
 assert.equal((await w.processTask(event.event_id)).status,status);f.advance(2*86400000);assert.equal((await w.recover()).scanned,0);await w.processTask(event.event_id);assert.equal(f.calls.length,1);
 assert.doesNotMatch(JSON.stringify([...f.db.snapshot()[C.llmAttempts].values()]),/PRIVATE|secret provider/);
});

test('T19 expired lease and old callback cannot overwrite a new attempt',async()=>{
 const f=await fixture(),event=await f.card(),w=f.worker();const first=await w.claim(event.event_id);f.advance(30000);
 assert.equal((await w.claim(event.event_id)).status,'retry_wait');f.advance(1000);const second=await w.claim(event.event_id);
 assert.equal((await w.finish(first,{raw:output(first.payload)})).status,'stale_lease');assert.equal((await w.finish(second,{raw:output(second.payload)})).status,'done');
 const before=f.db.snapshot();await w.finish(first,{raw:output(first.payload)});assert.deepEqual(f.db.snapshot(),before);
});

test('T19 result persistence failure rolls back all result/proposal writes and same callback can retry',async()=>{
 const f=await fixture(),event=await f.card(),w=f.worker(),claimed=await w.claim(event.event_id),before=f.db.snapshot();f.db.failNextWriteTo(C.tagWeightProposals);
 await assert.rejects(w.finish(claimed,{raw:output(claimed.payload)}),/Injected/);assert.deepEqual(f.db.snapshot(),before);
 assert.equal((await w.finish(claimed,{raw:output(claimed.payload)})).status,'done');assert.equal(f.db.snapshot()[C.llmHistory].size,1);
});

test('T19 consent revocation during model call discards result and regrant resumes safely',async()=>{
 const f=await fixture(),event=await f.card(),w=f.worker(async payload=>{await f.sign('assessment',false);return output(payload);});
 assert.equal((await w.processTask(event.event_id)).status,'blocked');assert.equal(f.db.snapshot()[C.llmResults].size,0);await f.sign();f.advance(60000);
 assert.equal((await f.worker().processTask(event.event_id)).status,'done');assert.equal((await f.job(event.event_id)).attempts,2);
});

test('T19 collection pause blocks model calls without consuming attempts',async()=>{
 const f=await fixture(),event=await f.card(),rollout=createRolloutRepository(f.store);
 await rollout.update(actor('admin'),{expected_revision:0,patch:{collection_paused:true},reason:'Test pause'});
 assert.equal((await f.worker().processTask(event.event_id)).status,'blocked');assert.equal(f.calls.length,0);assert.equal((await f.job(event.event_id)).attempts,0);
});

test('T19 frozen model mismatch fails until an administrator requests a new generation',async()=>{
 const f=await fixture(),event=await f.card();await f.worker(async()=>{throw {code:'XG_LLM_TIMEOUT'};}).processTask(event.event_id);f.advance(1000);
 const changed=f.worker(undefined,'new-model');assert.equal((await changed.processTask(event.event_id)).status,'failed');assert.equal(f.calls.length,1);
 const job=await f.job(event.event_id);const input={expected_revision:job.revision,request_id:'new-model',reason:'Review model configuration'};
 await f.service.reprocess(actor('admin'),event.event_id,input);await f.service.reprocess(actor('admin'),event.event_id,input);
 assert.equal((await changed.processTask(event.event_id)).status,'done');assert.equal((await f.job(event.event_id)).generation,2);assert.equal((await f.job(event.event_id)).total_attempts,2);
});

test('T19 weight approval is versioned, idempotent and never changes main scores',async()=>{
 const f=await fixture(),event=await f.card();await f.worker().processTask(event.event_id);const id=documentKey(event.event_id,1),before=f.db.snapshot();
 const input={decision:'approved',expected_revision:0,expected_weight_revision:0,reason:'Reviewed auxiliary analysis only'};
 const results=await Promise.all([f.service.reviewWeights(actor('admin'),id,input),f.service.reviewWeights(actor('admin'),id,input)]);
 assert.equal(results.filter(r=>!r.duplicated).length,1);assert.equal((await f.db.get(C.tagWeights,'case')).weights.ORS,1.1);
 for(const name of [C.events,C.baselines,C.rawSignals,C.combinations])assert.deepEqual(f.db.snapshot()[name],before[name]);
 const second=await f.card(S.state,2);await f.worker().processTask(second.event_id);assert.equal(f.calls.at(-1).tag_weights.ORS,1.1);
 await assert.rejects(f.service.reviewWeights(actor('counselor'),id,input),{code:'XG_FORBIDDEN'});
});

test('T19 concurrent independent proposals cannot apply against stale weight versions',async()=>{
 const f=await fixture(),a=await f.card(),b=await f.card(S.state,2);await f.worker().processTask(a.event_id);await f.worker().processTask(b.event_id);
 const input={decision:'approved',expected_revision:0,expected_weight_revision:0,reason:'Reviewed'};
 await f.service.reviewWeights(actor('admin'),documentKey(a.event_id,1),input);
 await assert.rejects(f.service.reviewWeights(actor('admin'),documentKey(b.event_id,1),input),{code:'XG_LLM_CONFLICT'});
 assert.equal((await f.db.get(C.tagWeights,'case')).revision,1);
});

test('T19 rejecting weights leaves effective weights unchanged and approval failure rolls back',async()=>{
 const f=await fixture(),event=await f.card();await f.worker().processTask(event.event_id);const id=documentKey(event.event_id,1);
 const input={decision:'approved',expected_revision:0,expected_weight_revision:0,reason:'Reviewed'},before=f.db.snapshot();f.db.failNextWriteTo(C.llmAudit);
 await assert.rejects(f.service.reviewWeights(actor('admin'),id,input),/Injected/);assert.deepEqual(f.db.snapshot(),before);
 await f.service.reviewWeights(actor('admin'),id,{...input,decision:'rejected'});assert.equal(f.db.snapshot()[C.tagWeights].size,0);
});

test('T19 result rejection hides output; reprocess preserves history and fences old proposals',async()=>{
 const f=await fixture(),event=await f.card();await f.worker().processTask(event.event_id);const id=event.event_id;
 await f.service.reviewResult(actor('admin'),id,{decision:'rejected',expected_revision:0,generation:1,reason:'Needs human revision'});
 assert.equal(llmView(await f.db.get(C.llmResults,id)),null);assert.equal((await f.job(id)).status,'review_required');
 await assert.rejects(f.service.reviewResult(actor('admin'),id,{decision:'approved',expected_revision:1,generation:1,reason:'Restore'}),{code:'XG_LLM_CONFLICT'});
 const job=await f.job(id);await f.service.reprocess(actor('admin'),id,{expected_revision:job.revision,request_id:'rerun',reason:'New reviewed analysis'});
 await assert.rejects(f.service.reviewWeights(actor('admin'),documentKey(id,1),{decision:'approved',expected_revision:0,expected_weight_revision:0,reason:'Stale'}),{code:'XG_LLM_CONFLICT'});
 await f.worker().processTask(id);assert.equal(f.db.snapshot()[C.llmHistory].size,2);assert.equal((await f.db.get(C.llmResults,id)).generation,2);
});

const available=Object.fromEntries(DIMENSIONS.map(k=>[k,true]));
const valid=()=>JSON.parse(output({available_dimensions:available}));
for(const [name,change]of [
 ['extra keys',v=>{v.scores={total:70};}],['missing dimension',v=>{delete v.dim_scores.ORS;}],['string score',v=>{v.dim_scores.ORS='60';}],['out of range',v=>{v.dim_scores.ORS=101;}],
 ['long summary',v=>{v.summary='字'.repeat(61);}],['clinical summary',v=>{v.summary='病情严重';}],['unsafe action',v=>{v.suggest_actions=['建议用药'];}],['private output',v=>{v.summary='请联系13800138000';}],
 ['many actions',v=>{v.suggest_actions=['甲','乙','丙'];}],['blank action',v=>{v.suggest_actions=[' '];}],['unknown tag',v=>{v.tag_weight_adjust[0].tag='张三';}],
 ['excess adjustment',v=>{v.tag_weight_adjust[0].delta=.21;}],['empty reason',v=>{v.tag_weight_adjust[0].reason='';}],['duplicate tags',v=>{v.tag_weight_adjust.push({...v.tag_weight_adjust[0]});}]
])test(`T19 output validator rejects ${name}`,()=>{const value=valid();change(value);assert.throws(()=>validateOutput(JSON.stringify(value),available));});

test('T19 validator supports JSON fences, exact keys and explicit unavailable dimensions',()=>{
 assert.equal(validateOutput('```json\n'+JSON.stringify(valid())+'\n```',available).dim_scores.ORS,60);
 assert.throws(()=>validateOutput('some explanation '+JSON.stringify(valid()),available),{code:'XG_LLM_INVALID_JSON'});
 assert.throws(()=>validateOutput(JSON.stringify(valid()),{...available,联盟:false}));
 const value=valid();value.dim_scores['联盟']=null;assert.equal(validateOutput(JSON.stringify(value),{...available,联盟:false}).dim_scores['联盟'],null);
});

test('T19 invalid JSON retries but unsafe output immediately requires human review without storing text',async()=>{
 const f=await fixture(),event=await f.card();assert.equal((await f.worker(async()=>'{invalid').processTask(event.event_id)).status,'retry_wait');f.advance(1000);
 assert.equal((await f.worker(async p=>{const value=JSON.parse(output(p));value.summary='病情严重';return JSON.stringify(value);}).processTask(event.event_id)).status,'review_required');
 assert.equal(f.db.snapshot()[C.llmResults].size,0);assert.equal(f.db.snapshot()[C.tagWeightProposals].size,0);
 assert.doesNotMatch(JSON.stringify([...(f.db.snapshot()[C.llmJobs]).values()]),/病情严重/);
});

test('T19 HTTP admin review, result visibility and dedicated scheduler credential boundaries',async(t)=>{
 const f=await fixture(),event=await f.card(),secret='llm-http-test-secret',scheduler='scheduler-test-secret-'.repeat(3),matching='matching-test-secret-'.repeat(3);
 const store={assessment:f.repo,identity:createIdentityRepository(f.store),consent:f.consent,lifecycle:f.flow,llm:f.service,llmWorker:f.worker(),async list(){return [];},async findById(){return {is_active:true,review_status:'approved'};}};
 const server=http.createServer(createRequestHandler({store,sessionSecret:secret,serviceSecrets:{scheduler,matching}}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const request=(path,role='admin',body,token)=>fetch(base+'/v1/xg'+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token||signSession(actor(role),secret)}`},...(body===undefined?{}:{body:JSON.stringify(body)})});
 for(const role of ['visitor','counselor'])assert.equal((await request('/admin/llm-jobs',role)).status,403);
 assert.equal((await request('/admin/llm-jobs?status=secret')).status,400);assert.equal((await request('/admin/llm-jobs?limit=2&limit=3')).status,400);
 for(const token of [matching,signSession(actor('admin'),secret)])assert.equal((await request('/jobs/llm-run','admin',{},token)).status,401);
 assert.equal((await request('/jobs/llm-run','admin',{model:'injected'},scheduler)).status,400);
 const {dispatchLlm}=require('../../../scripts/run-llm-jobs.cjs');const dispatched=await dispatchLlm({apiBase:base,secret:scheduler});assert.equal(dispatched.done,1);
 const detail=await (await request('/admin/llm-jobs/'+event.event_id)).json();assert.equal(detail.proposal.status,'pending');assert.doesNotMatch(JSON.stringify(detail),/input_snapshot|snapshot|lease_token|raw_answers/);
 assert.equal((await request('/llm-results?match_id=case','visitor')).status,403);
 const result=await (await request('/llm-results?match_id=case','counselor')).json();assert.equal(result.results.length,1);assert.equal(result.results[0].advisory_only,true);
 const review={decision:'rejected',expected_revision:0,generation:1,reason:'Human review'};
 assert.equal((await request('/admin/llm-jobs/'+event.event_id+'/review','admin',review)).status,200);
 assert.deepEqual(await (await request('/llm-results?match_id=case','counselor')).json(),{results:[]});
});

test('T19 recovery and worker batches are bounded and repeated scans progress',async()=>{
 const f=await fixture();await f.card();await f.card(S.state,2);const w=f.worker();
 for(const limit of [0,6,'1',1.5])await assert.rejects(w.runBatch({limit}),{code:'XG_BAD_PARAM'});
 for(const limit of [0,101,'1',1.5])await assert.rejects(w.recover({limit}),{code:'XG_BAD_PARAM'});
 assert.equal((await w.runBatch({limit:1})).results[0].status,'done');assert.equal((await w.runBatch({limit:1})).results[0].status,'done');assert.equal((await w.runBatch({limit:1})).scanned,0);
});

test('T19 result rejection is idempotent and stale or forged weight proposals fail closed',async()=>{
 const f=await fixture(),event=await f.card();await f.worker().processTask(event.event_id);const proposalId=documentKey(event.event_id,1);
 const proposal=await f.db.get(C.tagWeightProposals,proposalId);await f.db.transaction(tx=>tx.put(C.tagWeightProposals,proposalId,{...proposal,adjustments:[{tag:'ORS',delta:10,reason:'tampered'}]}));
 await assert.rejects(f.service.reviewWeights(actor('admin'),proposalId,{decision:'approved',expected_revision:0,expected_weight_revision:0,reason:'Review'}),{code:'XG_LLM_CONFLICT'});
 assert.equal(f.db.snapshot()[C.tagWeights].size,0);
 const input={generation:1,expected_revision:0,decision:'rejected',reason:'Review'};await f.service.reviewResult(actor('admin'),event.event_id,input);
 const before=f.db.snapshot();assert.equal((await f.service.reviewResult(actor('admin'),event.event_id,input)).duplicated,true);assert.deepEqual(f.db.snapshot(),before);
});

test('T19 follow-up task retains old cycle/round and obeys follow-up consent',async()=>{
 const f=await fixture();const closed=await f.repo.closeMatch('case',3);f.setTime(Date.parse(closed.followup_due['1m']));
 const p=await f.prepare(S.follow,3).catch(error=>{assert.equal(error.code,'XG_BAD_PARAM');return null;});assert.equal(p,null);
 const started=(await f.flow.start(actor(),{match_id:'case',scale_code:S.follow,session_no:3,follow_round:'1m',client_event_id:'follow'})).event;
 const answers=Object.fromEntries(started.basis.items.filter(i=>i.applicable).map((i,n)=>[i.code,5+n%4]));f.advance(120000);
 const event=(await f.flow.submit(actor(),{match_id:'case',event_id:started.event_id,request_id:'follow-submit',answers})).event;
 assert.equal(event.quality_flag,'ok');await f.sign('followup',false);assert.equal((await f.worker().processTask(event.event_id)).status,'blocked');assert.equal(f.calls.length,0);
 await f.sign('followup');f.advance(60000);assert.equal((await f.worker().processTask(event.event_id)).status,'done');assert.equal(f.calls[0].follow_round,'1m');assert.equal(f.calls[0].cards.length,1);
 assert.ok(Object.values((await f.db.get(C.llmResults,event.event_id)).dim_scores).every(v=>v===null));
});

test('T19 manual weight correction can restore defaults with revision/audit and preserves frozen results',async()=>{
 const f=await fixture(),event=await f.card();await f.worker().processTask(event.event_id);const result=await f.db.get(C.llmResults,event.event_id);
 const input={expected_revision:0,request_id:'manual-1',reason:'Human adjustment after review',weights:{ORS:1.2,联盟:1,稳定度:1,目标进展:1}};
 await assert.rejects(f.service.setWeights(actor('counselor'),'case',input),{code:'XG_FORBIDDEN'});
 assert.equal((await f.service.setWeights(actor('admin'),'case',input)).revision,1);
 assert.equal((await f.service.setWeights(actor('admin'),'case',input)).duplicated,true);
 await assert.rejects(f.service.setWeights(actor('admin'),'case',{...input,request_id:'manual-stale'}),{code:'XG_LLM_CONFLICT'});
 await assert.rejects(f.service.setWeights(actor('admin'),'case',{...input,weights:{...input.weights,ORS:3}}),{code:'XG_BAD_PARAM'});
 const defaults=Object.fromEntries(DIMENSIONS.map(k=>[k,1]));await f.service.setWeights(actor('admin'),'case',{expected_revision:1,request_id:'restore',reason:'Restore previous approved defaults',weights:defaults});
 assert.deepEqual((await f.service.weights(actor('admin'),'case')).weights,defaults);assert.deepEqual(await f.db.get(C.llmResults,event.event_id),result);assert.equal(f.db.snapshot()[C.llmAudit].size,2);
});

test('T19 forged cross-cycle context fails before any provider call',async()=>{
 const f=await fixture(),event=await f.card(S.state,2),{eventPosition}=require('./model');
 await f.db.transaction(tx=>tx.put(C.submissions,eventPosition({match_id:'case',scale_code:S.feel,session_no:2}).submission_id,{match_id:'other',visitor_id:'other',counselor_id:'other',event_id:'other'}));
 await assert.rejects(f.worker().processTask(event.event_id),{code:'XG_SCOPE_MISMATCH'});assert.equal(f.calls.length,0);assert.equal((await f.job(event.event_id)).attempts,0);
});

test('T19 normalization prevents zero-width and full-width output from bypassing privacy/clinical filters',()=>{
 for(const summary of ['病\u200b情明显','请联系１３８００１３８０００','有双相障碍']){
   const value=valid();value.summary=summary;assert.throws(()=>validateOutput(JSON.stringify(value),available),{code:'XG_LLM_UNSAFE_OUTPUT'});
 }
});
