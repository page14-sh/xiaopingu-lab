// Only the dedicated v2 target is writable. Source records are never modified here.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {open,read,hash,ENV}=require('./snapshot.cjs');
const {BUSINESS_SOURCES}=require('./source');
const {transform}=require('./transform.cjs'),{provision}=require('./credentials.cjs');
const root=path.resolve(__dirname,'../..'),base=root+'/cloudrun/xiaopingu-api';
const {COLLECTIONS:C}=require(base+'/assessment/model'),{namespaceDatabase}=require(base+'/runtime-policy');
const {createCloudBaseAssessmentStore}=require(base+'/assessment/cloudbase-store');
const config=require(root+'/specs/v2-cutover/runtime.json');
const clean=record=>{const {_id,...data}=record;return data;};
async function run(){
 assert.equal(config.env,ENV);assert.match(config.prefix,/^xg_v2_[a-z0-9]{4,12}_$/);
 const db=await open(),target=namespaceDatabase(db,config.prefix),source=createCloudBaseAssessmentStore(target);
 const snapshotPath=fs.readFileSync(root+'/.private/migration/latest-snapshot-path','utf8'),snapshot=JSON.parse(fs.readFileSync(snapshotPath,'utf8'));
 const plan=provision(transform(snapshot),root+'/.private/migration/visitor-credentials.json');
 const write=process.argv.includes('--import-frozen');
 if(write){
  const fence=JSON.parse(fs.readFileSync(root+'/.private/migration/source-fence.json','utf8'));
  assert.equal(fence.env,ENV);assert.equal(fence.all_legacy_writers_paused,true);assert.ok(fence.checked_at&&Date.now()-Date.parse(fence.checked_at)<3600000,'Fresh verified write fence required');
  // A second read after pausing catches in-flight writes and stale discovery snapshots.
  for(const name of BUSINESS_SOURCES)assert.equal(hash(await read(db,name)),hash(snapshot.collections[name]),'SOURCE_CHANGED_'+name);
  const rollout=require(base+'/assessment/rollout').createRolloutRepository(source);const policy=await rollout.get();
  if(!policy.collection_paused)await rollout.update({role:'admin',subject:'migration-operator',aud:'xg-assessment',auth_method:'admin-password',demo:false,exp:Date.now()+3600000},{expected_revision:policy.revision,reason:'Migration import: target closed until verification',patch:{collection_paused:true,emergency_stop:true}});
 }
 const collections=[...new Set(plan.entries.map(e=>e.collection))],existing={};for(const c of collections)existing[c]=new Map((await read(target,c)).map(r=>[r._id,r]));
 let inserted=0;for(const e of plan.entries){const old=existing[e.collection].get(e.id);if(old){assert.equal(hash(clean(old)),hash(e.record),'TARGET_CONFLICT_'+e.collection);continue;}if(!write)continue;const r=await target.collection(e.collection).doc(e.id).set(e.record);assert.ok(!r.code&&(r.updated===1||r.upsertedId||r.upserted),'TARGET_WRITE_FAILED');inserted++;if(inserted%50===0)console.log(JSON.stringify({phase:'copy',inserted,total:plan.entries.length}));}
 const verified={};for(const c of collections){const actual=new Map((await read(target,c)).map(r=>[r._id,r]));let count=0;for(const e of plan.entries.filter(e=>e.collection===c)){const found=actual.get(e.id);if(found){assert.equal(hash(clean(found)),hash(e.record),'READBACK_MISMATCH_'+c);count++;}else assert.ok(!write,'MISSING_TARGET_RECORD');}verified[c]={expected:plan.entries.filter(e=>e.collection===c).length,verified:count};}
 if(write){
  const policies=require(root+'/specs/v2-cutover/consent-policies.json');assert.equal(policies.approved_by_user,true);const consent=require(base+'/assessment/consent').createConsentRepository(source);for(const policy of policies.policies)await consent.publishPolicy({...policy,published_by:'migration-operator',expected_revision:0});
  const {createProvenanceRepository,compatibilityVersionBundle}=require(base+'/assessment/provenance');await createProvenanceRepository(source).publishVersions({...compatibilityVersionBundle(),published_by:'migration-operator',expected_revision:0});
  for(const c of [C.events,C.matches,C.notificationTasks,C.llmJobs])assert.equal((await read(target,c)).length,0,'MIGRATION_MUST_NOT_CREATE_ACTIVE_DATA');
  await source.transaction(tx=>tx.put(C.migrationRuns,'initial-import',{source_hash:plan.source_hash,records:plan.entries.length,archived_records:plan.summary.archived_records,verified:true,checked_at:new Date().toISOString()}));
 }
 const report={env:ENV,prefix:config.prefix,phase:write?'frozen import verified':'read-only target comparison',source_hash:plan.source_hash,inserted,verified,summary:plan.summary,checked_at:new Date().toISOString()};fs.writeFileSync(root+'/outputs/migration/'+(write?'import':'target-comparison')+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify({phase:report.phase,inserted,verified_records:Object.values(verified).reduce((n,x)=>n+x.verified,0),expected_records:plan.entries.length}));
}
if(require.main===module)run().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
module.exports={clean};
