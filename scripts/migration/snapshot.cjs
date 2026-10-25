// Authorized local backup: full source records stay in .private (never tool output/Git).
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const {BUSINESS_SOURCES,BACKUP_ONLY}=require('./source');
const ENV='xpg-demo-d3gzsswtcc3233ea0';
function canonical(value){
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(value instanceof Date)return canonical({__xpg_backup_type:'Date',iso:value.toISOString()});
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 throw new Error('UNSUPPORTED_SOURCE_VALUE');
}
const hash=value=>crypto.createHash('sha256').update(canonical(value)).digest('hex');
async function open(){const raw=execFileSync('tcb',['secrets','get','--json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}),p=JSON.parse(raw.slice(raw.indexOf('{'))),c=p.data||p;assert.ok(c.isTemporary&&c.token);return require('../../cloudrun/xiaopingu-api/node_modules/@cloudbase/node-sdk').init({env:ENV,region:'ap-shanghai',secretId:c.secretId,secretKey:c.secretKey,sessionToken:c.token}).database();}
async function read(db,name){const rows=[];let after='';for(let page=0;page<100;page++){const r=await db.collection(name).where(after?{_id:db.command.gt(after)}:{}).orderBy('_id','asc').limit(100).get();if(r.code||!Array.isArray(r.data))throw new Error('SNAPSHOT_READ_FAILED');rows.push(...r.data);if(r.data.length<100)return rows;after=r.data.at(-1)._id;}throw new Error('SNAPSHOT_LIMIT_EXCEEDED');}
async function snapshot(){assert.equal(process.argv[2],'--read-only');const db=await open(),data={},started=new Date().toISOString();for(const name of [...BUSINESS_SOURCES,...BACKUP_ONLY])data[name]=await read(db,name);
 const stable={};for(const name of Object.keys(data))stable[name]=hash(data[name])===hash(await read(db,name));
 const run='discovery-'+Date.now(),dir=path.resolve(__dirname,'../../.private/migration',run);fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const backup={schema:'legacy-snapshot-v1',env:ENV,started_at:started,finished_at:new Date().toISOString(),stable,collections:data};const bytes=canonical(backup);fs.writeFileSync(path.join(dir,'snapshot.json'),bytes,{mode:0o600,flag:'wx'});
 const summary={run,env:ENV,phase:'read-only discovery, not final cutover snapshot',all_stable:Object.values(stable).every(Boolean),snapshot_sha256:crypto.createHash('sha256').update(bytes).digest('hex'),collections:Object.entries(data).map(([name,rows])=>({name,count:rows.length,sha256:hash(rows),stable:stable[name],purpose:BACKUP_ONLY.includes(name)?'backup_only_expiring_sessions':'business_migration',fields:[...new Set(rows.flatMap(r=>Object.keys(r)))].sort()}))};
 fs.mkdirSync(path.resolve(__dirname,'../../outputs/migration'),{recursive:true});fs.writeFileSync(path.resolve(__dirname,'../../outputs/migration/discovery.json'),JSON.stringify(summary,null,2));fs.writeFileSync(path.resolve(__dirname,'../../.private/migration/latest-snapshot-path'),path.join(dir,'snapshot.json'),{mode:0o600});console.log(JSON.stringify({run,backup_private:true,all_stable:summary.all_stable,counts:summary.collections.map(x=>({name:x.name,count:x.count,purpose:x.purpose}))}));
}
if(require.main===module)snapshot().catch(e=>{console.error(e.code||e.name);process.exitCode=1;});
module.exports={ENV,canonical,hash,open,read};
