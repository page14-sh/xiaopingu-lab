const test=require('node:test');
const assert=require('node:assert/strict');
const {createHmac}=require('node:crypto');
const {createNotificationProvider,smsHeaders}=require('./notification-provider');
const {createSubscribeHandler}=require('../../../cloudfunctions/xg-subscribe-send/handler');
const secret='test-bridge-secret-only-'.repeat(3),now=Date.parse('2026-10-25T00:00:00Z'),id='a'.repeat(64);
function signed(patch={}){const payload=Buffer.from(JSON.stringify({request_id:id,issued_at:now,openid:'openid-test',templateId:'template-test',page:'pages/index/index',data:{thing1:{value:'有待查看的消息'}},miniprogramState:'formal',...patch})).toString('base64url');return{payload,signature:createHmac('sha256',secret).update(payload).digest('hex')};}
function bridgeFixture(send=async()=>({errCode:0})){const records=new Map();let calls=0;const store={async claim(key,hash){if(records.has(key))return records.get(key);records.set(key,{hash});return null;},async complete(key,hash,result){records.set(key,{hash,result});}};return{records,store,handler:createSubscribeHandler({secret,store,now:()=>now,send:async(body)=>{calls++;return send(body);}}),calls:()=>calls};}

test('T17 WeChat bridge authenticates the signed server envelope and caches one result per attempt',async()=>{
 const f=bridgeFixture();assert.equal((await f.handler({payload:'bad',signature:'0'.repeat(64)})).code,'BRIDGE_UNAUTHORIZED');
 assert.equal((await f.handler(signed({issued_at:now-60001}))).code,'BRIDGE_BAD_REQUEST');
 assert.equal((await f.handler(signed())).kind,'accepted');assert.equal((await f.handler(signed())).kind,'accepted');assert.equal(f.calls(),1);
 assert.equal((await f.handler(signed({openid:'other'}))).code,'BRIDGE_ID_CONFLICT');assert.equal(f.calls(),1);
});

test('T17 duplicate bridge invocation while send is pending cannot send twice',async()=>{
 let finish;const wait=new Promise(resolve=>{finish=resolve;});const f=bridgeFixture(async()=>{await wait;return{errCode:0};});
 const first=f.handler(signed());await Promise.resolve();assert.equal((await f.handler(signed())).kind,'unknown');finish();await first;assert.equal(f.calls(),1);
});

for(const [code,kind] of [[43101,'rejected'],[-1,'retryable'],[47003,'rejected']])test(`T17 WeChat bridge classifies explicit error ${code}`,async()=>{
 const f=bridgeFixture(async()=>{throw{errCode:code,errMsg:'secret provider data'};});const result=await f.handler(signed());assert.equal(result.kind,kind);assert.equal(JSON.stringify(result).includes('secret'),false);
});

test('T17 bridge commit failure retains uncertainty and does not replay the provider operation',async()=>{
 const f=bridgeFixture();f.store.complete=async()=>{throw new Error('failure');};assert.equal((await f.handler(signed())).code,'BRIDGE_COMMIT_UNKNOWN');
 assert.equal((await f.handler(signed())).code,'BRIDGE_PENDING');assert.equal(f.calls(),1);
});

test('T17 bridge never treats absent error code or malformed request as acceptance',async()=>{
 const f=bridgeFixture(async()=>({}));assert.equal((await f.handler(signed())).kind,'unknown');
 const disabled=createSubscribeHandler({store:f.store,send:async()=>{throw new Error('must not send');}});assert.equal((await disabled(signed())).code,'BRIDGE_NOT_CONFIGURED');
 assert.equal((await f.handler(signed({request_id:'bad'}))).kind,'rejected');
});

const wxOptions={bridgeSecret:secret,functionName:'xg-subscribe-send',appId:'wx-test',now:()=>now,
 templates:{followup:{templateId:'template-test',page:'pages/index/index',data:{thing1:{value:'随访填写提示'}}}}};
