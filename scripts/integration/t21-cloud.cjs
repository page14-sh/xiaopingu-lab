const assert=require('node:assert/strict');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const path=require('node:path');
const fs=require('node:fs');
const {randomBytes}=require('node:crypto');
const exec=promisify(execFile),root=path.resolve(__dirname,'../..'),runtime=path.join(root,'cloudrun/xiaopingu-api');
const sdk=require(path.join(runtime,'node_modules/@cloudbase/node-sdk'));
const manifest=require(path.join(runtime,'assessment/collections.json'));
const ENV='xpg-demo-d3gzsswtcc3233ea0';
const safeCode=e=>String(e?.code||e?.name||'ERROR').replace(/[^A-Za-z0-9_.-]/g,'').slice(0,100);
async function cli(args){
 let stdout;try{({stdout}=await exec('tcb',args,{timeout:45000,maxBuffer:4*1024*1024}));}catch(e){let code='CLI_FAILED';try{const s=String(e.stdout);code=JSON.parse(s.slice(s.indexOf('{'))).error?.code||code;}catch{}throw Object.assign(new Error('CloudBase CLI request failed'),{code});}
 const r=JSON.parse(stdout.slice(stdout.indexOf('{')));if(r.error)throw Object.assign(new Error('CloudBase CLI request failed'),{code:r.error.code});return r.data||r;
}
async function api(action,body={}){const r=await cli(['api','tcb',action,'--api-version','2018-06-08','--body',JSON.stringify({EnvId:ENV,...body}),'--json']);const d=r.Response||r;if(d.Error)throw Object.assign(new Error('CloudBase API request failed'),{code:d.Error.Code});return d;}
const checked=r=>{if(!r||r.code)throw Object.assign(new Error('CloudBase database request failed'),{code:r?.code||'EMPTY_RESPONSE'});return r;};
async function batches(rows,work){for(let i=0;i<rows.length;i+=3){const settled=await Promise.allSettled(rows.slice(i,i+3).map(work));const failure=settled.find(r=>r.status==='rejected');if(failure)throw failure.reason;}}
function resourcePlan(prefix){
 assert.match(prefix,/^xg_t21_\d{13}_[a-f0-9]{6}_$/);
 const entries=[...manifest.collections,{name:'assessments'},{name:'counselors'}];
 const names=new Map(entries.map(e=>[e.name,prefix+e.name.replace(/^xg_/, '')]));return {entries,names};
}
function validateReport(report){assert.equal(report.schema_version,'integration-t21-v1');assert.equal(report.env,ENV);const {names}=resourcePlan(report.prefix);assert.ok(Array.isArray(report.created));for(const name of report.created)assert.ok([...names.values()].includes(name),'Refuse foreign cleanup target');assert.equal(new Set(report.created).size,report.created.length);return report;}
async function open(previous){
 if(previous)validateReport(previous);
 const credentials=await cli(['secrets','get','--json']);assert.ok(credentials.isTemporary&&credentials.secretId&&credentials.secretKey&&credentials.token,'Temporary credentials required');
 const environment=await cli(['env','detail','-e',ENV,'--json']);assert.equal(environment.envId,ENV);assert.equal(environment.status,'NORMAL');assert.equal(environment.region,'ap-shanghai');
 const prefix=previous?.prefix||`xg_t21_${Date.now()}_${randomBytes(3).toString('hex')}_`;
 const {entries,names}=resourcePlan(prefix);
 const db=sdk.init({env:ENV,region:'ap-shanghai',secretId:credentials.secretId,secretKey:credentials.secretKey,sessionToken:credentials.token}).database();
 const report=previous||{schema_version:'integration-t21-v1',env:ENV,prefix,started_at:new Date().toISOString(),environment:{status:environment.status,region:environment.region},created:[],resources:[],tests:[],cleanup:[],transaction_events:{},scope:{api:'local-loopback-current-code',database:'real-cloudbase-isolated-collections',identity:'synthetic-signed-bridge',notifications:'mock',llm:'mock',business_clock:'injected'}};
 const output=path.join(root,'outputs/t21',prefix+'report.json');fs.mkdirSync(path.dirname(output),{recursive:true});
 const persist=()=>fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
 function physical(name){assert.ok(names.has(name),'Unmapped collection refused');return names.get(name);}
 const mapped={command:db.command,collection:name=>db.collection(physical(name)),async startTransaction(){const tx=await db.startTransaction();return {collection:name=>tx.collection(physical(name)),commit:()=>tx.commit(),rollback:()=>tx.rollback()};}};
 async function prepare(only){
   const selected=only?entries.filter(e=>only.includes(e.name)):entries;if(only)assert.equal(selected.length,new Set(only).size);
   persist();await batches(selected,async e=>{const name=physical(e.name);const absent=await db.collection(name).limit(1).get().then(r=>r.code,e=>e.code);
     assert.ok(['DATABASE_COLLECTION_NOT_EXIST','DATABASE_COLLECTION_NOT_FOUND'].includes(absent),'Refuse existing collection');
     report.created.push(name);persist();checked(await db.createCollection(name));
     await api('ModifyDatabaseACL',{CollectionName:name,AclTag:'ADMINONLY'});const acl=await api('DescribeDatabaseACL',{CollectionName:name});assert.equal(acl.AclTag,'ADMINONLY');
     if(e.indexes?.length)await api('UpdateTable',{TableName:name,CreateIndexes:e.indexes.map(i=>({IndexName:i.name,MgoKeySchema:{MgoIsUnique:i.unique===true,MgoIndexKeys:i.fields.map(f=>({Name:f.name,Direction:f.direction==='desc'?'-1':'1'}))}}))});
     const detail=await api('DescribeTable',{TableName:name});const indexes=detail.Indexes||[];
     for(const i of e.indexes||[]){const actual=indexes.find(a=>a.Name===i.name||a.IndexName===i.name);assert.ok(actual,`Missing declared index ${i.name}`);assert.deepEqual(actual.Keys,i.fields.map(f=>({Name:f.name,Direction:f.direction==='desc'?'-1':'1'})));}
     report.resources.push({logical:e.name,physical:name,acl:acl.AclTag,indexes:indexes.map(i=>({name:i.Name||i.IndexName,keys:i.Keys||i.MgoKeySchema||null,status:i.Status||null}))});persist();console.log(`READY ${e.name}`);
   });
 }
 async function cleanup(){
   await batches(report.created,async name=>{assert.ok([...names.values()].includes(name));if(report.cleanup.some(r=>r.collection===name&&r.deleted))return;
     try{const preview=await db.collection(name).count();if(!['DATABASE_COLLECTION_NOT_EXIST','DATABASE_COLLECTION_NOT_FOUND'].includes(preview.code)){
       checked(preview);console.log(`CLEANUP ${name} (${preview.total} synthetic records)`);await api('DeleteTable',{TableName:name});}
       const code=await db.collection(name).limit(1).get().then(r=>r.code,e=>e.code);assert.ok(['DATABASE_COLLECTION_NOT_EXIST','DATABASE_COLLECTION_NOT_FOUND'].includes(code));
       report.cleanup.push({collection:name,deleted:true});
     }catch(e){report.cleanup.push({collection:name,deleted:false,code:safeCode(e)});}persist();
   });
   report.cleanup_complete=report.created.every(name=>report.cleanup.some(r=>r.collection===name&&r.deleted));report.finished_at=new Date().toISOString();if(!report.cleanup_complete)report.passed=false;persist();assert.ok(report.cleanup_complete,'Cleanup incomplete');
 }
 return {root,runtime,db,mapped,names,report,output,persist,prepare,cleanup,checked,physical};
}
module.exports={open,safeCode,resourcePlan,validateReport};
