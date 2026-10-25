const {randomUUID,timingSafeEqual}=require('node:crypto');
const {COLLECTIONS:C,documentKey,AssessmentError,requireId}=require('../assessment/model');
const {requirePrincipal,deny,authorizeMatch}=require('../assessment/authorization');
const {validVisitor}=require('../assessment/visitor-identity');
const {blocked}=require('../assessment/admission');
const credentials=require('./credentials');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const vid=id=>'legacy_'+documentKey('legacy-intake',id);
function equal(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
function createPortalRepository(db,source,{identity,assessment,consent,provenance}){
 async function scan(collection,filter={},max=2000){const rows=[];let after;for(;;){const query={...filter,...(after?{_id:db.command.gt(after)}:{})};const r=await db.collection(collection).where(query).orderBy('_id','asc').limit(100).get();if(r.code||!Array.isArray(r.data))throw new AssessmentError('XG_STORAGE_ERROR','读取暂不可用',503);rows.push(...r.data);if(rows.length>max)throw new AssessmentError('XG_QUERY_LIMIT','结果较多，请缩小查询范围',503);if(r.data.length<100)return rows;after=r.data.at(-1)._id;}}
 async function member(principal){requirePrincipal(principal);if(principal.role==='visitor')await identity.requireVisitor(principal.subject,principal.auth_method);if(principal.role==='counselor'){const c=await source.get('counselors',principal.subject);if(!c||c.is_demo||c.is_active!==true||c.review_status!=='approved')deny('咨询师尚未审核或已停用');}return principal;}
 async function historyReceipt(credential){if(!UUID.test(credential||''))throw new AssessmentError('XG_UNAUTHORIZED','请使用完整历史链接',401);const rows=await scan('assessments',{view_token:credential},2);if(rows.length!==1||!equal(rows[0].view_token,credential)||rows[0].migration_access==='admin-review'||rows[0].xg_managed!==true)deny('历史凭证无效或需由平台核对');const owner=await source.get(C.intakes,rows[0].id);if(!owner||rows[0].visitor_user_id!==owner.visitor_id)deny();return {visitor_id:owner.visitor_id,assessment_id:rows[0].id};}
 async function receipt(credential){const hash=credentials.digest(credential),rows=await scan(C.visitors,{credential_hash:hash},2);if(rows.length!==1||!validVisitor(rows[0],'intake-receipt')||!credentials.matches(credential,rows[0].credential_hash))deny('填写凭证无效或已停用');return {visitor_id:rows[0].visitor_id};}
 async function createCounselor(row){return source.transaction(async tx=>{if(await tx.get('counselors',row.id))throw new AssessmentError('XG_ALREADY_EXISTS','记录已存在',409);await tx.put('counselors',row.id,row);return row;});}
 async function createIntake(row,caller={}){
  const claim=row.client_claim_secret,hash=credentials.digest(claim);delete row.client_claim_secret;
  if(!UUID.test(row.id)||row.view_token!==row.id)throw new AssessmentError('XG_BAD_PARAM','初评凭证不合法',400);
  const principal=caller.principal;if(principal){await member(principal);if(principal.role!=='visitor')deny('请以来访者身份完成初评');}
  return source.transaction(async tx=>{
   const existing=await tx.get('assessments',row.id),existingOwner=await tx.get(C.intakes,row.id);
   if(existing){if(!existingOwner||existingOwner.claim_hash!==hash)throw new AssessmentError('XG_ALREADY_EXISTS','记录已存在',409);return existing;}
   const id=principal?.subject||vid(row.id),visitor=await tx.get(C.visitors,id);
   if(!principal&&visitor)throw new AssessmentError('XG_IDENTITY_CONFLICT','初评身份需核对',409);
   const record={...row,xg_managed:true,visitor_user_id:id,migration_access:'receipt',historical_only:false,match_id:null,current_request_id:null,previous_match_id:null,match_request_cid:null,match_request_status:null,answers:{crisis_screen:['safe','passive','active','action'].includes(row.crisis_level)?row.crisis_level:'safe'},xg_scope_status:blocked(row)?'out_of_scope':'pending_review'};
   if(!principal)await tx.put(C.visitors,id,{visitor_id:id,provider:'intake-receipt',credential_hash:hash,disabled:false,created_at:new Date().toISOString()});
   await tx.put(C.intakes,row.id,{assessment_id:row.id,visitor_id:id,claim_hash:hash,created_at:new Date().toISOString()});await tx.put('assessments',row.id,record);return record;
  });
 }
 async function patchIntake(found,patch,caller){
  const owner=await source.get(C.intakes,found.id);
  if(!owner){if(caller.role!=='admin')deny();const forbidden=['id','view_token','visitor_user_id','xg_managed','match_id','match_request_status'];if(Object.keys(patch).some(k=>forbidden.includes(k)))deny('此历史记录需单独核对身份');return source.transaction(async tx=>{const current=await tx.get('assessments',found.id);const next={...current,...patch,updated_at:new Date().toISOString()};await tx.put('assessments',found.id,next);return next;});}
  if(caller.role!=='admin'&&caller.role!=='counselor'){await member(caller.principal);if(caller.principal.role!=='visitor'||caller.principal.subject!==owner.visitor_id)deny('请使用本人新版填写凭证');}
  const now=new Date().toISOString();
  if(patch.match_request_cid){const counselor=await source.get('counselors',patch.match_request_cid);if(!counselor||!counselor.is_active||counselor.review_status!=='approved'||counselor.is_demo)deny('咨询师不可申请');
   const requestId=randomUUID();return source.transaction(async tx=>{const current=await tx.get('assessments',found.id);if(blocked(current))deny('当前初评不开放咨询匹配');if(current.match_id){const cycle=await tx.get(C.matches,current.match_id);if(cycle?.status==='active')throw new AssessmentError('XG_ACTIVE_MATCH_EXISTS','当前周期尚未结案，请先与咨询师核对',409);}
    const prior=current.current_request_id&&await tx.get(C.requests,current.current_request_id);const reuse=prior?.status==='pending'&&prior.counselor_id===patch.match_request_cid;const rid=reuse?prior.request_id:requestId;
    if(!reuse)await tx.put(C.requests,rid,{request_id:rid,assessment_id:current.id,visitor_id:owner.visitor_id,counselor_id:patch.match_request_cid,status:'pending',created_at:now});
    const next={...current,...patch,visitor_user_id:owner.visitor_id,current_request_id:rid,previous_match_id:current.match_id||current.previous_match_id||null,match_id:null,match_request_status:'pending',historical_only:false,updated_at:now};await tx.put('assessments',current.id,next);return next;
   });
  }
  if(patch.match_request_status==='approved'){
   const p=caller.principal;await member(p);const current=await source.get('assessments',found.id);if(!current.current_request_id)throw new AssessmentError('XG_REQUEST_REQUIRED','历史审批不会自动开启新周期，请先重新申请',409);
   const request=await identity.approveRequest(p,current.current_request_id);
   const match=await assessment.createMatch({match_id:documentKey('match-request',request.request_id),assessment_id:request.assessment_id,visitor_id:request.visitor_id,counselor_id:request.counselor_id,previous_match_id:current.previous_match_id||undefined});
   return source.transaction(async tx=>{const latest=await tx.get('assessments',found.id);if(latest.current_request_id!==request.request_id)throw new AssessmentError('XG_REQUEST_CHANGED','申请已变化，请刷新',409);const next={...latest,...patch,match_id:match.match_id,match_request_cid:request.counselor_id,selected_counselor_id:request.counselor_id,historical_only:false,updated_at:now};await tx.put('assessments',found.id,next);return next;});
  }
  return source.transaction(async tx=>{const current=await tx.get('assessments',found.id);if(patch.match_request_status==='rejected'&&current.current_request_id){const req=await tx.get(C.requests,current.current_request_id);if(req?.status!=='pending')throw new AssessmentError('XG_REQUEST_STATE','只能拒绝待处理申请',409);await tx.put(C.requests,req.request_id,{...req,status:'rejected',rejected_at:now,rejected_by:caller.principal.subject});}
   for(const key of ['id','view_token','visitor_user_id','xg_managed','match_id','current_request_id','previous_match_id'])if(key in patch)deny('身份与周期字段不能直接修改');const next={...current,...patch,updated_at:now};await tx.put('assessments',found.id,next);return next;});
 }
 async function cases(principal){await member(principal);const filter=principal.role==='admin'?{}:{[principal.role==='visitor'?'visitor_id':'counselor_id']:principal.subject};const matches=await scan(C.matches,filter);const allIntakes=await scan('assessments',principal.role==='visitor'?{visitor_user_id:principal.subject}:{});const history=await scan(C.legacyRecords,principal.role==='admin'?{}:filter);const historyIds=new Set(history.filter(r=>r.assessment_id).map(r=>r.assessment_id));
  const intakes=allIntakes.filter(a=>principal.role==='admin'||a.migration_access!=='admin-review'&&(principal.role==='visitor'||a.match_request_cid===principal.subject||a.selected_counselor_id===principal.subject||historyIds.has(a.id)));
  return {matches:matches.map(m=>({match_id:m.match_id,assessment_id:m.assessment_id,status:m.status,opened_at:m.opened_at,closed_at:m.closed_at,last_session_no:m.last_session_no||0,closing_session_no:m.closing_session_no,visitor_id:m.visitor_id,counselor_id:m.counselor_id})),intakes:intakes.map(a=>({assessment_id:a.id,name:a.visitor_name||a.match_request_name||'',match_id:a.match_id||null,request_id:a.current_request_id||null,request_status:a.match_request_status||null,historical_only:a.historical_only===true,history_count:history.filter(r=>r.assessment_id===a.id&&require('./history').historyView(r,principal.role)).length,requires_identity_review:a.migration_access==='admin-review',created_at:a.created_at||null})),history_unlinked:principal.role==='admin'?history.filter(x=>!x.assessment_id).length:0};
 }
 async function context(principal,id){await member(principal);requireId(id,'assessment_id');const a=await source.get('assessments',id);if(!a)throw new AssessmentError('XG_NOT_FOUND','初评不存在',404);if(principal.role==='visitor'&&a.visitor_user_id!==principal.subject)deny();if(principal.role==='counselor'&&a.match_request_cid!==principal.subject)deny();const match=a.match_id?await assessment.getMatch(a.match_id):null;if(match)authorizeMatch(principal,match);return {assessment_id:id,match_id:match?.match_id||null,visitor_id:a.visitor_user_id,counselor_id:match?.counselor_id||a.match_request_cid||null,session_no:Math.max(1,match?.last_session_no||0),historical_only:!match};}
 return {db,source,scan,member,receipt,historyReceipt,createCounselor,createIntake,patchIntake,cases,context,identity,assessment,consent,provenance};
}
module.exports={createPortalRepository,UUID,vid};
