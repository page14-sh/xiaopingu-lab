const fs=require('node:fs'),path=require('node:path'),{transform}=require('./transform.cjs');
const pointer=path.resolve(__dirname,'../../.private/migration/latest-snapshot-path');
const snapshotPath=fs.readFileSync(pointer,'utf8'),snapshot=JSON.parse(fs.readFileSync(snapshotPath,'utf8'));
if(!Object.values(snapshot.stable).every(Boolean))throw new Error('Source changed during discovery; take a new snapshot');
const plan=require('./credentials.cjs').provision(transform(snapshot),path.resolve(__dirname,'../../.private/migration/visitor-credentials.json')),privatePath=path.join(path.dirname(snapshotPath),'plan.json');
fs.writeFileSync(privatePath,JSON.stringify(plan),{mode:0o600});
const summary={schema:plan.schema,source_hash:plan.source_hash,...plan.summary};fs.writeFileSync(path.resolve(__dirname,'../../outputs/migration/plan.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
