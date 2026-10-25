const {assertInScope}=require('./risk-recheck');
const { randomUUID } = require('node:crypto');
const { COLLECTIONS:C, AssessmentError, requireId, assertScope, scopeOf, documentKey } = require('./model');
const { createConsentRepository, scopeForCard } = require('./consent');
const { requireCollectionOpen } = require('./rollout');
const { contentHash, verifyEventBasis } = require('./provenance');
const { sourceIn, buildSnapshot, validateOutput, PROMPT_VERSION } = require('./llm-contract');
const RETRYABLE = new Set(['XG_LLM_UPSTREAM_5XX','XG_LLM_TIMEOUT','XG_LLM_NETWORK','XG_LLM_INVALID_JSON','XG_LLM_INVALID_OUTPUT','XG_LLM_RESPONSE_TOO_LARGE','XG_LLM_LEASE_EXPIRED']);
const BLOCKED = new Set(['XG_OUT_OF_SCOPE','XG_CONSENT_REQUIRED','XG_CONSENT_NOT_CONFIGURED','XG_CONSENT_POLICY_INVALID','XG_COLLECTION_PAUSED','XG_LLM_CONSENT_CHANGED','XG_FORBIDDEN']);
const SAFE_CODES = new Set([...RETRYABLE,...BLOCKED,'XG_LLM_UPSTREAM_4XX','XG_LLM_UNSAFE_OUTPUT','XG_LLM_INELIGIBLE','XG_SCOPE_MISMATCH','XG_LLM_SOURCE_INVALID','XG_LLM_MODEL_CHANGED','XG_LLM_INTERNAL']);
const safeCode = error => SAFE_CODES.has(error?.code) ? error.code : 'XG_LLM_INTERNAL';
function nextRecovery(time){const day=86400000,zone=8*3600000;let target=Math.floor((time+zone)/day)*day-zone+4*3600000;if(target<=time)target+=day;return new Date(target).toISOString();}
const jobView = j => ({job_id:j.job_id,status:j.status,generation:j.generation,revision:j.revision,attempts:j.attempts});
function createLlmWorker(store,{provider={ready:false},now=Date.now,leaseMs=30000}={}) {
  if(!Number.isSafeInteger(leaseMs)||leaseMs<10000||leaseMs>300000)throw new Error('Invalid LLM lease');
  const iso=()=>new Date(now()).toISOString(),consent=createConsentRepository(store);
  async function guard(tx,job,{finish=false}={}) {
    const {event,match}=await sourceIn(tx,job.event_id);assertScope(job,match);
    await assertInScope(tx,match);
    await requireCollectionOpen(tx);
    const ref=await consent.requireInTransaction(tx,match.visitor_id,scopeForCard(event.scale_code));
    if(finish&&contentHash(ref)!==contentHash(job.consent_ref))throw new AssessmentError('XG_LLM_CONSENT_CHANGED','同意状态已变化');
    if(job.snapshot) {
      if(job.snapshot.input_hash!==contentHash(job.snapshot.payload))throw new AssessmentError('XG_LLM_SOURCE_INVALID','模型输入快照不一致');
      for(const source of job.snapshot.sources){
        const row=await tx.get(C.events,source.event_id);assertScope(row,match);
        if(!row||row.status!=='submitted'||row.quality_flag!=='ok'||row.basis?.basis_hash!==source.basis_hash)throw new AssessmentError('XG_LLM_SOURCE_INVALID','模型依据不一致');
        verifyEventBasis(row);
      }
    }
    return {event,match,ref};
  }
  async function failIn(tx,job,attempt,error) {
    const code=safeCode(error),retryable=RETRYABLE.has(code),time=now();
    let status,next_attempt_at=null,recover_at=null;
    if(BLOCKED.has(code)){status=job.attempts>=5?'review_required':'blocked';if(status==='blocked')next_attempt_at=new Date(time+60000).toISOString();}
    else if(code==='XG_LLM_INELIGIBLE'){status='cancelled';}
    else if(code==='XG_LLM_UNSAFE_OUTPUT'||code==='XG_SCOPE_MISMATCH'||code==='XG_LLM_SOURCE_INVALID'){status='review_required';}
    else if(retryable&&job.attempts<3){status='retry_wait';next_attempt_at=new Date(time+(job.attempts===1?1000:4000)).toISOString();}
    else if(retryable&&job.attempts===3){status='failed';recover_at=nextRecovery(time);}
    else if(retryable&&job.attempts===4){status='retry_wait';next_attempt_at=new Date(time+4000).toISOString();}
    else status=retryable?'review_required':'failed';
    const next={...job,status,revision:job.revision+1,updated_at:iso(),last_error:code,next_attempt_at,recover_at,recovery_eligible:!!recover_at,lease_token:null,lease_until:null};
    if(attempt)await tx.put(C.llmAttempts,attempt.attempt_id,{...attempt,status:'failed',error_code:code,finished_at:iso()});
    await tx.put(C.llmJobs,job.job_id,next);return jobView(next);
  }
  async function claim(id) {
    requireId(id,'event_id');
    if(provider.ready!==true)return {job_id:id,status:'unconfigured'};
    return store.transaction(async tx=>{
      let job=await tx.get(C.llmJobs,id);
      if(!job||job.job_id!==id||job.event_id!==id)throw new AssessmentError('XG_NOT_FOUND','模型任务不存在',404);
      if(['done','failed','review_required','cancelled'].includes(job.status))return jobView(job);
      if(job.status==='processing'){
        if(Date.parse(job.lease_until)>now())return {job_id:id,status:'busy'};
        const attempt=await tx.get(C.llmAttempts,job.attempt_id);
        return failIn(tx,job,attempt,{code:'XG_LLM_LEASE_EXPIRED'});
      }
      if(!['pending','retry_wait','blocked'].includes(job.status)||!Number.isSafeInteger(job.attempts)||job.attempts<0||job.attempts>=5)throw new AssessmentError('XG_LLM_SOURCE_INVALID','模型任务状态异常',503);
      if(job.next_attempt_at&&Date.parse(job.next_attempt_at)>now())return {job_id:id,status:'not_due'};
      if(job.model&&(job.model!==provider.model||job.prompt_version!==PROMPT_VERSION))return failIn(tx,job,null,{code:'XG_LLM_MODEL_CHANGED'});
      let source;
      try{source=await guard(tx,job);}catch(error){if(!SAFE_CODES.has(error.code))throw error;return failIn(tx,job,null,error);}
      const snapshot=job.snapshot||await buildSnapshot(tx,source.event,source.match);
      const number=job.attempts+1,attempt_id=documentKey(id,job.generation,number),lease_token=randomUUID();
      const next={...job,status:'processing',revision:job.revision+1,attempts:number,total_attempts:job.total_attempts+1,
        snapshot,consent_ref:source.ref,model:provider.model,prompt_version:PROMPT_VERSION,attempt_id,lease_token,
        lease_until:new Date(now()+leaseMs).toISOString(),next_attempt_at:new Date(now()+leaseMs).toISOString(),recover_at:null,updated_at:iso()};
      await tx.put(C.llmAttempts,attempt_id,{...scopeOf(source.match),attempt_id,job_id:id,generation:job.generation,number,
        model:provider.model,prompt_version:PROMPT_VERSION,input_hash:snapshot.input_hash,status:'processing',started_at:iso()});
      await tx.put(C.llmJobs,id,next);
      return {job_id:id,status:'claimed',generation:job.generation,attempt_id,lease_token,payload:snapshot.payload};
    });
  }
  async function finish(claimed,{raw,error}={}) {
    return store.transaction(async tx=>{
      const job=await tx.get(C.llmJobs,claimed.job_id);
      if(!job||job.status!=='processing'||job.generation!==claimed.generation||job.lease_token!==claimed.lease_token)return {job_id:claimed.job_id,status:'stale_lease'};
      const attempt=await tx.get(C.llmAttempts,claimed.attempt_id);
      if(!attempt||attempt.job_id!==job.job_id||attempt.generation!==job.generation)throw new AssessmentError('XG_LLM_SOURCE_INVALID','模型尝试记录不一致',503);
      if(Date.parse(job.lease_until)<=now())return failIn(tx,job,attempt,{code:'XG_LLM_LEASE_EXPIRED'});
      let source,output;
      try{source=await guard(tx,job,{finish:true});if(error)throw error;output=validateOutput(raw,job.snapshot.payload.available_dimensions);}
      catch(problem){if(!SAFE_CODES.has(problem.code))throw problem;return failIn(tx,job,attempt,problem);}
      const history_id=documentKey(job.event_id,job.generation);
      if(await tx.get(C.llmHistory,history_id))throw new AssessmentError('XG_LLM_SOURCE_INVALID','该版本结果已存在',503);
      const result={...scopeOf(source.match),event_id:job.event_id,generation:job.generation,...output,model:job.model,prompt_version:job.prompt_version,
        schema_version:'llm-t19-v1',input_hash:job.snapshot.input_hash,available_dimensions:job.snapshot.payload.available_dimensions,
        weight_revision:job.snapshot.weight_revision,review_status:'validated',review_revision:0,scored_at:iso()};
      await tx.put(C.llmHistory,history_id,result);
      await tx.put(C.llmResults,job.event_id,result);
      if(output.tag_weight_adjust.length)await tx.put(C.tagWeightProposals,history_id,{...scopeOf(source.match),proposal_id:history_id,event_id:job.event_id,
        generation:job.generation,adjustments:output.tag_weight_adjust,base_weight_revision:job.snapshot.weight_revision,status:'pending',revision:0,created_at:iso()});
      await tx.put(C.llmAttempts,attempt.attempt_id,{...attempt,status:'done',finished_at:iso()});
      const next={...job,status:'done',revision:job.revision+1,updated_at:iso(),completed_at:iso(),last_error:null,next_attempt_at:null,recover_at:null,lease_token:null,lease_until:null};
      await tx.put(C.llmJobs,job.job_id,next);return jobView(next);
    });
  }
  async function processTask(id){
    const claimed=await claim(id);if(claimed.status!=='claimed')return claimed;
    let raw,error;
    try{raw=await provider.generate(claimed.payload);}catch(problem){error={code:safeCode(problem)};}
    // Persistence failure must not be reclassified as a model error. The lease
    // recovery path owns it; successful answer submission is already committed.
    return finish(claimed,{raw,error});
  }
  async function runBatch({limit=5}={}){
    if(!Number.isSafeInteger(limit)||limit<1||limit>5)throw new AssessmentError('XG_BAD_PARAM','模型批量须为1至5',400);
    if(provider.ready!==true)return {configured:false,configuration_error:provider.configuration_error||null,scanned:0,results:[],errors:[],more_possible:false};
    const rows=await store.dueLlmJobs(iso(),limit),results=[],errors=[];
    for(const row of rows){try{results.push(await processTask(row._id));}catch(error){errors.push({job_id:row._id,code:safeCode(error)});}}
    return {configured:true,scanned:rows.length,results,errors,more_possible:rows.length===limit};
  }
  async function recover({limit=50}={}){
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new AssessmentError('XG_BAD_PARAM','恢复批量须为1至100',400);
    const rows=await store.recoverableLlmJobs(iso(),limit),results=[],errors=[];
    for(const row of rows){try{results.push(await store.transaction(async tx=>{
      const job=await tx.get(C.llmJobs,row._id);
      if(!job||job.status!=='failed'||!job.recover_at||Date.parse(job.recover_at)>now()||job.attempts>=5||!RETRYABLE.has(job.last_error))return {job_id:row._id,status:'skipped'};
      const next={...job,status:'pending',revision:job.revision+1,updated_at:iso(),recover_at:null,recovery_eligible:false,next_attempt_at:iso()};
      await tx.put(C.llmJobs,job.job_id,next);return jobView(next);
    }));}catch(error){errors.push({job_id:row._id,code:safeCode(error)});}}
    return {scanned:rows.length,results,errors,more_possible:rows.length===limit};
  }
  return {claim,finish,processTask,runBatch,recover};
}
module.exports={createLlmWorker,nextRecovery,jobView};
