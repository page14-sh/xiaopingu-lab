// Synthetic-only rehearsal before importing any real record into the dedicated v2 target.
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),{randomUUID}=require('node:crypto');
const {open,read}=require('./snapshot.cjs'),config=require('../../specs/v2-cutover/runtime.json');
const base='../../cloudrun/xiaopingu-api/';
const {namespaceDatabase,LEGACY_TABLES}=require(base+'runtime-policy'),{COLLECTIONS:C}=require(base+'assessment/model');
const {createCloudBaseStore,createRequestHandler,signSession}=require(base+'app'),{generate}=require(base+'portal/credentials');
async function run(){
 assert.ok(process.argv.includes('--run-isolated'));const gate=await fetch(config.api_url+'/rest/v1/assessments',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(gate.status,503,'Remote migration write gate must be closed');
 const raw=namespaceDatabase(await open(),config.prefix),names=[...Object.values(C),...LEGACY_TABLES],owned=new Map();for(const n of names)assert.equal((await read(raw,n)).length,0,'Target must be empty before synthetic rehearsal');
 const wrap=database=>({command:raw.command,collection(name){const collection=database.collection(name);return new Proxy(collection,{get(obj,key){if(key==='doc')return id=>{const doc=obj.doc(id);return new Proxy(doc,{get(d,k){if(k==='set')return data=>{owned.set(name+'/'+id,{name,id});return d.set(data);};return typeof d[k]==='function'?d[k].bind(d):d[k];}});};return typeof obj[key]==='function'?obj[key].bind(obj):obj[key];}});},async startTransaction(){const tx=await database.startTransaction(),w=wrap(tx);return {...w,commit:()=>tx.commit(),rollback:()=>tx.rollback()};}});
 const db=wrap(raw),store=createCloudBaseStore(db),secret='synthetic-rehearsal-only-'+randomUUID();let server;const checks=[];const report={env:config.env,prefix:config.prefix,synthetic:true,checks,cleanup_complete:false};
 try{
  const {compatibilityVersionBundle}=require(base+'assessment/provenance');await store.provenance.publishVersions({...compatibilityVersionBundle(),published_by:'synthetic-rehearsal',expected_revision:0});for(const p of require('../../specs/v2-cutover/consent-policies.json').policies)await store.consent.publishPolicy({...p,published_by:'synthetic-rehearsal',expected_revision:0});
  server=http.createServer(createRequestHandler({store,sessionSecret:secret,portalEnabled:true,adminPassword:'synthetic-admin-only'}));await new Promise(r=>server.listen(0,'127.0.0.1',r));const baseUrl='http://127.0.0.1:'+server.address().port;
  async function req(path,body,token,method){const r=await fetch(baseUrl+path,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};}
  const asid=randomUUID(),credential=generate();let r=await req('/rest/v1/assessments',{id:asid,visitor_name:'synthetic-rehearsal',crisis_level:'safe',client_claim_secret:credential});assert.equal(r.status,201);assert.equal(r.body[0].client_claim_secret,undefined);checks.push('native_intake_owner_and_secret_hash');
  assert.equal((await req('/rest/v1/assessments',{id:asid,client_claim_secret:credential})).status,201);assert.equal((await req('/rest/v1/assessments',{id:asid,client_claim_secret:generate()})).status,409);checks.push('intake_retry_bound_to_private_claim');
  assert.equal((await req('/auth/visitor-receipt',{credential:asid})).status,401);const history=await req('/auth/history',{credential:asid});assert.equal(history.status,200);assert.equal((await req('/v1/xg/me',null,history.body.token)).status,401);checks.push('history_token_cannot_enter_native_routes');
  const visitor=await req('/auth/visitor-receipt',{credential});assert.equal(visitor.status,200);const token=visitor.body.token,cid=randomUUID();await store.portal.createCounselor({id:cid,name:'synthetic-counselor',is_active:true,review_status:'approved',edit_token:'synthetic-'+randomUUID()});
  assert.equal((await req('/rest/v1/assessments?id=eq.'+asid,{match_request_cid:cid},null,'PATCH')).status,401);
  const pending=await req('/rest/v1/assessments?id=eq.'+asid,{match_request_cid:cid},token,'PATCH');assert.equal(pending.status,200);
  const counselor=signSession({role:'counselor',subject:cid,auth_method:'counselor-edit',aud:'xg-assessment',demo:false,exp:Date.now()+600000},secret);
  const approved=await req('/rest/v1/assessments?id=eq.'+asid,{match_request_status:'approved'},counselor,'PATCH');assert.equal(approved.status,200);const match_id=approved.body[0].match_id;assert.ok(match_id);checks.push('authorized_legacy_approval_creates_native_cycle');
  const status=(await req('/v1/xg/me/consent?scope=assessment',null,token)).body;assert.equal((await req('/v1/xg/me/consent',{scope:'assessment',version:status.required_version,document_hash:status.required_document.content_hash,agreed:true,channel:'web',client_event_id:randomUUID(),expected_revision:0},token)).status,201);
  const startBody={match_id,scale_code:'xg_m0_baseline',session_no:0,client_event_id:randomUUID(),request_id:randomUUID()};const started=await req('/v1/xg/events/start',startBody,token);assert.equal(started.status,201);assert.ok(started.body.form.items.length);
  const answers=Object.fromEntries(started.body.form.items.filter(i=>i.applicable).map(i=>[i.code,i.item_type==='text'?'synthetic response':i.item_type==='single_choice'?i.options[0].value:7]));const submitted=await req('/v1/xg/events',{...startBody,event_id:started.body.event_id,answers,duration_ms:10000,request_id:randomUUID()},token);assert.equal(submitted.status,201);assert.equal(submitted.body.saved,true);assert.equal(submitted.body.total,undefined);checks.push('real_database_frozen_form_consent_and_submission');
  const own=await req('/v1/xg/events?match_id='+match_id,null,token);assert.equal(own.status,200);assert.ok(!JSON.stringify(own.body).includes('scores'));const other=signSession({role:'counselor',subject:randomUUID(),auth_method:'counselor-edit',aud:'xg-assessment',demo:false,exp:Date.now()+60000},secret);assert.equal((await req('/v1/xg/events?match_id='+match_id,null,other)).status,403);checks.push('visitor_score_redaction_and_cross_counselor_denial');
  report.passed=true;
 }finally{
  if(server)await new Promise(r=>server.close(r));for(const {name,id}of [...owned.values()].reverse()){const r=await raw.collection(name).doc(id).remove();assert.ok(!r.code,'Synthetic cleanup failed');}
  for(const n of names)assert.equal((await read(raw,n)).length,0,'Unexpected target data after cleanup');report.cleanup_complete=true;report.synthetic_documents_removed=owned.size;report.finished_at=new Date().toISOString();fs.writeFileSync('outputs/migration/real-rehearsal.json',JSON.stringify(report,null,2));
 }
 console.log(JSON.stringify(report));
}
run().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
