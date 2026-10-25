// Opt-in: this script only writes the isolated preview namespace, never legacy data.
// Runtime credentials are read from an ignored mode-0600 file and are never logged.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),base=path.join(root,'cloudrun/xiaopingu-api');
const {namespaceDatabase,runtimePolicy}=require(path.join(base,'runtime-policy'));
const {createCloudBaseAssessmentStore}=require(path.join(base,'assessment/cloudbase-store'));
const {createProvenanceRepository,compatibilityVersionBundle}=require(path.join(base,'assessment/provenance'));
const {createConsentRepository}=require(path.join(base,'assessment/consent'));
const {createRolloutRepository}=require(path.join(base,'assessment/rollout'));
const {COLLECTIONS:C,SCALES:S,RISK_SCALE:R}=require(path.join(base,'assessment/model'));
const {signSession}=require(path.join(base,'app'));
const {createIdentityHandler}=require(path.join(root,'cloudfunctions/xg-identity/handler'));
const endpoint='https://xiaopingu-assessment-preview-308810-6-1300577165.sh.run.tcloudbase.com';
async function main(){
 assert.ok(['--bootstrap','--smoke'].includes(process.argv[2]));
 const file=path.join(root,'.env.preview-runtime.json');assert.equal(fs.statSync(file).mode&0o777,0o600);
 const config=JSON.parse(fs.readFileSync(file,'utf8')),policy=runtimePolicy(config);
 assert.equal(policy.preview,true);assert.equal(config.TCB_ENV,'xpg-demo-d3gzsswtcc3233ea0');
 assert.equal(policy.notificationsEnabled,false);assert.equal(policy.llmEnabled,false);
 const deployment=JSON.parse(fs.readFileSync(path.join(root,'outputs/preview/deployment.json')));
 assert.equal(deployment.service,'xiaopingu-assessment-preview');assert.equal(deployment.prefix,policy.prefix);
 const sdk=require(path.join(base,'node_modules/@cloudbase/node-sdk'));
 const mapped=namespaceDatabase(sdk.init({env:config.TCB_ENV,accessKey:config.CLOUDBASE_APIKEY}).database(),policy.prefix);
 const store=createCloudBaseAssessmentStore(mapped),provenance=createProvenanceRepository(store),consent=createConsentRepository(store),rollout=createRolloutRepository(store);
 const actor=(role,subject)=>({role,subject,aud:'xg-assessment',demo:false,auth_method:role==='admin'?'admin-password':'counselor-edit',exp:Date.now()+3600000});
 const adminActor=actor('admin','preview-smoke'),admin=signSession(adminActor,config.XPG_SESSION_SECRET);
 const report={scope:'synthetic CloudRun HTTP + isolated real CloudBase database',endpoint,prefix:policy.prefix,started_at:new Date().toISOString(),tests:[],native_wechat_verified:false,external_notifications:false,llm:false};
 const output=path.join(root,'outputs/preview',process.argv[2].slice(2)+'.json');
 const persist=()=>fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
 async function check(name,work){console.log('RUN '+name);await work();report.tests.push({name,passed:true});persist();console.log('PASS '+name);}
 async function request(url,token=admin,body,status=200){const res=await fetch(endpoint+url,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(45000)});let data;try{data=await res.json();}catch{throw new Error(`NON_JSON_${res.status}`);}assert.equal(res.status,status,`${url}: ${data.error?.code||res.status}`);return data;}
 try{
  if(process.argv[2]==='--bootstrap'){
   await check('publish isolated compatibility definitions and test-only consent',async()=>{
    await provenance.publishVersions({...compatibilityVersionBundle(),expected_revision:0,published_by:'preview-bootstrap'});
    for(const scope of ['assessment','followup'])await consent.publishPolicy({scope,version:'preview-synthetic-v1',title:'仅供合成账号联调',content:'此为隔离预览的合成测试文案，不用于真实来访者知情同意。',published_by:'preview-bootstrap',expected_revision:0});
   });
   await check('initialize closed collection and reminder switches',async()=>{await rollout.update(adminActor,{expected_revision:0,patch:{collection_paused:true,enable_reminder:false,enable_cst:false,emergency_stop:true},reason:'Isolated preview bootstrap: no real users'});});
   const result=await mapped.collection('counselors').doc('preview-synthetic-counselor').set({id:'preview-synthetic-counselor',is_active:true,review_status:'approved',is_demo:false,synthetic:true});assert.ok(!result.code);
  }else{
   let token,matchId,baselineEvent;
   const counselor=signSession(actor('counselor','preview-synthetic-counselor'),config.XPG_SESSION_SECRET);
   await check('cloud health, disabled model and private APIs reject anonymous callers',async()=>{
    await request('/health','');await request('/v1/xg/bridge/enter','',{asid:'synthetic'},401);
    assert.equal((await request('/v1/xg/jobs/llm-run',config.XPG_SCHEDULER_SECRET,{limit:1})).configured,false);
   });
   const before=await rollout.get();await rollout.update(adminActor,{expected_revision:before.revision,patch:{collection_paused:false},reason:'Temporary synthetic-only HTTP smoke'});
   try{
    await check('synthetic signed identity, admission, consent and approved new cycle',async()=>{
     const syntheticOpenid=`preview-synthetic-${Date.now()}`;
     const bridge=createIdentityHandler({getWXContext:()=>({SOURCE:'wx_client',APPID:config.XPG_MINIPROGRAM_APPID,OPENID:syntheticOpenid}),parseContext:()=>({environment:{WX_OPENID:syntheticOpenid,WX_APPID:config.XPG_MINIPROGRAM_APPID}}),secret:config.XPG_IDENTITY_BRIDGE_SECRET,appId:config.XPG_MINIPROGRAM_APPID,audience:config.XPG_IDENTITY_AUDIENCE});
     const identity=await bridge({},{});token=(await request('/auth/visitor','',{assertion:identity.assertion})).token;
     await request('/auth/visitor','',{assertion:identity.assertion},401);
     const red=await request('/v1/xg/intakes',token,{answers:{synthetic:true,crisis_screen:'action'}},201);
     assert.equal((await request('/v1/xg/bridge/enter',token,{asid:red.assessment_id})).out_of_scope,true);
     await request('/v1/xg/match-requests',token,{assessment_id:red.assessment_id,counselor_id:'preview-synthetic-counselor'},409);
     const intake=await request('/v1/xg/intakes',token,{answers:{synthetic:true,crisis_screen:'safe'}},201);
     assert.equal((await request('/v1/xg/bridge/enter',token,{asid:intake.assessment_id})).consent_required,true);
     const state=await request('/v1/xg/me/consent',token);
     await request('/v1/xg/me/consent',token,{scope:'assessment',version:state.required_version,document_hash:state.required_document.content_hash,agreed:true,channel:'web',client_event_id:'preview-consent',expected_revision:state.revision},201);
     const pending=await request('/v1/xg/match-requests',token,{assessment_id:intake.assessment_id,counselor_id:'preview-synthetic-counselor'},201);
     await request(`/v1/xg/match-requests/${pending.request_id}/approve`,counselor,{});
     matchId=(await request('/v1/xg/matches',counselor,{request_id:pending.request_id})).match_id;
    });
    const start=(label,scale,session,status=201)=>request('/v1/xg/events/start',token,{match_id:matchId,scale_code:scale,session_no:session,client_event_id:label},status);
    const submit=(label,event,answers,status=201)=>request('/v1/xg/events',token,{match_id:matchId,event_id:event.event_id,request_id:label,answers},status);
    async function age(event,ms){const saved=await store.get(C.events,event.event_id),remaining=Date.parse(saved.started_at)+ms-Date.now();if(remaining>0){console.log(`WAIT ${Math.ceil(remaining/1000)}s for real server duration`);let rest=remaining;while(rest>0){const step=Math.min(rest,30000);await new Promise(r=>setTimeout(r,step));rest-=step;}}}
    await check('frozen baseline and low outcome create a due risk card',async()=>{
     await start('risk-before-trigger',R,2,409);
     baselineEvent=await start('baseline',S.baseline,0);await age(baselineEvent,66000);
     await submit('baseline-submit',baselineEvent,{s1:7,s2:7,s3:7,s4:7,s5:7,s6:7,s7:7,b1:7,b2:6,b3:7,r1:8,r2:7,d1:0});
     const state=await start('state2',S.state,2);await age(state,36000);
     await submit('state2-submit',state,{s1:2,s2:3,s3:3,s4:3,s5:3,s6:3,s7:3});
     const prompts=await request(`/v1/xg/prompts/next?match_id=${matchId}&session_no=2`,token);assert.ok(prompts.prompts.some(p=>p.scale_code===R));
     assert.equal((await request(`/v1/xg/admin/event-score-replay?match_id=${matchId}&event_id=${baselineEvent.event_id}`)).matches,true);
    });
    await check('risk 5, two-session cooldown, risk 10 and durable stop through cloud HTTP',async()=>{
     const r2=await start('risk2',R,2);await age(r2,5500);await submit('risk2-submit',r2,{k1:5});
     await start('risk3',R,3,409);const unfinished=await start('unfinished',S.feel,4);
     const r4=await start('risk4',R,4);await age(r4,5500);const result=await submit('risk4-submit',r4,{k1:10});assert.equal(result.out_of_scope,true);assert.doesNotMatch(JSON.stringify(result),/"scores"|"total"|"k1"/);
     await submit('unfinished-submit',unfinished,{f1:6,f2:7,f3:8,f4:9},409);await start('after-stop',S.feel,5,409);
     assert.equal((await request(`/v1/xg/prompts/next?match_id=${matchId}&session_no=5`,token)).out_of_scope,true);
     const inbox=await request(`/v1/xg/counselor/inbox?match_id=${matchId}&alert_type=risk`,counselor);assert.equal(inbox.items.length,2);assert.ok(inbox.items.every(i=>i.is_safety));
     assert.equal(await store.get(C.llmJobs,r4.event_id),null);
    });
   }finally{
    const state=await rollout.get();await rollout.update(adminActor,{expected_revision:state.revision,patch:{collection_paused:true,enable_reminder:false,enable_cst:false,emergency_stop:true},reason:'Synthetic smoke finished; return preview to closed state'});
    report.final_rollout=await rollout.get();persist();
   }
  }
  report.passed=true;
 }catch(e){report.passed=false;report.error={code:String(e.code||e.name).replace(/[^A-Za-z0-9_.-]/g,''),message:e.code==='ERR_ASSERTION'?String(e.message).slice(0,500):'See sanitized operation failure'};process.exitCode=1;console.error(JSON.stringify(report.error));}
 finally{report.finished_at=new Date().toISOString();persist();console.log('REPORT '+output);}
}
main().catch(e=>{console.error(String(e.code||e.name));process.exitCode=1;});
