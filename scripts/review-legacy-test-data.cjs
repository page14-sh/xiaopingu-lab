// Read-only inventory. Never infer test data from a person's name or delete records.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
async function main(){
 if(process.argv[2]!=='--read-only')throw new Error('Use --read-only');
 const raw=execFileSync('tcb',['secrets','get','--json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 const parsed=JSON.parse(raw.slice(raw.indexOf('{'))),c=parsed.data||parsed;
 if(!c.isTemporary||!c.token)throw new Error('Temporary credentials required');
 const sdk=require('../cloudrun/xiaopingu-api/node_modules/@cloudbase/node-sdk');
 const db=sdk.init({env:'xpg-demo-d3gzsswtcc3233ea0',region:'ap-shanghai',secretId:c.secretId,secretKey:c.secretKey,sessionToken:c.token}).database();
 const records=[];let cursor='';
 for(let page=0;page<100;page++){
  const r=await db.collection('assessments').where(cursor?{_id:db.command.gt(cursor)}:{}).orderBy('_id','asc').field({_id:true,id:true,created_at:true,synthetic:true,is_test:true,source:true,match_request_status:true}).limit(100).get();
  if(r.code||!Array.isArray(r.data))throw new Error('Inventory query failed');
  for(const row of r.data)records.push({...row,classification:row.synthetic===true||row.is_test===true||row.source==='synthetic-test'?'explicit_test_marker_requires_review':'unclassified_preserve'});
  if(r.data.length<100)break;cursor=r.data.at(-1)._id;if(page===99)throw new Error('Inventory exceeds safe scan bound');
 }
 const dir=path.resolve(__dirname,'../.private');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const report={generated_at:new Date().toISOString(),env:'xpg-demo-d3gzsswtcc3233ea0',collection:'assessments',read_only:true,records};
 fs.writeFileSync(path.join(dir,'test-data-review.json'),JSON.stringify(report,null,2),{mode:0o600});
 const summary={scanned:records.length,explicit_test_markers:records.filter(r=>r.classification==='explicit_test_marker_requires_review').length,unclassified:records.filter(r=>r.classification==='unclassified_preserve').length,deleted:0,modified:0,report:'.private/test-data-review.json'};
 fs.mkdirSync(path.resolve(__dirname,'../outputs/security'),{recursive:true});fs.writeFileSync(path.resolve(__dirname,'../outputs/security/test-data-summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
}
main().catch(e=>{console.error(e.code||e.name);process.exitCode=1;});
