const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const base=path.resolve(__dirname,'../../cloudrun/xiaopingu-api');
const {memoryAssessmentStore}=require(base+'/assessment/test-support');
const {COLLECTIONS:C}=require(base+'/assessment/model');
const {createRequestHandler}=require(base+'/app');
async function fixture(){
 const source=memoryAssessmentStore({withVersions:false});
 const match=(row,f)=>Object.entries(f).every(([k,v])=>v&&typeof v==='object'?'$gt'in v?row[k]>v.$gt:'$in'in v?v.$in.includes(row[k]):false:row[k]===v);
 const db={command:{gt:v=>({$gt:v}),in:v=>({$in:v})},collection:name=>{let filter={},limit=100;const q={where(f){filter=f;return q;},orderBy(){return q;},limit(n){limit=n;return q;},async get(){return {data:[...(source.snapshot()[name]||new Map()).values()].filter(r=>match(r,filter)).sort((a,b)=>a._id.localeCompare(b._id)).slice(0,limit)};},async update(patch){const rows=(await q.get()).data;await source.transaction(async tx=>{for(const r of rows)await tx.put(name,r._id,{...r,...patch});});return {updated:rows.length};}};return q;}};
 const consent=require(base+'/assessment/consent').createConsentRepository(source),assessment=require(base+'/assessment/repository').createAssessmentRepository(source),identity=require(base+'/assessment/identity-repository').createIdentityRepository(source),provenance=require(base+'/assessment/provenance').createProvenanceRepository(source);
 const store={consent,assessment,identity,provenance,lifecycle:require(base+'/assessment/event-lifecycle').createEventLifecycle(source,consent),followups:require(base+'/assessment/followups').createFollowupRepository(source),notifications:require(base+'/assessment/notification-service').createNotificationService(source),async list(name){return [...(source.snapshot()[name]||new Map()).values()];},findById:(name,id)=>source.get(name,id)};
 store.portal=require(base+'/portal/repository').createPortalRepository(db,source,store);
 await provenance.publishVersions({...require(base+'/assessment/provenance').compatibilityVersionBundle(),published_by:'synthetic-fixture',expected_revision:0});
 const credential='xpg2_'+Buffer.alloc(32,7).toString('base64url'),asid='11111111-1111-4111-8111-111111111111',cid='22222222-2222-4222-8222-222222222222';
 await store.portal.createCounselor({id:cid,name:'合成咨询师',edit_token:'synthetic-counselor-only',review_status:'approved',is_active:true});
 const row=await store.portal.createIntake({id:asid,view_token:asid,client_claim_secret:credential,visitor_name:'合成来访者',crisis_level:'safe'});
 const visitor={role:'visitor',subject:row.visitor_user_id,auth_method:'intake-receipt',aud:'xg-assessment',demo:false,exp:Date.now()+86400000},counselor={role:'counselor',subject:cid,auth_method:'counselor-edit',aud:'xg-assessment',demo:false,exp:Date.now()+86400000};
 const requested=await store.portal.patchIntake(row,{match_request_cid:cid},{role:'visitor',principal:visitor});await store.portal.patchIntake(requested,{match_request_status:'approved'},{role:'counselor',principal:counselor});
 const policies=require('../../specs/v2-cutover/consent-policies.json');for(const policy of policies.policies)await consent.publishPolicy({...policy,published_by:'synthetic-fixture',expected_revision:0});
 await source.transaction(tx=>tx.put(C.legacyRecords,'synthetic-history',{archive_id:'synthetic-history',source_collection:'assessments',source_hash:'synthetic',assessment_id:asid,visitor_id:row.visitor_user_id,counselor_id:cid,link_status:'linked',link_reason:'synthetic',raw_json:JSON.stringify({id:asid,visitor_name:'合成来访者',total_score:12,created_at:'2026-01-01'})}));
 return {store,source,db,credential,asid,cid};
}
async function serve(){const f=await fixture(),root=path.resolve(__dirname,'../../legacy-web');const api=createRequestHandler({store:f.store,sessionSecret:'synthetic-session-secret-v2-only',adminPassword:'synthetic-admin-only',portalEnabled:true});const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://localhost');if(u.pathname.startsWith('/api/')){req.url=req.url.slice(4);return api(req,res);}
 const file=path.resolve(root,'.'+(u.pathname==='/'?'/portal.html':u.pathname));if(!file.startsWith(root+'/')||!fs.existsSync(file)){res.writeHead(404);return res.end();}let body=fs.readFileSync(file);if(file.endsWith('.html'))body=body.toString().replace('<header>','<header><p>合成测试 · 不连接真实数据库 · 无真实同意效力</p>');if(file.endsWith('supabase-config.js'))body=body.toString().replace(/url: '[^']+'/,'url: \'http://127.0.0.1:8795/api\'');res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});res.end(body);
 });server.listen(8795,'127.0.0.1',()=>console.log(JSON.stringify({synthetic:true,url:'http://127.0.0.1:8795/portal.html',credential:f.credential})));}
if(require.main===module)serve().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={fixture};
