const test=require('node:test');
const assert=require('node:assert/strict');
const {createLlmProvider,llmProviderFromEnvironment}=require('./llm-provider');
const {SYSTEM_PROMPT}=require('./llm-contract');
const config={baseUrl:'https://model.example.test/v1',apiKey:'synthetic-test-key',model:'test-model'};
const response=content=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}),{status:200});

test('T19 compatibility adapter uses configured HTTPS endpoint and sends only structured prompt',async()=>{
 let request;const provider=createLlmProvider({...config,fetchImpl:async(url,options)=>{request={url,options};return response('{"test":1}');}});
 assert.equal(await provider.generate({cards:[],available_dimensions:{ORS:false}}),'{"test":1}');
 assert.equal(request.url.toString(),'https://model.example.test/v1/chat/completions');assert.equal(request.options.redirect,'error');assert.equal(request.options.headers.authorization,'Bearer synthetic-test-key');
 const body=JSON.parse(request.options.body);assert.equal(body.model,'test-model');assert.equal(body.messages[0].content,SYSTEM_PROMPT);assert.deepEqual(JSON.parse(body.messages[1].content),{cards:[],available_dimensions:{ORS:false}});
 assert.equal(request.options.signal.aborted,false);
});

test('T19 adapter disables incomplete or unsafe configuration without making a request',()=>{
 for(const patch of [{baseUrl:undefined},{apiKey:''},{model:null},{baseUrl:'http://model.example.test'},{baseUrl:'https://user:password@model.example.test'},
   {baseUrl:'https://model.example.test?api_key=private'},{baseUrl:'https://model.example.test#secret'},{timeoutMs:9000},{apiKey:'key\r\nheader: value'}])assert.equal(createLlmProvider({...config,...patch}).ready,false);
 assert.equal(llmProviderFromEnvironment({}).ready,false);
});

for(const [status,code,retryable]of [[400,'XG_LLM_UPSTREAM_4XX',false],[401,'XG_LLM_UPSTREAM_4XX',false],[429,'XG_LLM_UPSTREAM_4XX',false],[500,'XG_LLM_UPSTREAM_5XX',true],[503,'XG_LLM_UPSTREAM_5XX',true]])test(`T19 provider HTTP ${status} classification never leaks body`,async()=>{
 const p=createLlmProvider({...config,fetchImpl:async()=>new Response('PRIVATE provider body key=secret',{status})});
 await assert.rejects(p.generate({}),e=>e.code===code&&e.retryable===retryable&&!/PRIVATE|secret/.test(e.message));
});

test('T19 adapter enforces whole-request timeout and sanitizes network failures',async()=>{
 const provider=createLlmProvider({...config,timeoutMs:100,fetchImpl:async(_url,{signal})=>new Promise((_resolve,reject)=>{
   // Keep the event loop alive independently of AbortSignal's unref timer.
   const timer=setTimeout(()=>reject(new Error('timeout not honored')),1000);
   signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('PRIVATE network address and key'));},{once:true});
 })});
 await assert.rejects(provider.generate({}),{code:'XG_LLM_TIMEOUT',retryable:true});
 const network=createLlmProvider({...config,fetchImpl:async()=>{throw new Error('PRIVATE network URL');}});
 await assert.rejects(network.generate({}),e=>e.code==='XG_LLM_NETWORK'&&!e.message.includes('PRIVATE'));
});

test('T19 adapter rejects oversized, malformed and truncated responses',async()=>{
 for(const [body,code]of [['x'.repeat(65537),'XG_LLM_RESPONSE_TOO_LARGE'],['not json','XG_LLM_INVALID_JSON'],
   [JSON.stringify({choices:[{finish_reason:'length',message:{content:'{}'}}]}),'XG_LLM_INVALID_OUTPUT'],['{}','XG_LLM_INVALID_OUTPUT']]){
   const p=createLlmProvider({...config,fetchImpl:async()=>new Response(body)});await assert.rejects(p.generate({}),{code,retryable:true});
 }
});
