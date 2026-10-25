const test=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');
const {createHarness,baseline,core,S,C}=require('../../../scripts/fixtures/assessment-demo.cjs');
const {compatibilityVersionBundle}=require('./provenance');const {RISK_SCALE:R,documentKey}=require('./model');
const {createIdentityRepository}=require('./identity-repository');const {createAdmissionBridge}=require('./admission');
const {createNotificationService}=require('./notification-service');const {createRequestHandler,signSession}=require('../app');
const {runtimePolicy,namespaceDatabase}=require('../runtime-policy');const {replayEventScores}=require('./score-replay');
async function fixture(){const f=await createHarness();await f.addCase('compat');await f.provenance.publishVersions({...compatibilityVersionBundle(),expected_revision:1,published_by:'fixture-admin'});return f;}
const visitor=f=>f.actor('visitor',f.cases.get('compat').visitor_id);const admin=f=>f.actor('admin','fixture-admin');
async function trigger(f){await f.card('compat','m0',S.baseline,0,baseline(7));await f.card('compat','low',S.state,2,core([2,3,3,3,3,3,3]));}

test('compat risk profile is versioned separately and historical seven-card scoring remains valid',async()=>{
 const f=await createHarness();await f.addCase('compat');const old=await f.card('compat','old',S.baseline,0,baseline(7));
 await f.provenance.publishVersions({...compatibilityVersionBundle(),expected_revision:1,published_by:'fixture-admin'});
 assert.equal(replayEventScores(old).matches,true);assert.equal(old.basis.item_version,'t20-items-v1');
 const e=await f.card('compat','low',S.state,2,core([2,3,3,3,3,3,3]));assert.equal(e.scores.total,20);assert.equal(e.basis.item_version,'items-compat-v1');
 const risk=await f.card('compat','risk',R,2,{k1:5});assert.equal(risk.scores.total,5);assert.equal(risk.scores.pct,null);assert.equal(replayEventScores(risk).matches,true);assert.equal(await f.db.get(C.llmJobs,risk.event_id),null);
});

test('risk card requires an open outcome L3 and respects two-session cooldown',async()=>{
 const f=await fixture();await assert.rejects(f.prepare('compat','premature',R,2,{k1:0}),{code:'XG_RISK_NOT_DUE'});await trigger(f);
 const prompts=await f.followups.prompts(visitor(f),f.cases.get('compat').match_id,{session_no:2});assert.ok(prompts.some(p=>p.scale_code===R));
 await f.card('compat','risk',R,2,{k1:0});await assert.rejects(f.prepare('compat','early',R,3,{k1:0}),{code:'XG_RISK_NOT_DUE'});
 const next=await f.card('compat','risk4',R,4,{k1:0});assert.equal(next.status,'submitted');
});

for(const value of [0,5,10])test(`risk response ${value} retains expected signal and scope outcome`,async()=>{
 const f=await fixture();await trigger(f);await f.card('compat','risk',R,2,{k1:value});
 const result=await f.read('compat',2),signal=result.raw.signals.find(s=>s.rule_id==='RISK-RECHECK');
 if(value===0)assert.equal(signal,undefined);else assert.equal(signal.level,value===10?'L3':'L2');
 assert.equal((await f.repo.riskStatus(f.cases.get('compat').match_id)).out_of_scope,value===10);
});

test('risk invalid option rejects durably and correction reuses the same attempt',async()=>{
 const f=await fixture();await trigger(f);const p=await f.prepare('compat','invalid',R,2,{k1:4});f.advance(6000);
 const bad=await f.flow.submit(p.who,p.input);assert.equal(bad.statusCode,422);assert.equal(bad.error.field,'k1');
 const good=await f.flow.submit(p.who,{...p.input,request_id:'correct-risk',answers:{k1:5}});assert.equal(good.event.event_id,p.event.event_id);assert.equal(good.event.status,'submitted');
});

test('urgent risk stops both future forms and previously started ordinary forms; safety remains visible',async()=>{
 const f=await fixture();await trigger(f);const pending=await f.prepare('compat','pending',S.feel,2,{f1:6,f2:7,f3:8,f4:9});const risk=await f.card('compat','risk',R,2,{k1:10});
 await assert.rejects(f.flow.submit(pending.who,pending.input),{code:'XG_OUT_OF_SCOPE'});await assert.rejects(f.prepare('compat','new',S.feel,3,{f1:6,f2:7,f3:8,f4:9}),{code:'XG_OUT_OF_SCOPE'});
 assert.deepEqual(await f.followups.prompts(visitor(f),risk.match_id,{session_no:3}),[]);
 await f.rollout.update(admin(f),{expected_revision:0,reason:'Test emergency',patch:{emergency_stop:true}});
 const inbox=await f.repo.reminderInbox(f.actor('counselor',risk.counselor_id),risk.match_id,{alert_type:'risk'});assert.equal(inbox.items.length,1);assert.equal(inbox.items[0].is_safety,true);
 const p=f.prepared.get('compat/risk');assert.equal((await f.flow.submit(p.who,p.input)).replayed,true);
});

test('closing the only outcome L3 removes eligibility without losing evidence',async()=>{
 const f=await fixture();await trigger(f);const match=f.cases.get('compat'),id=documentKey(match.match_id,2,'OUT-LOW');await f.rollout.update(admin(f),{expected_revision:0,reason:'Test CST',patch:{enable_reminder:true,enable_cst:true}});
 const service=createNotificationService(f.db,{now:f.now,validateCounselor:async()=>true});let revision=0;
 for(const step of [1,2,3]){const r=await service.act(f.actor('counselor',match.counselor_id),id,'cst',{match_id:match.match_id,expected_revision:revision,note:'合成核对',cst_step:step,close:step===3});revision=r.revision;}
 await assert.rejects(f.prepare('compat','after-close',R,2,{k1:0}),{code:'XG_RISK_NOT_DUE'});assert.ok((await f.read('compat',2)).raw.signals.some(s=>s.rule_id==='OUT-LOW'));
});

