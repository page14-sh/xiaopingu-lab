const {COLLECTIONS:C,RISK_SCALE:R,AssessmentError,scopeOf,assertScope}=require('./model');
async function stateIn(tx,match){const state=await tx.get(C.riskStates,match.match_id);assertScope(state,match);return state||{...scopeOf(match),revision:0,outcome_l3:{},closed_alert_ids:[],last_session:null,blocked:false};}
async function assertInScope(tx,match){const state=await stateIn(tx,match);if(state.blocked)throw new AssessmentError('XG_OUT_OF_SCOPE','当前周期已停止评估，请联系咨询师核对后续安排',409);return state;}
async function eligible(tx,match,session,policy){
 const state=await assertInScope(tx,match);const job=await tx.get(C.combinationJobs,match.match_id);if(job&&job.generation!==job.completed_generation)throw new AssessmentError('XG_COMBINATION_PENDING','请等待本周期结果更新后再获取风险卡',503);if(!policy||match.status!=='active'||session<1)return false;
 const closed=new Set(state.closed_alert_ids||[]);
 return Object.entries(state.outcome_l3||{}).some(([id,n])=>n<=session&&!closed.has(id))&&(state.last_session===null||session-state.last_session>=policy.cooldown_sessions);
}
async function requireRiskDue(tx,match,event){
 if(event.scale_code!==R)return;
 if(!await eligible(tx,match,event.session_no,event.basis?.rules.risk_recheck))throw new AssessmentError('XG_RISK_NOT_DUE','本周期本节尚不需要风险复查',409);
}
async function completeRisk(tx,match,event){
 if(event.scale_code!==R)return;const state=await stateIn(tx,match),policy=event.basis.rules.risk_recheck;
 await tx.put(C.riskStates,match.match_id,{...state,revision:state.revision+1,last_session:event.session_no,last_event_id:event.event_id,
   blocked:state.blocked||event.raw_answers.k1>=policy.urgent_min,blocked_reason:event.raw_answers.k1>=policy.urgent_min?'risk_recheck_red_line':state.blocked_reason||null,updated_at:event.submitted_at});
}
async function syncRiskTriggers(tx,match,results){
 // One cycle anchor serializes recomputation, closure and a new risk form.
 const state=await stateIn(tx,match);const active=Object.fromEntries(results.flatMap(r=>r.raw.signals.filter(s=>s.rule_id.startsWith('OUT-')&&s.level==='L3').map(s=>[s.signal_id,r.session_no])));
 if(JSON.stringify(state.outcome_l3)===JSON.stringify(active))return;
 await tx.put(C.riskStates,match.match_id,{...state,revision:state.revision+1,outcome_l3:active});
}
async function closeRiskTrigger(tx,match,alertId){const state=await stateIn(tx,match);if(!Object.hasOwn(state.outcome_l3,alertId)||state.closed_alert_ids.includes(alertId))return;
 await tx.put(C.riskStates,match.match_id,{...state,revision:state.revision+1,closed_alert_ids:[...state.closed_alert_ids,alertId]});}
module.exports={stateIn,assertInScope,eligible,requireRiskDue,completeRisk,syncRiskTriggers,closeRiskTrigger};
