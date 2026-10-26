// Explicitly restricted to the synthetic preview namespace. Never reads/writes production records.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..'),config=require('../../specs/test-chain/config.json'),base=root+'/cloudrun/xiaopingu-api';
const {namespaceDatabase}=require(base+'/runtime-policy'),{COLLECTIONS:C}=require(base+'/assessment/model');
const {generate,digest}=require(base+'/portal/credentials'),{createCloudBaseStore}=require(base+'/app');
async function provision({fresh=false}={}){
 assert.equal(config.synthetic_only,true);assert.equal(config.prefix,'xg_preview_7d0a8e2622_');assert.equal(config.service,'xiaopingu-assessment-preview');
 const runtime=JSON.parse(fs.readFileSync(root+'/.env.preview-runtime.json'));assert.equal(runtime.TCB_ENV,config.env);assert.equal(runtime.XPG_PREVIEW_MODE,'1');assert.equal(runtime.XPG_COLLECTION_PREFIX,config.prefix);
 const dir=root+'/.private/test-chain';fs.mkdirSync(dir,{recursive:true,mode:0o700});const latest=dir+'/latest.json';if(!fresh&&fs.existsSync(latest))return JSON.parse(fs.readFileSync(latest));
 const sdk=require(base+'/node_modules/@cloudbase/node-sdk'),db=namespaceDatabase(sdk.init({env:config.env,accessKey:runtime.CLOUDBASE_APIKEY}).database(),config.prefix),store=createCloudBaseStore(db);
 const run=crypto.randomUUID(),id=crypto.randomUUID(),visitor_id='test_'+run,credential=generate(),edit=crypto.randomBytes(32).toString('base64url'),stamp=new Date().toISOString(),label=run.slice(0,8);
 await store.portal.source.transaction(async tx=>{
  assert.equal(await tx.get(C.visitors,visitor_id),null);assert.equal(await tx.get('counselors',id),null);
  await tx.put(C.visitors,visitor_id,{visitor_id,provider:'intake-receipt',credential_hash:digest(credential),disabled:false,created_at:stamp,test_run_id:run,synthetic:true});
  await tx.put('counselors',id,{id,name:'合成测试咨询师 '+label,edit_token:edit,is_active:true,is_demo:false,review_status:'approved',created_at:stamp,updated_at:stamp,test_run_id:run,synthetic:true,bio_short:'仅供联调演示，无真实咨询服务',bio_full:'合成测试资料，不代表真实咨询师资质。',credential_level:'二级',years_experience:20,city:'测试城市',fee_min:0,fee_budget_level:'low',specialties:['情绪困扰','关系困境','压力管理'],severity_levels:['轻度','中度','重度'],populations:['成人'],session_formats:['视频咨询','线下面询'],approaches:['CBT','人本主义'],cnip_styles:['structured','balanced','open'],cnip_emotion_focus:['rational','balanced','emotional'],cnip_time:['past','balanced','present'],cnip_stance:['warm','balanced','direct'],cnip_homework:['yes','neutral','no'],cnip_relational:['discuss','neutral','skip']});
 });
 for(const policy of require('../../specs/v2-cutover/consent-policies.json').policies){const old=await store.portal.source.get(C.consentPolicies,policy.scope);await store.consent.publishPolicy({...policy,published_by:'test-chain-operator',expected_revision:old?.revision||0});}
 const release=await store.portal.source.get(C.assessmentRelease,'current');await store.provenance.publishVersions({...require(base+'/assessment/provenance').compatibilityVersionBundle(),published_by:'test-chain-operator',expected_revision:release?.revision||0});
 const p=await store.assessment.getRollout();await store.assessment.updateRollout({role:'admin',subject:'test-chain-operator',aud:'xg-assessment',auth_method:'admin-password',demo:false,exp:Date.now()+3600000},{expected_revision:p.revision,patch:{collection_paused:false,emergency_stop:false,enable_reminder:true,enable_cst:true},reason:'User requested synthetic end-to-end walkthrough; external providers remain disabled'});
 const account={run_id:run,created_at:stamp,env:config.env,prefix:config.prefix,api_url:config.api_url,visitor:{id:visitor_id,name:'合成测试来访者 '+label,credential},counselor:{id,name:'合成测试咨询师 '+label,credential:edit},admin:{password:runtime.XPG_ADMIN_PASSWORD},synthetic:true};
 for(const file of [latest,dir+'/'+run+'.json']){fs.writeFileSync(file,JSON.stringify(account,null,2),{mode:0o600});fs.chmodSync(file,0o600);}
 const doc='# 测试链路账号（仅本机私有）\n\n入口：http://127.0.0.1:8796/\n\n测试区：'+config.prefix+'\n\n本次轮次：'+run+'\n\n来访填写凭证：'+credential+'\n\n咨询师编辑码：'+edit+'\n\n测试后台密码：'+runtime.XPG_ADMIN_PASSWORD+'\n\n这里只包含合成数据，不能用于正式后台。初评记录、审批和四评数据会保留在测试区。\n';fs.writeFileSync(dir+'/accounts.md',doc,{mode:0o600});fs.chmodSync(dir+'/accounts.md',0o600);
 return account;
}
if(require.main===module)provision({fresh:process.argv.includes('--new-run')}).then(a=>console.log(JSON.stringify({run_id:a.run_id,synthetic:true,credentials_file:'.private/test-chain/accounts.md'}))).catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
module.exports={provision};
