// Offline readiness review only: never reads credentials, invokes cloud APIs,
// builds/publishes an image, changes flags or treats file existence as approval.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
function readRelative(base,relative){
 if(typeof relative!=='string'||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw new Error('Unsafe evidence path');
 const resolved=path.resolve(base,relative),real=fs.realpathSync(resolved);if(!real.startsWith(fs.realpathSync(base)+path.sep))throw new Error('Evidence must stay inside repository');
 return fs.readFileSync(real);
}
function inspect({base=root,gates,configuration,index}={}){
 gates=gates||JSON.parse(readRelative(base,'specs/assessment-foundation/release/gates.json'));
 configuration=configuration||JSON.parse(readRelative(base,'specs/assessment-foundation/release/config-template.json'));
 index=index||JSON.parse(readRelative(base,'outputs/t21/evidence-index.json'));
 const checks=[],add=(id,passed,detail)=>checks.push({id,passed,detail});
 add('schema',gates.schema_version==='release-gates-t22-v1'&&configuration.schema_version==='release-config-template-t22-v1'&&index.schema_version==='t21-evidence-index-v1','Known review artifact schemas');
 const drift=[];for(const [file,expected]of Object.entries(index.runtime_source_hashes||{})){try{if(hash(readRelative(base,file))!==expected)drift.push(file);}catch{drift.push(file);}}
 add('t21_runtime_source_match',Object.keys(index.runtime_source_hashes||{}).length>0&&!drift.length,{changed_or_missing:drift});
 const badReports=[];for(const record of index.reports||[]){try{const raw=readRelative(base,'outputs/t21/'+record.file),report=JSON.parse(raw);if(hash(raw)!==record.sha256||!report.cleanup_complete||!report.created.every(name=>report.cleanup.some(row=>row.collection===name&&row.deleted)))badReports.push(record.file);}catch{badReports.push(record.file);}}
 add('t21_report_integrity_and_cleanup',Array.isArray(index.reports)&&index.reports.length>0&&!badReports.length,{invalid_reports:badReports});
 add('t21_successful_scoped_integration',(index.reports||[]).some(r=>r.passed&&r.tests>=8&&r.scope?.api==='local-loopback-current-code'&&r.scope?.database==='real-cloudbase-isolated-collections'),'Scoped backend evidence only');
 add('closed_configuration_template',configuration.deployable===false&&configuration.non_secret_environment?.XPG_DEMO_MODE==='0'&&configuration.initial_policy_to_publish_before_exposure?.emergency_stop===true&&configuration.initial_policy_to_publish_before_exposure?.collection_paused===true&&configuration.initial_policy_to_publish_before_exposure?.enable_reminder===false&&configuration.initial_policy_to_publish_before_exposure?.enable_cst===false&&Object.values(configuration.secret_references_only||{}).every(v=>v===null)&&Array.isArray(configuration.schedulers)&&configuration.schedulers.every(s=>s.enabled===false),'Review template remains disabled and contains no secret values');
 const missingEvidence=[];for(const gate of gates.gates||[]){if(!['open','verified_in_scope'].includes(gate.status))missingEvidence.push(gate.id+':invalid-status');if(gate.status==='verified_in_scope'&&!gate.evidence?.length)missingEvidence.push(gate.id+':no-evidence');for(const file of gate.evidence||[]){try{readRelative(base,file);}catch{missingEvidence.push(file);}}}
 add('gate_evidence_references',Array.isArray(gates.gates)&&gates.gates.length>0&&!missingEvidence.length,{missing:missingEvidence});
 const manifest=JSON.parse(readRelative(base,'cloudrun/xiaopingu-api/assessment/collections.json'));
 const names=manifest.collections.map(c=>c.name);add('resource_manifest',names.length===42&&new Set(names).size===42&&manifest.client_access.read===false&&manifest.client_access.write===false,{collections:names.length,declared_indexes:manifest.collections.reduce((n,c)=>n+(c.indexes||[]).length,0)});
 const openGates=(gates.gates||[]).filter(g=>g.status!=='verified_in_scope').map(g=>({id:g.id,owner_role:g.owner_role,requirement:g.requirement}));
 const missingTarget=Object.entries(gates.target||{}).filter(([,v])=>typeof v!=='string'||!v.trim()).map(([k])=>k);
 const failures=checks.filter(c=>!c.passed).map(c=>c.id);
 // A local report is never an authorization or a deployment gate bypass.
 return {schema_version:'release-readiness-t22-v1',decision:failures.length?'INVALID_EVIDENCE':openGates.length||missingTarget.length?'NO_GO':'MANUAL_REVIEW_REQUIRED',
   deploy_allowed:false,approval_granted:false,evidence_consistent:failures.length===0,checks,open_gates:openGates,missing_target:missingTarget,
   release_approval:gates.approval?.status||'not_requested',automated_review_limit:'Checks hashes, references and declared gaps; does not certify truth of human signoff or authorize deployment.',
   verification_scope:{network_calls:0,cloud_mutations:0,credentials_read:false}};
}
function main(){if(process.argv.length!==2)throw new Error('No target, secrets or apply arguments accepted');const report=inspect();const folder=path.join(root,'outputs/t22');fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'release-readiness.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({decision:report.decision,evidence_consistent:report.evidence_consistent,open_gates:report.open_gates.length,deploy_allowed:false,report:'outputs/t22/release-readiness.json'}));process.exitCode=report.evidence_consistent?2:1;
}
if(require.main===module){try{main();}catch{console.error('Release review failed; no deployment performed.');process.exitCode=1;}}
module.exports={inspect,readRelative};
