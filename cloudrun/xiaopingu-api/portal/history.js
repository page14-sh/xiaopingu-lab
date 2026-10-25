const {COLLECTIONS:C,SCALES:S,AssessmentError,requireId}=require('../assessment/model');
const {deny}=require('../assessment/authorization');
const META=['id','created_at','started_at','submitted_at','updated_at','scale_code','session_no','follow_round','status','quality_flag'];
function pick(raw,fields){return Object.fromEntries(fields.filter(k=>Object.hasOwn(raw,k)).map(k=>[k,raw[k]]));}
function historyView(row,role){
 const raw=JSON.parse(row.raw_json),source=row.source_collection;
 if(role==='visitor'&&(['xg_alerts','xg_llm_jobs','xg_llm_results','xg_tag_weights','counselors','visitor_users','xg_config','xg_scale_items','xg_scales','xg_case_switch'].includes(source)||source==='xg_assessment_events'&&raw.scale_code===S.pro))return null;
 const professional=role!=='visitor';let data=pick(raw,META);
 if(source==='assessments')data={...data,...pick(raw,['visitor_name','visitor_age','visitor_gender','created_at','total_score','severity','match_request_status'])};
 if(source==='xg_assessment_events'&&professional){if(role==='admin'||raw.scale_code!==S.evaluation)Object.assign(data,pick(raw,['total','pct','ors_total','add_total','supp_total','resource_total']));if(role==='admin'||[S.feel,S.pro].includes(raw.scale_code))Object.assign(data,pick(raw,['raw_answers']));}
 if(source==='xg_baseline_profile'&&professional)Object.assign(data,pick(raw,['state_total','state_total_recheck','ors_total','supp_total','resource_total','baseline_source','focus_text']));
 if(source==='xg_end_profile'){Object.assign(data,pick(raw,['closed_at','follow_1m_due_at','follow_3m_due_at','follow_1m_result','follow_3m_result']));if(professional)Object.assign(data,pick(raw,['end_total','supp_end_total','follow_1m_total','follow_3m_total','supp_follow_1m_total','supp_follow_3m_total']));}
 if(source==='sessions')Object.assign(data,pick(raw,professional?['session_number','session_date','notes']:['session_number','session_date']));
 if(source==='pcoms_ratings'){Object.assign(data,pick(raw,['type']));if(professional)Object.assign(data,pick(raw,['total_score','item_individual','item_interpersonal','item_social','item_overall','clinical_change','notes']));}
 if(source==='xg_alerts'&&professional)Object.assign(data,pick(raw,['alert_type','alert_level','severity','triggered_at','handled_at','cst_step','cst_note','detail']));
 if(source==='xg_consent')Object.assign(data,pick(raw,['scope','version','agreed_at','revoked_at','channel']));
 if(source==='xg_llm_jobs'&&role==='admin')Object.assign(data,pick(raw,['attempts']));
 if(source==='counselors'&&role==='admin')Object.assign(data,pick(raw,['name','review_status','is_active']));
 if(source==='visitor_users'&&role==='admin')Object.assign(data,pick(raw,['source','last_login_at']));
 return {archive_id:row.archive_id,source_collection:source,source_hash:row.source_hash,assessment_id:row.assessment_id||null,link_status:row.link_status,link_reason:row.link_reason,legacy_only:true,scoring_basis:'historical_original_not_recomputed',data};
}
async function history(portal,principal,{assessment_id,source,after,limit=50}={}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new AssessmentError('XG_BAD_PARAM','分页不合法',400);
 if(assessment_id)requireId(assessment_id,'assessment_id');if(after)requireId(after,'after');
 if(principal.role!=='admin'&&!assessment_id)deny('请选择有权查看的初评');
 const filter={...(assessment_id?{assessment_id}:{}),...(source?{source_collection:source}:{}),...(principal.role==='visitor'?{visitor_id:principal.subject}:principal.role==='counselor'?{counselor_id:principal.subject}:{})};
 const all=await portal.scan(C.legacyRecords,filter),visible=all.map(r=>({id:r._id||r.archive_id,view:historyView(r,principal.role)})).filter(r=>r.view&&(!after||r.id>after)).sort((a,b)=>a.id.localeCompare(b.id));const page=visible.slice(0,limit);
 return {items:page.map(r=>r.view),next_cursor:visible.length>limit?page.at(-1).id:null,legacy_only:true};
}
module.exports={history,historyView};