test('risk state persistence failure rolls back submission and does not stop the cycle',async()=>{
 const f=await fixture();await trigger(f);const p=await f.prepare('compat','failure',R,2,{k1:10});f.advance(6000);const before=f.db.snapshot();f.db.failNextWriteTo(C.riskStates);
 await assert.rejects(f.flow.submit(p.who,p.input),/Injected/);assert.deepEqual(f.db.snapshot(),before);assert.equal((await f.repo.riskStatus(p.event.match_id)).out_of_scope,false);
});

for(const level of ['safe','passive','active','action'])test(`admission retains old ${level} behavior with verified ownership`,async()=>{
 const f=await fixture(),identity=createIdentityRepository(f.db),who=visitor(f),bridge=createAdmissionBridge(f.db,f.consent),intake=await identity.createIntake(who,{answers:{crisis_screen:level}});
 const result=await bridge.enter(who,{asid:intake.assessment_id}),blocked=['active','action'].includes(level);assert.equal(result.out_of_scope,blocked);assert.equal('visitor_token'in result,false);
 if(blocked)await assert.rejects(identity.requestMatch(who,{assessment_id:intake.assessment_id,counselor_id:'new-c'}),{code:'XG_OUT_OF_SCOPE'});
 else assert.equal((await identity.requestMatch(who,{assessment_id:intake.assessment_id,counselor_id:'new-c'})).status,'pending');
});

test('legacy ASID alone cannot claim a real record or another visitor intake',async()=>{
 const f=await fixture(),identity=createIdentityRepository(f.db),bridge=createAdmissionBridge(f.db,f.consent),who=visitor(f);
 await f.db.transaction(tx=>tx.put('assessments','legacy-real',{id:'legacy-real',view_token:'legacy-real',crisis_level:'safe'}));const before=f.db.snapshot();
 await assert.rejects(bridge.enter(who,{asid:'legacy-real'}),{code:'XG_FORBIDDEN'});assert.deepEqual(f.db.snapshot(),before);
 const intake=await identity.createIntake(who,{answers:{crisis_screen:'safe'}});await assert.rejects(bridge.enter(f.actor('visitor','other'),{asid:intake.assessment_id}),{code:'XG_FORBIDDEN'});
 await assert.rejects(identity.createIntake(who,{answers:{crisis_screen:'unknown'}}),{code:'XG_BAD_PARAM'});
});

test('preview namespace maps all database and transaction access away from original collections',async()=>{
 const calls=[],raw={command:{},collection:n=>{calls.push(n);return n;},startTransaction:async()=>({collection:n=>{calls.push(n);return n;},commit:async()=>{},rollback:async()=>{}})};
 const mapped=namespaceDatabase(raw,'xg_preview_test01_');mapped.collection(C.events);mapped.collection('assessments');(await mapped.startTransaction()).collection('counselors');
 assert.deepEqual(calls,['xg_preview_test01_assessment_events','xg_preview_test01_assessments','xg_preview_test01_counselors']);assert.throws(()=>mapped.collection('foreign-real-data'));
 for(const prefix of ['xg_','../','xg_preview_'])assert.throws(()=>namespaceDatabase(raw,prefix));
});

test('preview forcibly disables external notification and LLM even with accidental enable flags',()=>{
 const policy=runtimePolicy({XPG_PREVIEW_MODE:'1',XPG_COLLECTION_PREFIX:'xg_preview_test01_',XPG_EXTERNAL_NOTIFICATIONS_ENABLED:'1',XPG_LLM_ENABLED:'1'});
 assert.equal(policy.notificationsEnabled,false);assert.equal(policy.llmEnabled,false);
 assert.throws(()=>runtimePolicy({XPG_PREVIEW_MODE:'1'}));assert.throws(()=>runtimePolicy({XPG_COLLECTION_PREFIX:'xg_preview_test01_'}));
 assert.equal(runtimePolicy({}).notificationsEnabled,false);assert.equal(runtimePolicy({}).llmEnabled,false);
});

test('compat HTTP bridge requires login and risk response exposes no numeric result',async(t)=>{
 const f=await fixture();await trigger(f);const secret='compat-test-session',identity=createIdentityRepository(f.db),store={assessment:f.repo,identity,consent:f.consent,lifecycle:f.flow,followups:f.followups,admission:createAdmissionBridge(f.db,f.consent),async list(){return [];}};
 const server=http.createServer(createRequestHandler({store,sessionSecret:secret}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const request=async(path,body,token=signSession(visitor(f),secret))=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/v1/xg${path}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
 assert.equal((await request('/bridge/enter',{asid:'anything'},'')).status,401);
 const intake=await identity.createIntake(visitor(f),{answers:{crisis_screen:'action'}});assert.equal((await request('/bridge/enter',{asid:intake.assessment_id})).body.out_of_scope,true);
 const p=await f.prepare('compat','http-risk',R,2,{k1:10});f.advance(6000);const result=await request('/events',p.input);assert.equal(result.status,201);assert.equal(result.body.out_of_scope,true);assert.doesNotMatch(JSON.stringify(result.body),/"total"|"scores"|"k1"/);
 const prompts=await request(`/prompts/next?match_id=${p.event.match_id}&session_no=3`);assert.equal(prompts.body.out_of_scope,true);
});
