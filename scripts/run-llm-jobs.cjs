// Platform scheduler entry; no resident timers and no model credentials in logs.
async function dispatchLlm({apiBase,secret,mode='run',limit=mode==='run'?5:50,maxBatches=10,fetchImpl=fetch}) {
  let base;try{base=new URL(apiBase);}catch{throw new Error('Invalid scheduler endpoint');}
  if((base.protocol!=='https:'&&!(base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname)))||base.username||base.password||base.search||base.hash||
    typeof secret!=='string'||Buffer.byteLength(secret)<32||!['run','recover'].includes(mode)||!Number.isSafeInteger(limit)||limit<1||limit>(mode==='run'?5:100)||
    !Number.isSafeInteger(maxBatches)||maxBatches<1||maxBatches>20)throw new Error('Invalid scheduler configuration');
  const summary={batches:0,scanned:0,done:0,pending:0,retry_wait:0,blocked:0,failed:0,review_required:0,cancelled:0,errors:0,configured:true,more_possible:false};
  for(let n=0;n<maxBatches;n++){
    let response;try{response=await fetchImpl(new URL(`/v1/xg/jobs/llm-${mode}`,base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(60000),headers:{'content-type':'application/json',authorization:`Bearer ${secret}`},body:JSON.stringify({limit})});}
    catch{throw new Error('LLM scheduler request failed');}
    if(!response.ok)throw new Error(`LLM scheduler HTTP ${response.status}`);
    const data=await response.json();if(!Number.isSafeInteger(data.scanned)||!Array.isArray(data.results)||!Array.isArray(data.errors))throw new Error('Invalid scheduler response');
    summary.batches++;summary.scanned+=data.scanned;summary.errors+=data.errors.length;summary.more_possible=data.more_possible===true;summary.configured=data.configured!==false;
    for(const result of data.results)if(['done','pending','retry_wait','blocked','failed','review_required','cancelled'].includes(result.status))summary[result.status]++;
    if(summary.errors||!summary.more_possible||!summary.configured)break;
  }
  return summary;
}
if(require.main===module)dispatchLlm({apiBase:process.env.XPG_API_BASE,secret:process.env.XPG_SCHEDULER_SECRET,mode:process.argv[2]||'run'})
  .then(summary=>{console.log(JSON.stringify(summary));if(summary.errors||summary.failed||summary.review_required||summary.more_possible||!summary.configured)process.exitCode=1;})
  .catch(()=>{console.error('LLM scheduler failed; inspect configuration and retry.');process.exitCode=1;});
module.exports={dispatchLlm};
