function createHandler({dispatch,env=process.env}){return async event=>{
 if(env.XPG_FOLLOWUP_SCHEDULER_ENABLED!=='1')return {enabled:false,dispatched:false};
 if(event?.Type!=='Timer'||!env.XPG_FOLLOWUP_TRIGGER||event.TriggerName!==env.XPG_FOLLOWUP_TRIGGER)throw new Error('Unexpected scheduler trigger');
 // Dedicated service credentials and transactional followup job IDs provide auth/idempotency.
 // This adapter never calls notification delivery, dynamic refresh, or LLM endpoints.
 return dispatch({apiBase:env.XPG_API_BASE,secret:env.XPG_SCHEDULER_SECRET,jobType:'followup',limit:20,maxBatches:1});
};}
module.exports={createHandler};
