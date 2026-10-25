const {COLLECTIONS:C}=require('./assessment/model');
const LEGACY_TABLES=['assessments','counselors','sessions','pcoms_ratings','visitor_users'];
function runtimePolicy(env=process.env){
 const preview=env.XPG_PREVIEW_MODE==='1',prefix=env.XPG_COLLECTION_PREFIX||'';
 if(preview&&!/^xg_preview_[a-z0-9]{4,12}_$/.test(prefix))throw new Error('Preview requires an isolated collection prefix');
 if(!preview&&prefix)throw new Error('Collection prefix is only supported in isolated preview mode');
 return {preview,prefix,notificationsEnabled:!preview&&env.XPG_EXTERNAL_NOTIFICATIONS_ENABLED==='1',llmEnabled:!preview&&env.XPG_LLM_ENABLED==='1'};
}
function namespaceDatabase(database,prefix){
 if(!prefix)return database;if(!/^xg_preview_[a-z0-9]{4,12}_$/.test(prefix))throw new Error('Invalid isolated namespace');
 const names=new Map([...Object.values(C),...LEGACY_TABLES].map(name=>[name,prefix+name.replace(/^xg_/, '')]));
 if(new Set(names.values()).size!==names.size)throw new Error('Namespace collision');
 const physical=name=>{if(!names.has(name))throw new Error('Unmapped database access refused');return names.get(name);};
 return {command:database.command,collection:name=>database.collection(physical(name)),async startTransaction(){const tx=await database.startTransaction();return {collection:name=>tx.collection(physical(name)),commit:()=>tx.commit(),rollback:()=>tx.rollback()};}};
}
const disabledNotifications={async send(){return {kind:'rejected',code:'EXTERNAL_NOTIFICATIONS_DISABLED'};}};
module.exports={runtimePolicy,namespaceDatabase,LEGACY_TABLES,disabledNotifications};