const wxInput={channel:'miniprogram',attempt_id:id,task:{kind:'followup'},recipient:{openid:'openid-test',appid:'wx-test'},safety:false};
test('T17 CloudRun provider sends only configured templates via authenticated bridge',async()=>{
 let request;const bridge=bridgeFixture();const provider=createNotificationProvider({...wxOptions,cloudbaseApp:{async callFunction(req){request=req;return{result:await bridge.handler(req.data)};}}});
 assert.equal((await provider.send(wxInput)).kind,'accepted');assert.equal(request.name,'xg-subscribe-send');
 const payload=JSON.parse(Buffer.from(request.data.payload,'base64url').toString());assert.equal(payload.openid,'openid-test');assert.equal('raw_answers' in payload,false);
 assert.equal((await provider.send({...wxInput,recipient:{openid:'x',appid:'wrong'}})).kind,'rejected');assert.equal(bridge.calls(),1);
});

test('T17 bridge timeout is unknown, never an automatic resend',async()=>{
 let calls=0;const provider=createNotificationProvider({...wxOptions,timeoutMs:5,cloudbaseApp:{callFunction(){calls++;return new Promise(()=>{});}}});
 assert.equal((await provider.send(wxInput)).kind,'unknown');assert.equal(calls,1);
});

const sms={secretId:'test-id',secretKey:'test-key',appId:'app-test',templateId:'tpl',signName:'测试签名',region:'ap-guangzhou',params:[]};
const smsInput={channel:'sms',attempt_id:id,task:{kind:'alert'},recipient:{phone_e164:'+8613800000000',phone_verified:true},safety:true};
test('T17 SMS uses signed 2021 API, correlates receipt and sends only safety notifications',async()=>{
 let count=0;
 const provider=createNotificationProvider({sms,now:()=>now,fetchImpl:async(url,opts)=>{count++;assert.equal(url,'https://sms.tencentcloudapi.com');assert.equal(opts.redirect,'error');assert.equal(opts.headers['X-TC-Version'],'2021-01-11');assert.match(opts.headers.Authorization,/TC3-HMAC-SHA256/);const body=JSON.parse(opts.body);assert.equal(body.SessionContext,id);assert.deepEqual(body.PhoneNumberSet,[smsInput.recipient.phone_e164]);return{json:async()=>({Response:{SendStatusSet:[{Code:'Ok',SerialNo:'sms-receipt',SessionContext:id,PhoneNumber:smsInput.recipient.phone_e164}]}})};}});
 const result=await provider.send(smsInput);assert.equal(result.kind,'accepted');assert.equal(result.provider_receipt_id,'sms-receipt');
 assert.equal((await provider.send({...smsInput,safety:false})).kind,'rejected');assert.equal(count,1);
 assert.equal((await provider.send({...smsInput,recipient:{...smsInput.recipient,phone_verified:false}})).kind,'rejected');assert.equal(count,1);
});

for(const [response,kind] of [
 [{Response:{Error:{Code:'RequestLimitExceeded'}}},'retryable'],[{Response:{Error:{Code:'AuthFailure.SecretIdNotFound'}}},'rejected'],
 [{Response:{Error:{Code:'InternalError'}}},'unknown'],[{},'unknown'],
 [{Response:{SendStatusSet:[{Code:'Ok',SerialNo:'wrong-correlated'}]}},'unknown']
])test(`T17 SMS classifies provider response as ${kind} ${JSON.stringify(response)}`,async()=>{
 const provider=createNotificationProvider({sms,fetchImpl:async()=>({json:async()=>response})});assert.equal((await provider.send(smsInput)).kind,kind);
});

test('T17 SMS exceptions and invalid configuration never leak response, address or secrets',async()=>{
 const provider=createNotificationProvider({sms,fetchImpl:async()=>{throw new Error('test-key +8613800000000');}});const result=await provider.send(smsInput);
 assert.equal(result.kind,'unknown');assert.equal(JSON.stringify(result).includes('test-key'),false);
 assert.equal((await createNotificationProvider().send(smsInput)).kind,'rejected');
});

test('T17 TC3 signing uses UTC date and binds the exact JSON payload',()=>{
 const time=Date.parse('2026-10-24T16:01:00Z'),a=smsHeaders(sms,'{"a":1}',time),b=smsHeaders(sms,'{"a":2}',time);
 assert.match(a.Authorization,/2026-10-24\/sms\/tc3_request/);assert.notEqual(a.Authorization,b.Authorization);assert.equal(a['content-type'],'application/json');assert.equal(a.host,'sms.tencentcloudapi.com');
});
