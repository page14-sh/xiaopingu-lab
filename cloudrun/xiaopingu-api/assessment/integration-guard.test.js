const test=require('node:test');
const assert=require('node:assert/strict');
const {resourcePlan,validateReport,safeCode}=require('../../../scripts/integration/t21-cloud.cjs');
const prefix='xg_t21_1792870976770_b9d285_';
const valid=()=>({schema_version:'integration-t21-v1',env:'xpg-demo-d3gzsswtcc3233ea0',prefix,created:[prefix+'assessment_events']});

test('T21 isolated resource plan includes all current collections and never canonical physical names',()=>{
 const {entries,names}=resourcePlan(prefix);const count=Object.keys(require('./model').COLLECTIONS).length+2;assert.equal(entries.length,count);assert.equal(names.size,count);assert.equal(new Set(names.values()).size,count);
 for(const [logical,physical]of names){assert.notEqual(logical,physical);assert.ok(physical.startsWith(prefix));}
 assert.equal(names.get('counselors'),prefix+'counselors');assert.equal(names.has('arbitrary_private_collection'),false);
});

test('T21 cleanup manifest rejects wrong environment, namespace, collection and duplicate target',()=>{
 assert.equal(validateReport(valid()).prefix,prefix);
 for(const patch of [{env:'production'},{prefix:'xg_'},{prefix:'xg_t10_1792870976770_b9d285_'},{created:['xg_assessment_events']},{created:[prefix+'unmapped']},{created:[prefix+'assessment_events',prefix+'assessment_events']},{schema_version:'unknown'}])assert.throws(()=>validateReport({...valid(),...patch}));
});

test('T21 error reporting never copies message or response payload',()=>{
 assert.equal(safeCode({code:'SAFE_CODE',message:'secret',response:'private'}),'SAFE_CODE');assert.equal(safeCode({message:'secret',response:'private'}),'ERROR');assert.ok(safeCode({code:'a'.repeat(1000)}).length<=100);
});
