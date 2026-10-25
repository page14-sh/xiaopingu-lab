const { COLLECTIONS:C, AssessmentError, requireId, documentKey, assertScope, scopeOf } = require('./model');
const { requirePrincipal, deny } = require('./authorization');
const { requireMatch } = require('./event-storage');
const { contentHash } = require('./provenance');
const { weightsIn, validateOutput, DIMENSIONS } = require('./llm-contract');
const STATUSES=['pending','processing','retry_wait','blocked','failed','review_required','done','cancelled'];
function admin(principal){requirePrincipal(principal);if(principal.role!=='admin')deny();}
function revision(value){if(!Number.isSafeInteger(value)||value<0)throw new AssessmentError('XG_BAD_PARAM','修订号不合法',400);}
function reason(value){if(typeof value!=='string'||!value.trim()||value.length>500)throw new AssessmentError('XG_BAD_PARAM','须填写500字以内的审核原因',400);return value.trim();}
function conflict(){throw new AssessmentError('XG_LLM_CONFLICT','模型任务或审核依据已变化，请刷新',409);}
function publicJob(job){return Object.fromEntries(['job_id','event_id','match_id','status','generation','revision','attempts','total_attempts','model','prompt_version','created_at','updated_at','completed_at','next_attempt_at','recover_at','last_error'].map(k=>[k,job[k]??null]));}
function createLlmService(store,{now=Date.now}={}){
  const iso=()=>new Date(now()).toISOString();
  async function audit(tx,key,principal,record){if(await tx.get(C.llmAudit,key))conflict();await tx.put(C.llmAudit,key,{...record,actor_id:principal.subject,recorded_at:iso()});}
  return {
    async weights(principal,matchId){admin(principal);const match=await requireMatch(store,matchId),current=await weightsIn(store,match);return {match_id:matchId,weights:current.weights,revision:current.revision};},
    async setWeights(principal,matchId,input){
      admin(principal);revision(input.expected_revision);requireId(input.request_id,'request_id');const note=reason(input.reason);
      if(!input.weights||Object.getPrototypeOf(input.weights)!==Object.prototype||Object.keys(input.weights).length!==DIMENSIONS.length||
         DIMENSIONS.some(k=>!Number.isFinite(input.weights[k])||input.weights[k]<.1||input.weights[k]>2))throw new AssessmentError('XG_BAD_PARAM','辅助权重须为四个0.1至2之间的数值',400);
      return store.transaction(async tx=>{
        const match=await requireMatch(tx,matchId),current=await weightsIn(tx,match),id=documentKey('manual-weights',matchId,input.request_id);
        const fingerprint=contentHash({actor:principal.subject,...input,reason:note}),old=await tx.get(C.llmAudit,id);
        if(old){if(old.fingerprint!==fingerprint)conflict();return {match_id:matchId,revision:current.revision,weights:current.weights,duplicated:true};}
        if(current.revision!==input.expected_revision)conflict();
        const weights=Object.fromEntries(DIMENSIONS.map(k=>[k,input.weights[k]]));
        await tx.put(C.tagWeights,matchId,{...scopeOf(match),weights,revision:current.revision+1,proposal_id:null,approved_by:principal.subject,updated_at:iso()});
        await audit(tx,id,principal,{kind:'manual_weights',match_id:matchId,fingerprint,reason:note,previous_weights:current.weights,weights,previous_revision:current.revision,applied_revision:current.revision+1});
        return {match_id:matchId,revision:current.revision+1,weights,duplicated:false};
      });
    },
    async list(principal,{status,after,limit=50}={}){
      admin(principal);if(status!==undefined&&!STATUSES.includes(status)||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new AssessmentError('XG_BAD_PARAM','任务查询参数不合法',400);
      if(after!==undefined)requireId(after,'after');
      const rows=await store.llmJobsPage({status,after,limit});return {jobs:rows.map(publicJob),next_cursor:rows.length===limit?rows.at(-1)._id:null};
    },
    async detail(principal,id){
      admin(principal);requireId(id,'event_id');
      const job=await store.get(C.llmJobs,id);if(!job)throw new AssessmentError('XG_NOT_FOUND','模型任务不存在',404);
      const match=await requireMatch(store,job.match_id);assertScope(job,match);
      const proposal=await store.get(C.tagWeightProposals,documentKey(id,job.generation));assertScope(proposal,match);
      const result=await store.get(C.llmResults,id);assertScope(result,match);
      const weights=await weightsIn(store,match);
      return {job:publicJob(job),proposal:proposal?Object.fromEntries(['proposal_id','generation','adjustments','base_weight_revision','status','revision','reviewed_at','reviewed_by'].map(k=>[k,proposal[k]??null])):null,
        result_review:result?{generation:result.generation,status:result.review_status??'legacy',revision:result.review_revision??0}:null,
        weights:weights.weights,weight_revision:weights.revision};
    },
    async reviewWeights(principal,id,input){
      admin(principal);requireId(id,'proposal_id');revision(input.expected_revision);revision(input.expected_weight_revision);
      const note=reason(input.reason);if(!['approved','rejected'].includes(input.decision))throw new AssessmentError('XG_BAD_PARAM','审核决定不合法',400);
      return store.transaction(async tx=>{
        const proposal=await tx.get(C.tagWeightProposals,id);if(!proposal)throw new AssessmentError('XG_NOT_FOUND','权重建议不存在',404);
        const match=await requireMatch(tx,proposal.match_id);assertScope(proposal,match);
        const fingerprint=contentHash({actor:principal.subject,...input,reason:note});
        if(proposal.status!=='pending'){if(proposal.review_fingerprint===fingerprint)return {proposal_id:id,status:proposal.status,revision:proposal.revision,duplicated:true};conflict();}
        if(proposal.revision!==input.expected_revision)conflict();
        const current=await weightsIn(tx,match),job=await tx.get(C.llmJobs,proposal.event_id),result=await tx.get(C.llmResults,proposal.event_id);
        assertScope(job,match);assertScope(result,match);
        if(input.decision==='approved'){
          if(!job||job.status!=='done'||job.generation!==proposal.generation||result?.generation!==proposal.generation||
             !['validated','approved'].includes(result.review_status)||result.superseded||current.revision!==input.expected_weight_revision||current.revision!==proposal.base_weight_revision)conflict();
          const verified=validateOutput(JSON.stringify(Object.fromEntries(['summary','dim_scores','suggest_actions','tag_weight_adjust'].map(k=>[k,result[k]]))),result.available_dimensions);
          if(contentHash(proposal.adjustments)!==contentHash(verified.tag_weight_adjust))conflict();
          const weights={...current.weights};
          for(const change of proposal.adjustments){const value=Math.round((weights[change.tag]+change.delta)*10000)/10000;
            if(!Number.isFinite(value)||value<.1||value>2)throw new AssessmentError('XG_LLM_WEIGHT_RANGE','建议超出辅助权重范围，须重新审核',409);weights[change.tag]=value;}
          await tx.put(C.tagWeights,match.match_id,{...scopeOf(match),weights,revision:current.revision+1,proposal_id:id,approved_by:principal.subject,updated_at:iso()});
        }
        const next={...proposal,status:input.decision,revision:proposal.revision+1,reviewed_by:principal.subject,reviewed_at:iso(),review_fingerprint:fingerprint};
        await tx.put(C.tagWeightProposals,id,next);
        await audit(tx,documentKey('weights',id,next.revision),principal,{kind:'weights_review',match_id:match.match_id,proposal_id:id,decision:input.decision,reason:note,
          previous_weights:current.weights,previous_revision:current.revision,applied_revision:input.decision==='approved'?current.revision+1:null});
        return {proposal_id:id,status:next.status,revision:next.revision,duplicated:false};
      });
    },
    async reviewResult(principal,id,input){
      admin(principal);requireId(id,'event_id');revision(input.expected_revision);revision(input.generation);const note=reason(input.reason);
      if(!['approved','rejected'].includes(input.decision))throw new AssessmentError('XG_BAD_PARAM','审核决定不合法',400);
      return store.transaction(async tx=>{
        const result=await tx.get(C.llmResults,id),job=await tx.get(C.llmJobs,id);
        if(!result||!job)throw new AssessmentError('XG_NOT_FOUND','模型结果不存在',404);
        const match=await requireMatch(tx,job.match_id);assertScope(result,match);assertScope(job,match);
        const fingerprint=contentHash({actor:principal.subject,...input,reason:note});
        if(result.review_fingerprint===fingerprint)return {event_id:id,status:result.review_status,revision:result.review_revision,duplicated:true};
        if(result.generation!==input.generation||job.generation!==input.generation||result.review_revision!==input.expected_revision||result.superseded||!['done','review_required'].includes(job.status))conflict();
        // A rejected result cannot be restored by clicking approve; it needs a new generation.
        if(result.review_status==='rejected')conflict();
        const next={...result,review_status:input.decision,review_revision:result.review_revision+1,review_fingerprint:fingerprint};
        await tx.put(C.llmResults,id,next);
        if(input.decision==='rejected')await tx.put(C.llmJobs,id,{...job,status:'review_required',revision:job.revision+1,last_error:'XG_LLM_HUMAN_REJECTED',updated_at:iso()});
        await audit(tx,documentKey('result',id,result.generation,next.review_revision),principal,{kind:'result_review',match_id:match.match_id,event_id:id,generation:result.generation,decision:input.decision,reason:note});
        return {event_id:id,status:next.review_status,revision:next.review_revision,duplicated:false};
      });
    },
    async reprocess(principal,id,input){
      admin(principal);requireId(id,'event_id');requireId(input.request_id,'request_id');revision(input.expected_revision);const note=reason(input.reason);
      return store.transaction(async tx=>{
        const job=await tx.get(C.llmJobs,id);if(!job)throw new AssessmentError('XG_NOT_FOUND','模型任务不存在',404);
        const auditId=documentKey('llm-reprocess',id,input.request_id),fingerprint=contentHash({actor:principal.subject,...input,reason:note}),old=await tx.get(C.llmAudit,auditId);
        if(old){if(old.fingerprint!==fingerprint)conflict();return {job:publicJob(job),duplicated:true};}
        if(job.revision!==input.expected_revision||!['done','failed','review_required','blocked','cancelled'].includes(job.status))conflict();
        const match=await requireMatch(tx,job.match_id);assertScope(job,match);
        const next={...scopeOf(match),job_id:id,event_id:id,generation:job.generation+1,revision:job.revision+1,status:'pending',attempts:0,total_attempts:job.total_attempts,
          created_at:job.created_at,updated_at:iso(),next_attempt_at:iso()};
        const result=await tx.get(C.llmResults,id);assertScope(result,match);if(result)await tx.put(C.llmResults,id,{...result,superseded:true});
        await tx.put(C.llmJobs,id,next);
        await audit(tx,auditId,principal,{kind:'reprocess',match_id:match.match_id,event_id:id,generation:next.generation,reason:note,fingerprint,previous_status:job.status,previous_attempts:job.attempts});
        return {job:publicJob(next),duplicated:false};
      });
    }
  };
}
module.exports={createLlmService,STATUSES};
