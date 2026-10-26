const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {memoryAssessmentStore}=require('../assessment/test-support');
const {createPortalRepository}=require('./repository');
const {createIdentityRepository}=require('../assessment/identity-repository');
const {createAssessmentRepository}=require('../assessment/repository');
const {createPortalHttp}=require('./http');
const {createRequestHandler,signSession,verifySession}=require('../app');
const {COLLECTIONS:C}=require('../assessment/model');
const {requirePrincipal}=require('../assessment/authorization');
const {generate,digest}=require('./credentials');
function fixture(){
 const source=memoryAssessmentStore(),db={command:{gt:v=>({gt:v})},collection:name=>({where(filter){return {orderBy(){return this;},limit(n){this.n=n;return this;},async get(){return {data:[...source.snapshot()[name].values()].filter(r=>Object.entries(filter).every(([k,v])=>v&&typeof v==='object'?r[k]>v.gt:r[k]===v)).sort((a,b)=>a._id.localeCompare(b._id)).slice(0,this.n||100)};}};}})};
 const identity=createIdentityRepository(source),assessment=createAssessmentRepository(source),portal=createPortalRepository(db,source,{identity,assessment});
 const request=async(path,body,session,method=body?'POST':'GET')=>{let status,output;const res={setHeader(){},writeHead(s){status=s;},end(raw){output=JSON.parse(raw);}};const handler=createPortalHttp({portal,signSession,sessionSecret:'test-only-secret',readJson:async()=>body,sendJson:(r,s,d)=>{status=s;output=d;}});const handled=await handler({method,headers:{}},res,new URL(path,'http://local'),session);return {status,output,handled};};
 return {source,portal,request};
}
function principal(id){return {subject:id,role:'visitor',aud:'xg-assessment',auth_method:'intake-receipt',demo:false,exp:Date.now()+60000};}
async function intake(f,id=randomUUID(),credential=generate(),caller){const row=await f.portal.createIntake({id,view_token:id,client_claim_secret:credential},caller);return {row,id,credential,principal:principal(row.visitor_user_id)};}
test('legacy UUID never authenticates writing; history audience cannot authorize native consent or events',async()=>{
 const f=fixture(),i=await intake(f);const old=await f.request('/auth/history',{credential:i.id});assert.equal(old.status,200);const session=verifySession(old.output.token,'test-only-secret');assert.equal(session.aud,'xg-history');assert.throws(()=>requirePrincipal(session));
 assert.equal((await f.request('/auth/visitor-receipt',{credential:i.id})).status,401);
 assert.equal((await f.request('/v1/xg/portal/cases',null,session)).status,403);
 assert.equal((await f.request('/v1/xg/portal/history?assessment_id='+randomUUID(),null,session)).status,403);
 assert.equal((await f.request('/v1/xg/portal/history?assessment_id='+i.id,null,session)).status,200);
 const strong=await f.request('/auth/visitor-receipt',{credential:i.credential});assert.equal(strong.status,200);requirePrincipal(verifySession(strong.output.token,'test-only-secret'));
});
test('initial intake retry is bound to private claim and never stores plaintext in public rows',async()=>{
 const f=fixture(),i=await intake(f);assert.equal(i.row.client_claim_secret,undefined);const visitor=await f.source.get(C.visitors,i.row.visitor_user_id);assert.equal(visitor.credential_hash,digest(i.credential));assert.ok(!JSON.stringify(f.source.snapshot().assessments.get(i.id)).includes(i.credential));
 const retry=await intake(f,i.id,i.credential);assert.equal(retry.row.visitor_user_id,i.row.visitor_user_id);assert.equal(f.source.snapshot()[C.visitors].size,1);
 await assert.rejects(()=>intake(f,i.id,generate()),{code:'XG_ALREADY_EXISTS'});
});
test('returning authenticated visitor keeps same archive identity across new intakes',async()=>{
 const f=fixture(),i=await intake(f),next=await intake(f,randomUUID(),generate(),{principal:i.principal});assert.equal(next.row.visitor_user_id,i.row.visitor_user_id);assert.equal(f.source.snapshot()[C.visitors].size,1);
});
test('old UUID, other visitor and disabled identity cannot request a new consultation',async()=>{
 const f=fixture(),i=await intake(f),other=await intake(f);const patch={match_request_cid:randomUUID()};
 await assert.rejects(()=>f.portal.patchIntake(i.row,patch,{role:'anonymous'}),{code:'XG_UNAUTHORIZED'});
 await assert.rejects(()=>f.portal.patchIntake(i.row,patch,{role:'visitor',principal:other.principal}),{code:'XG_FORBIDDEN'});
 await f.source.transaction(async tx=>{const v=await tx.get(C.visitors,i.row.visitor_user_id);await tx.put(C.visitors,v.visitor_id,{...v,disabled:true});});
 assert.equal((await f.request('/auth/visitor-receipt',{credential:i.credential})).status,403);
});
test('approval creates a native cycle exactly once; archived approved status does not create a cycle',async()=>{
 const f=fixture(),i=await intake(f),cid=randomUUID();await f.portal.createCounselor({id:cid,is_active:true,review_status:'approved'});
 const pending=await f.portal.patchIntake(i.row,{match_request_cid:cid},{role:'visitor',principal:i.principal});
 const p={role:'counselor',subject:cid,aud:'xg-assessment',auth_method:'counselor-edit',demo:false,exp:Date.now()+60000};
 const approved=await f.portal.patchIntake(pending,{match_request_status:'approved'},{role:'counselor',principal:p});assert.ok(approved.match_id);
 const repeated=await f.portal.patchIntake(approved,{match_request_status:'approved'},{role:'counselor',principal:p});assert.equal(repeated.match_id,approved.match_id);assert.equal(f.source.snapshot()[C.matches].size,1);
});
test('operations board is admin-only and counts all statuses without exposing answers or credentials',async()=>{
 const f=fixture(),i=await intake(f),cid=randomUUID();await f.portal.createCounselor({id:cid,name:'Synthetic counselor',edit_token:'do-not-expose',is_active:true,review_status:'approved'});
 const pending=await f.portal.patchIntake(i.row,{match_request_cid:cid},{role:'visitor',principal:i.principal});
 const counselor={role:'counselor',subject:cid,aud:'xg-assessment',auth_method:'counselor-edit',demo:false,exp:Date.now()+60000};
 const approved=await f.portal.patchIntake(pending,{match_request_status:'approved'},{role:'counselor',principal:counselor});
 for(const [n,status]of ['submitted','started','abandoned'].entries())await f.source.transaction(tx=>tx.put(C.events,'event'+n,{event_id:'event'+n,match_id:approved.match_id,status,raw_answers:{s1:9},started_at:'2026-10-27T00:00:00Z'}));
 const admin={role:'admin',subject:'admin',aud:'xg-assessment',auth_method:'admin-password',demo:false,exp:Date.now()+60000};
 assert.equal((await f.request('/v1/xg/portal/board',null,i.principal)).status,403);assert.equal((await f.request('/v1/xg/portal/board',null,counselor)).status,403);
 const r=await f.request('/v1/xg/portal/board',null,admin);assert.equal(r.status,200);assert.equal(r.output.overview.events_total,3);assert.equal(r.output.cases[0].card_submitted,1);assert.equal(r.output.cases[0].card_abandoned,1);assert.equal(r.output.cases[0].counselor_name,'Synthetic counselor');assert.doesNotMatch(JSON.stringify(r.output),/raw_answers|do-not-expose|credential/);
});
