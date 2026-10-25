const {COLLECTIONS:C,documentKey}=require('../../cloudrun/xiaopingu-api/assessment/model');
const {BUSINESS_SOURCES}=require('./source');
const {canonical,hash}=require('./snapshot.cjs');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID=/^[A-Za-z0-9_-]{1,128}$/;
const visitorId=id=>'legacy_'+documentKey('legacy-intake',id);
function groups(rows,key){const m=new Map();for(const row of rows){const value=row[key];if(typeof value==='string'&&value){const list=m.get(value)||[];list.push(row);m.set(value,list);}}return m;}
const single=(map,key)=>map.get(key)?.length===1?map.get(key)[0]:null;
function safeCopy(value){if(Array.isArray(value))return value.map(safeCopy);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['__proto__','constructor','prototype'].includes(k)&&!k.startsWith('$')).map(([k,v])=>[k,safeCopy(v)]));return value;}
function transform(snapshot){
 const data=snapshot.collections,entries=[],issues=[];for(const name of BUSINESS_SOURCES)if(!Array.isArray(data[name]))throw new Error('INCOMPLETE_SNAPSHOT');
 const assessments=groups(data.assessments,'id'),counselors=groups(data.counselors,'id'),users=groups(data.visitor_users,'id'),matches=groups(data.assessments,'match_id'),switches=groups(data.xg_case_switch,'match_id'),sessions=groups(data.sessions,'id'),events=groups(data.xg_assessment_events,'id'),caps=groups(data.assessments,'view_token');
 const eligible=a=>a&&UUID.test(a.id)&&UUID.test(a.view_token)&&assessments.get(a.id)?.length===1&&caps.get(a.view_token)?.length===1;
 const fromUser=user=>{const u=single(users,user);if(u?.asid)return single(assessments,u.asid);if(typeof user==='string'&&user.startsWith('asid-'))return single(assessments,user.slice(5));return null;};
 function scope(source,row,depth=0){
  if(depth>3)return {reason:'reference_depth'};
  const candidates=[],candidatesC=[];let missing=false;
  const add=a=>{if(a)candidates.push(a);else missing=true;};
  if(source==='assessments')add(single(assessments,row.id));
  if(row.assessment_id)add(single(assessments,row.assessment_id));
  if(source==='visitor_users'&&row.asid)add(single(assessments,row.asid));
  if(row.user_id)add(fromUser(row.user_id));
  if(source==='xg_case_switch'&&row.visitor_id)add(fromUser(row.visitor_id));
  if(row.match_id){const a=single(matches,row.match_id),sw=single(switches,row.match_id);if(a)add(a);if(sw?.visitor_id)add(fromUser(sw.visitor_id));if(sw?.counselor_id)candidatesC.push(sw.counselor_id);if(!a&&!sw)missing=true;}
  if(row.session_id){const parent=single(sessions,row.session_id);if(parent)add(single(assessments,parent.assessment_id));else missing=true;}
  if(row.event_id){const parent=single(events,row.event_id);if(parent){const p=scope('xg_assessment_events',parent,depth+1);if(p.assessment_id)add(single(assessments,p.assessment_id));else missing=true;if(p.counselor_id)candidatesC.push(p.counselor_id);}else missing=true;}
  if(row.counselor_id)candidatesC.push(row.counselor_id);
  const ids=[...new Set(candidates.map(a=>a.id))];
  if(ids.length!==1||missing)return {reason:ids.length>1?'conflicting_references':missing?'missing_reference':'unscoped'};
  const a=single(assessments,ids[0]);if(!eligible(a))return {reason:'invalid_intake_identity'};
  const cs=[...new Set(candidatesC)];if(cs.length>1)return {reason:'conflicting_counselors'};
  const cid=cs[0]||a.match_request_cid||a.selected_counselor_id||null;
  if(cid&&!single(counselors,cid))return {reason:'missing_counselor'};
  return {assessment_id:a.id,visitor_id:visitorId(a.id),counselor_id:cid,reason:'explicit_source_links'};
 }
 function put(collection,id,record,kind){if(!ID.test(id))throw new Error('INVALID_TARGET_ID');entries.push({collection,id,record,kind});}
 for(const source of BUSINESS_SOURCES)for(const row of data[source]){
  if(typeof row._id!=='string'||!row._id)throw new Error('SOURCE_DOCUMENT_ID_MISSING');
  const owner=scope(source,row),id=documentKey(source,row._id);
  put(C.legacyRecords,id,{archive_id:id,source_collection:source,source_document_id:row._id,source_business_id:typeof row.id==='string'?row.id:null,source_hash:hash(row),raw_json:canonical(row),assessment_id:owner.assessment_id||null,visitor_id:owner.visitor_id||null,counselor_id:owner.counselor_id||null,source_match_id:typeof row.match_id==='string'?row.match_id:null,link_status:owner.assessment_id?'linked':'admin_review',link_reason:owner.reason,imported_at:snapshot.finished_at,legacy_only:true},'archive');
  if(!owner.assessment_id&&!['counselors','xg_config','xg_scale_items','xg_scales','visitor_users'].includes(source))issues.push({source,source_document_id:row._id,reason:owner.reason});
 }
 for(const source of ['assessments','counselors','sessions','pcoms_ratings','visitor_users']){
  const byId=groups(data[source],'id');
  for(const row of data[source]){
   if(!ID.test(row.id||'')||byId.get(row.id)?.length!==1){issues.push({source,source_document_id:row._id,reason:'invalid_or_duplicate_business_id'});continue;}
   const {_id,...copy}=safeCopy(row),record={...copy,migration_source_id:row._id,migration_source_hash:hash(row),migration_imported:true};
   if(source==='assessments'){
    const valid=eligible(row);record.migration_access=valid?'receipt':'admin-review';record.legacy_match_id=row.match_id||null;record.legacy_match_request_status=row.match_request_status||null;
    // Old consultation history is never silently resumed as a new active cycle.
    record.match_id=null;record.xg_managed=true;record.visitor_user_id=valid?visitorId(row.id):null;
    record.answers={crisis_screen:['safe','passive','active','action'].includes(row.crisis_level)?row.crisis_level:'safe'};
    record.xg_scope_status=['active','action'].includes(row.crisis_level)||row.xg_scope_status==='out_of_scope'?'out_of_scope':'pending_review';
    record.historical_only=row.match_request_status!=='pending';
    if(valid){put(C.visitors,visitorId(row.id),{visitor_id:visitorId(row.id),provider:'intake-receipt',disabled:false,created_at:row.created_at||snapshot.finished_at,migration_imported:true},'identity');put(C.intakes,row.id,{assessment_id:row.id,visitor_id:visitorId(row.id),created_at:row.created_at||snapshot.finished_at,migration_imported:true},'identity');
     if(row.match_request_status==='pending'&&single(counselors,row.match_request_cid)){
      const rid=documentKey('migrated-pending-request',row.id,row.match_request_cid);record.current_request_id=rid;
      put(C.requests,rid,{request_id:rid,assessment_id:row.id,visitor_id:visitorId(row.id),counselor_id:row.match_request_cid,status:'pending',created_at:row.created_at||snapshot.finished_at,migration_imported:true},'request');
     }
    }
   }
   if(source==='counselors'){record.is_active=row.is_active===true;record.is_demo=row.is_demo===true||/^00000000-0000-4000-8000-00000000000[12]$/.test(row.id);}
   put(source,row.id,record,'working');
  }
 }
 const keys=entries.map(e=>e.collection+'/'+e.id);if(new Set(keys).size!==keys.length)throw new Error('TARGET_KEY_COLLISION');
 const counts={};for(const e of entries)counts[e.collection]=(counts[e.collection]||0)+1;
 return {schema:'v2-migration-plan-v1',source_hash:hash(data),entries,issues,summary:{source_business_records:BUSINESS_SOURCES.reduce((n,s)=>n+data[s].length,0),archived_records:entries.filter(e=>e.kind==='archive').length,working_records:entries.filter(e=>e.kind==='working').length,visitor_identities:entries.filter(e=>e.collection===C.visitors).length,pending_requests:entries.filter(e=>e.kind==='request').length,legacy_events_with_frozen_basis:data.xg_assessment_events.filter(e=>e.basis).length,native_events_created:0,active_cycles_created:0,external_jobs_created:0,admin_review_records:issues.length,issue_reasons:issues.reduce((out,i)=>(out[i.reason]=(out[i.reason]||0)+1,out),{}),target_counts:counts}};
}
module.exports={transform,visitorId,safeCopy,UUID};
