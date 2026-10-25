const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {inspect,readRelative}=require('../../../scripts/check-assessment-release.cjs');
const gates=require('../../../specs/assessment-foundation/release/gates.json');
const index=require('../../../outputs/t21/evidence-index.json');
// Synthetic aligned evidence for testing the checker itself. Never rewrites the historical T21 report.
function aligned(){const copy=structuredClone(index);const root=path.resolve(__dirname,'../../..');for(const file of Object.keys(copy.runtime_source_hashes))copy.runtime_source_hashes[file]=require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');return copy;}

test('T22 consistent backend evidence still produces NO_GO for known product gaps',()=>{
 const result=inspect({index:aligned()});assert.equal(result.evidence_consistent,true);assert.equal(result.decision,'NO_GO');assert.equal(result.deploy_allowed,false);assert.equal(result.approval_granted,false);
 assert.ok(result.open_gates.some(g=>g.id==='frontend'));assert.ok(result.missing_target.includes('image_digest'));
});
test('T22 changed source or substituted report invalidates prior evidence',()=>{
 const changed=structuredClone(index),first=Object.keys(changed.runtime_source_hashes)[0];changed.runtime_source_hashes[first]='0'.repeat(64);
 assert.equal(inspect({index:changed}).decision,'INVALID_EVIDENCE');
 const substituted=structuredClone(index);substituted.reports[0].sha256='0'.repeat(64);assert.equal(inspect({index:substituted}).decision,'INVALID_EVIDENCE');
});
test('T22 editing gate statuses and approval text never authorizes deployment',()=>{
 const reviewed=structuredClone(gates);for(const gate of reviewed.gates){gate.status='verified_in_scope';gate.evidence=['outputs/t21/evidence-index.json'];}
 for(const key of Object.keys(reviewed.target))reviewed.target[key]='synthetic-review-only';reviewed.approval.status='approved';
 const result=inspect({gates:reviewed,index:aligned()});assert.equal(result.decision,'MANUAL_REVIEW_REQUIRED');assert.equal(result.deploy_allowed,false);assert.equal(result.approval_granted,false);
});
test('T22 missing evidence and enabled review configuration fail closed',()=>{
 const missing=structuredClone(gates);missing.gates[0].evidence=['outputs/t22/not-present.json'];assert.equal(inspect({gates:missing}).decision,'INVALID_EVIDENCE');
 const configuration=structuredClone(require('../../../specs/assessment-foundation/release/config-template.json'));configuration.schedulers[0].enabled=true;
 assert.equal(inspect({configuration}).decision,'INVALID_EVIDENCE');
});
test('T22 evidence lookup rejects path traversal and symlinks outside its root',t=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'t22-evidence-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const base=path.join(temporary,'root');fs.mkdirSync(base);fs.writeFileSync(path.join(temporary,'outside'),'synthetic');fs.symlinkSync(path.join(temporary,'outside'),path.join(base,'link'));
 assert.throws(()=>readRelative(base,'../outside'));assert.throws(()=>readRelative(base,path.join(temporary,'outside')));assert.throws(()=>readRelative(base,'link'));
});
