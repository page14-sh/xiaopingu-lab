// Legacy entry points remain available, but profile editing is not approval.
const PROFILE_FIELDS = new Set((`
name gender credential_level supervisor_cert extra_credentials years_experience education city license_number
approaches service_settings supervision_hours personal_therapy_hours personal_therapy_status therapy_cert
ethics_training certifications training_background specialties populations severity_levels client_gender_pref
client_age_prefs orientation_friendly gender_identity_friendly comm_styles cnip_styles cnip_emotion_focus
cnip_time cnip_stance cnip_homework cnip_relational session_formats session_duration fee_min fee_budget_level
available_slots contact_wechat contact_wechat_public contact_phone contact_phone_public contact_email
contact_email_public public_welfare bio_short bio_full has_violation violation_detail has_incident incident_detail
photo_url avatar_url photo_daily photo_license public_welfare_fee updated_at
`).trim().split(/\s+/));
const MATCH_REVIEW_FIELDS=new Set(['match_request_status','match_request_reviewed_note','match_request_reviewed_at','match_request_reviewed_by','updated_at']);
const VISITOR_MATCH_FIELDS=new Set(['selected_counselor_id','selected_counselor_name','selected_at','match_request_name','match_request_contact','match_request_cid','updated_at','visitor_name','score_mood','score_anxiety','score_sleep','score_function','score_relation','total_score','severity']);
function refuse(message){throw Object.assign(new Error(message),{statusCode:403});}
function profilePatch(patch,rows){
 if(Object.keys(patch).some(k=>!PROFILE_FIELDS.has(k)))refuse('资料编辑不能修改审批、启用状态或身份字段');
 const result={...patch};delete result.updated_at;
 if(rows.every(r=>r.review_status==='rejected'))Object.assign(result,{review_status:'pending',is_active:false});
 if('has_violation'in patch||'has_incident'in patch)result.needs_deep_review=rows.some(r=>(patch.has_violation??r.has_violation)==='是'||(patch.has_incident??r.has_incident)==='是');
 return result;
}
function mutationPatch(table,patch,rows,session){
 if(session?.role==='admin')return patch;
 if(table==='counselors')return profilePatch(patch,rows);
 if(table==='assessments'){
  const allowed=session?.role==='counselor'?MATCH_REVIEW_FIELDS:VISITOR_MATCH_FIELDS;
  if(Object.keys(patch).some(k=>!allowed.has(k)))refuse('该身份不能修改审批、身份归属或历史评估字段');
  if(session?.role==='counselor'){
   if('match_request_status'in patch&&!['approved','rejected','contacted'].includes(patch.match_request_status))refuse('匹配审批状态不合法');
   return {...patch,match_request_reviewed_by:session.subject,match_request_reviewed_at:new Date().toISOString()};
  }
  if(rows.some(r=>['active','action'].includes(r.crisis_level))&&Object.keys(patch).some(k=>k.startsWith('match_request_')||k.startsWith('selected_')))refuse('当前评估不开放咨询匹配，请按准入提示处理');
  // A changed application never inherits an earlier counselor's approval.
  return {...patch,...('match_request_cid'in patch?{match_request_status:'pending',match_request_reviewed_by:null,match_request_reviewed_at:null,match_request_reviewed_note:null}:{})};
 }
 // Generic PATCH must not move an authorized session/rating to another owner.
 if(Object.keys(patch).some(k=>['assessment_id','session_id','counselor_id','visitor_id','visitor_user_id','view_token','role','is_demo'].includes(k)))refuse('不能修改记录的身份归属');
 return patch;
}
module.exports={PROFILE_FIELDS,mutationPatch};
