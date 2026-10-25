// Plaintext credentials stay in the ignored private delivery file; only hashes enter the database.
const fs=require('node:fs'),path=require('node:path');
const {generate,digest}=require('../../cloudrun/xiaopingu-api/portal/credentials');
const {COLLECTIONS:C}=require('../../cloudrun/xiaopingu-api/assessment/model');
function provision(plan,filename){
 fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
 const saved=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):{schema:'private-visitor-credentials-v1',entries:{}};
 for(const item of plan.entries.filter(e=>e.collection===C.visitors)){
  if(!saved.entries[item.id])saved.entries[item.id]={credential:generate(),assessment_ids:plan.entries.filter(e=>e.collection===C.intakes&&e.record.visitor_id===item.id).map(e=>e.id),delivery_status:'pending_identity_verification'};
  item.record.credential_hash=digest(saved.entries[item.id].credential);
 }
 fs.writeFileSync(filename,JSON.stringify(saved,null,2),{mode:0o600});fs.chmodSync(filename,0o600);
 return plan;
}
module.exports={provision};
