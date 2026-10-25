const { SYSTEM_PROMPT } = require('./llm-contract');
class LlmProviderError extends Error {
  constructor(code,retryable=false){super('LLM provider request failed');this.code=code;this.retryable=retryable;}
}
function createLlmProvider({baseUrl,apiKey,model,timeoutMs=8000,fetchImpl=fetch}={}) {
  if (!baseUrl || !apiKey || !model) return {ready:false};
  let url;
  try {
    url=new URL(baseUrl);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||typeof apiKey!=='string'||/[\r\n]/.test(apiKey)||
       typeof model!=='string'||!model.trim()||model.length>128||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>8000)throw new Error();
    url.pathname=url.pathname.replace(/\/$/,'')+'/chat/completions';
  } catch { return {ready:false,configuration_error:'XG_LLM_CONFIG_INVALID'}; }
  return {ready:true,model,async generate(payload){
    const signal=AbortSignal.timeout(timeoutMs);
    try {
      const response=await fetchImpl(url,{method:'POST',redirect:'error',signal,headers:{'content-type':'application/json',authorization:`Bearer ${apiKey}`},
        body:JSON.stringify({model,temperature:0,messages:[{role:'system',content:SYSTEM_PROMPT},{role:'user',content:JSON.stringify(payload)}]})});
      if(!response.ok)throw new LlmProviderError(response.status>=500?'XG_LLM_UPSTREAM_5XX':'XG_LLM_UPSTREAM_4XX',response.status>=500);
      // Bound the streamed body before JSON parsing; never retain/log provider bodies.
      let size=0;const chunks=[];
      for await(const chunk of response.body){size+=chunk.length;if(size>65536)throw new LlmProviderError('XG_LLM_RESPONSE_TOO_LARGE',true);chunks.push(Buffer.from(chunk));}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new LlmProviderError('XG_LLM_INVALID_JSON',true);}
      const choice=body?.choices?.[0];
      if(choice?.finish_reason!=='stop'||typeof choice?.message?.content!=='string')throw new LlmProviderError('XG_LLM_INVALID_OUTPUT',true);
      return choice.message.content;
    }catch(error){
      if(error instanceof LlmProviderError)throw error;
      throw new LlmProviderError(signal.aborted?'XG_LLM_TIMEOUT':'XG_LLM_NETWORK',true);
    }
  }};
}
function llmProviderFromEnvironment(env=process.env){return createLlmProvider({baseUrl:env.XG_LLM_BASE_URL,apiKey:env.XG_LLM_API_KEY,model:env.XG_LLM_MODEL});}
module.exports={createLlmProvider,llmProviderFromEnvironment,LlmProviderError};
