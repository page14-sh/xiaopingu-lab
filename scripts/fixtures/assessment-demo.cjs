// Synthetic, process-local fixtures only. Deliberately accepts no database,
// environment ID, endpoint, session token or provider configuration.
const base='../../cloudrun/xiaopingu-api/assessment/';
const {memoryAssessmentStore}=require(base+'test-support');
const {createAssessmentRepository}=require(base+'repository');
const {createEventLifecycle}=require(base+'event-lifecycle');
const {createConsentRepository}=require(base+'consent');
const {createProvenanceRepository,defaultVersionBundle}=require(base+'provenance');
const {createCombinationRepository}=require(base+'combinations');
const {createRolloutRepository}=require(base+'rollout');
const {createFollowupRepository}=require(base+'followups');
const {createNotificationWorker}=require(base+'notification-worker');
const {createLlmWorker}=require(base+'llm-worker');
const {COLLECTIONS:C,SCALES:S}=require(base+'model');
const {comparisonView}=require(base+'read-views');
const FIXED_START=Date.parse('2026-01-01T01:00:00.000Z');
const numbered=(prefix,values)=>Object.fromEntries(values.map((value,i)=>[prefix+(i+1),value]));
const core=values=>numbered('s',Array.isArray(values)?values:Array(7).fill(values));
const baseline=values=>({...core(values),b1:7,b2:6,b3:7,r1:8,r2:7,d1:0});
const feel=values=>numbered('f',values);
const pro=values=>numbered('p',values);
function actor(role,subject){return {role,subject,aud:'xg-assessment',demo:false,auth_method:{visitor:'wechat-cloud',counselor:'counselor-edit',admin:'admin-password'}[role],exp:Date.now()+3600000};}
async function createHarness(){
  const db=memoryAssessmentStore({withVersions:false});let clock=FIXED_START,serial=0;
  const now=()=>clock,iso=()=>new Date(clock).toISOString();
  const repo=createAssessmentRepository(db,{now:iso}),consent=createConsentRepository(db,{now:iso}),provenance=createProvenanceRepository(db,{now:iso});
  const flow=createEventLifecycle(db,consent,{now}),combos=createCombinationRepository(db,{now:iso}),rollout=createRolloutRepository(db,{now:iso}),followups=createFollowupRepository(db,{now});
  const cases=new Map(),events=new Map(),prepared=new Map();
  await provenance.publishVersions({...defaultVersionBundle(),item_version:'t20-items-v1',rule_version:'t20-rules-v1',published_by:'fixture-admin',expected_revision:0});
  for(const scope of ['assessment','followup'])await consent.publishPolicy({scope,version:'fixture-v1',title:'Synthetic fixture only',content:'Local synthetic acceptance data; not production consent.',published_by:'fixture-admin',expected_revision:0});
  async function sign(visitor,scope='assessment',agreed=true){const state=await consent.getStatus(visitor,scope);return consent.decide(actor('visitor',visitor),{scope,version:agreed?state.required_version:state.version,document_hash:agreed?state.required_document.content_hash:state.document_hash,agreed,channel:'web',client_event_id:`fixture-consent-${++serial}`,expected_revision:state.revision});}
  async function addCase(name,{visitor=`fixture-v-${name}`,counselor=`fixture-c-${name}`,previous}={}){
    if(!await db.get(C.visitors,visitor)){
      await db.transaction(tx=>tx.put(C.visitors,visitor,{visitor_id:visitor,provider:'wechat-cloud',synthetic:true}));await sign(visitor);await sign(visitor,'followup');
    }
    const match=await repo.createMatch({match_id:`fixture-${name}`,visitor_id:visitor,counselor_id:counselor,assessment_id:`fixture-intake-${name}`,previous_match_id:previous});
    cases.set(name,match);return match;
  }
  async function prepare(name,label,scale,session,answers,{round='',duration=120000}={}){
    const match=cases.get(name);if(!match)throw new Error('Unknown fixture case');
    const who=actor(scale===S.pro?'counselor':'visitor',scale===S.pro?match.counselor_id:match.visitor_id);
    const start={match_id:match.match_id,scale_code:scale,session_no:session,follow_round:round,client_event_id:`fixture-${name}-${label}`};
    const started=await flow.start(who,start);
    const input={match_id:match.match_id,event_id:started.event.event_id,request_id:`fixture-submit-${name}-${label}`,answers};
    const result={who,start,input,event:started.event,duration};prepared.set(`${name}/${label}`,result);return result;
  }
  async function card(name,label,scale,session,answers,options){
    const p=await prepare(name,label,scale,session,answers,options);clock+=p.duration;
    const result=await flow.submit(p.who,p.input);if(result.statusCode&&result.statusCode!==201&&result.statusCode!==200)throw new Error(`Invalid synthetic fixture ${name}/${label}`);
    events.set(`${name}/${label}`,result.event);return result.event;
  }
  async function configure(name,optional_enabled){const match=await repo.getMatch(cases.get(name).match_id);return provenance.setCaseConfig(match.match_id,{optional_enabled,focus_text:null,expected_revision:match.assessment_config_revision||0,changed_by:'fixture-admin'});}
  async function stable(name,n){await card(name,`s${n}-feel`,S.feel,n,feel([8,9,9,10]));await card(name,`s${n}-pro`,S.pro,n,pro([8,9,9,9,9,10]));}
  async function close(name,n){return repo.closeMatch(cases.get(name).match_id,n);}
  return {db,repo,consent,provenance,flow,combos,rollout,followups,cases,events,prepared,addCase,prepare,card,configure,stable,sign,close,
    actor,now,iso,advance:ms=>{clock+=ms;},at:value=>{const target=typeof value==='number'?value:Date.parse(value);if(!Number.isFinite(target)||target<clock)throw new Error('Synthetic clock must advance');clock=target;},
    read:(name,n)=>combos.read(cases.get(name).match_id,n),
    notifications:(result={kind:'rejected',code:'SYNTHETIC_REJECTED'})=>createNotificationWorker(db,{now,provider:{send:async()=>structuredClone(result)}}),
    llm:()=>createLlmWorker(db,{now,provider:{ready:true,model:'synthetic-t20-no-network',generate:async payload=>JSON.stringify({summary:'合成样例的本节问卷已完成，可核对各项自评。',dim_scores:Object.fromEntries(Object.entries(payload.available_dimensions).map(([k,v])=>[k,v?60:null])),suggest_actions:['可以讨论本次填写感受'],tag_weight_adjust:[]})}})
  };
}
async function buildMainDemo(){
  const f=await createHarness();await f.addCase('main',{visitor:'fixture-visitor-a',counselor:'fixture-counselor-a'});
  await f.card('main','m0',S.baseline,0,baseline([8,7,7,8,7,8,7]),{duration:65000});
  f.at('2026-01-03T01:00:00.000Z');await f.card('main','s1-feel',S.feel,1,feel([8,8,8,9]),{duration:38000});
  await f.card('main','s1-pro',S.pro,1,pro([7,8,8,7,8]),{duration:42000});
  const sessions=[
    [2,'2026-01-08',[7,6,6,7,6,7,6],[6,7,6,7],[7,7,8,6,7,5]],
    [3,'2026-01-15',[6,5,5,6,5,6,5],[8,8,9,8],[8,8,8,7,8,5]],
    [4,'2026-01-22',[5,5,4,6,5,5,4],[5,6,6,5],[3,4,5,4,4,5]],
    [5,'2026-01-29',null,[5,5,6,5],[10,9,9,8,9,5]]
  ];
  for(const [n,date,state,fv,pv]of sessions){f.at(`${date}T01:00:00.000Z`);if(state)await f.card('main',`s${n}-state`,S.state,n,core(state),{duration:39000});
    await f.card('main',`s${n}-feel`,S.feel,n,feel(fv),{duration:37000});await f.card('main',`s${n}-pro`,S.pro,n,pro(pv),{duration:43000});}
  f.at('2026-01-31T01:00:00.000Z');await f.card('main','end',S.end,5,numbered('e',[8,7,8,8,8,7]),{duration:50000});
  await f.card('main','evaluation',S.evaluation,5,{...numbered('v',[8,9,10]),o1:'合成评价：希望多讨论具体练习。'},{duration:25000});
  const closed=await f.close('main',5);
  f.at(closed.followup_due['1m']);await f.followups.dispatchDue();const job=[...f.db.snapshot()[C.followupJobs].values()].find(j=>j.follow_round==='1m');
  await f.notifications().processTask(job.job_id);
  await f.card('main','follow-1m',S.follow,5,numbered('u',[8,7,8,8,8,7]),{round:'1m',duration:48000});
  await f.addCase('new-cycle',{visitor:'fixture-visitor-a',counselor:'fixture-counselor-b',previous:closed.match_id});
  await f.card('new-cycle','m0',S.baseline,0,baseline([6,6,5,7,5,6,7]));
  await f.card('new-cycle','s1-feel',S.feel,1,feel([7,8,9,8]));await f.card('new-cycle','s1-pro',S.pro,1,pro([7,8,8,7,8]));
  f.at(closed.followup_due['3m']);await f.card('main','follow-3m',S.follow,5,numbered('u',[7,8,8,9,8,8]),{round:'3m',duration:48000});
  await f.llm().processTask(f.events.get('main/s3-state').event_id);
  return f;
}
async function summarizeDemo(f){
  const cases=[];for(const [name,original]of f.cases){const match=await f.repo.getMatch(original.match_id);const profiles=await f.repo.getProfiles(match.match_id);
    const sessions=[];for(const n of [0,1,2,3,4,5]){const result=await f.read(name,n);if(result)sessions.push({session_no:n,raw_signals:result.raw.signals.map(s=>({rule_id:s.rule_id,level:s.level,event_id:s.event_id})),original_level:result.combined.original_level,display_level:result.combined.display_level,reason:result.combined.reason});}
    cases.push({name,match_id:match.match_id,status:match.status,previous_match_id:match.previous_match_id,followup_due:match.followup_due||null,profiles:comparisonView(profiles),sessions});}
  return {schema_version:'synthetic-t20-v1',synthetic:true,storage:'process_local_memory',importable:false,external_calls:0,as_of:f.iso(),cases,
    events:[...f.events.entries()].map(([label,e])=>({label,event_id:e.event_id,match_id:e.match_id,scale_code:e.scale_code,session_no:e.session_no,follow_round:e.follow_round,
      started_at:e.started_at,submitted_at:e.submitted_at,duration_ms:e.duration_ms,quality_flag:e.quality_flag,scores:e.scores,answers:e.raw_answers})),
    notifications:[...f.db.snapshot()[C.notificationTasks].values()].map(t=>({task_id:t.task_id,kind:t.kind,status:t.status,delivery_result:t.delivery_result||null,primary_failed:t.primary_failed||false})),
    llm:[...f.db.snapshot()[C.llmResults].values()].map(r=>({event_id:r.event_id,model:r.model,summary:r.summary,dim_scores:r.dim_scores})),
    collection_counts:Object.fromEntries(Object.entries(f.db.snapshot()).map(([name,rows])=>[name,rows.size]))};
}
module.exports={createHarness,buildMainDemo,summarizeDemo,core,baseline,feel,pro,numbered,C,S};
