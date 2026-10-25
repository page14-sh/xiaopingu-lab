const {COLLECTIONS:C,AssessmentError,requireId}=require('./model');
const {requirePrincipal,deny}=require('./authorization');
const LEVELS=['safe','passive','active','action'];
function fromAnswers(answers){
 const level=answers?.crisis_screen;if(level===undefined)return null;
 if(!LEVELS.includes(level))throw new AssessmentError('XG_BAD_PARAM','准入筛查选项不合法',400);
 return level;
}
function blocked(record){return ['active','action'].includes(record?.crisis_level)||record?.xg_scope_status==='out_of_scope';}
async function ownedIntake(tx,assessmentId,visitorId){
 requireId(assessmentId,'assessment_id');const owner=await tx.get(C.intakes,assessmentId);
 if(!owner||owner.visitor_id!==visitorId)deny('须使用本人已验证身份下的评估记录，旧记录不能仅凭评估号绑定');
 const record=await tx.get('assessments',assessmentId);
 if(!record||record.visitor_user_id!==visitorId||record.xg_managed!==true)deny();return record;
}
async function requireAdmission(tx,assessmentId,visitorId){const record=await ownedIntake(tx,assessmentId,visitorId);if(blocked(record))throw new AssessmentError('XG_OUT_OF_SCOPE','当前情况不在本工具评估范围内，请优先联系专业人员核对后续安排',409);return record;}
function createAdmissionBridge(store,consent){return {async enter(principal,{asid}){
 requirePrincipal(principal);if(principal.role!=='visitor')deny();const record=await ownedIntake(store,asid,principal.subject);
 if(blocked(record))return {assessment_id:asid,out_of_scope:true,reason:'crisis_red_line',next_action:'out_of_scope',message:'当前情况不在本工具的评估范围内，建议优先进行医疗/精神科评估。'};
 const state=await consent.getStatus(principal.subject,'assessment');
 return {assessment_id:asid,out_of_scope:false,consent_required:!state.agreed,requires_match_approval:true,next_action:state.agreed?'match_approval':'consent'};
}};}
module.exports={fromAnswers,blocked,ownedIntake,requireAdmission,createAdmissionBridge};
