// Fixed demo identities share the production entry, but every demo request stays
// on the isolated preview API. A routing prefix never grants authorization:
// the preview backend verifies the underlying signed token and role as usual.
const crypto=require('node:crypto');
const TARGET='https://xiaopingu-assessment-preview-308810-6-1300577165.sh.run.tcloudbase.com';
const PREFIX='xpgdemo.';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'authorization,apikey,content-type,prefer,x-assessment-token','Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Authorization'};
function configFromEnv(env){
 if(!env.XPG_DEMO_ACCOUNTS_JSON)return null;
 if(env.XPG_DEPLOYMENT_MODE!=='production'||env.XPG_COLLECTION_PREFIX!=='xg_v2_59875df34c_')throw Error('Demo router requires the configured production entry');
 const a=JSON.parse(env.XPG_DEMO_ACCOUNTS_JSON);
 if(a.backend?.api_url!==TARGET||a.backend?.prefix!=='xg_preview_7d0a8e2622_'||a.backend?.synthetic!==true)throw Error('Demo credentials must use the isolated preview');
 return a;
}
function valid(a,b){if(!b||!['visitor','counselor','admin'].includes(b.role)||b.username!==a.usernames[b.role]||typeof b.password!=='string'||b.password.length>256)return false;const actual=crypto.scryptSync(b.password,a.salt,64),expected=Buffer.from(a.password_hash,'hex');return expected.length===actual.length&&crypto.timingSafeEqual(actual,expected);}
async function read(req){let n=0,chunks=[];for await(const c of req){n+=c.length;if(n>1024*1024)throw Error('body size');chunks.push(c);}return Buffer.concat(chunks);}
function createDemoRouter({accounts:a,next,fetchImpl=fetch}){
 let attempts=0,start=Date.now();const failures=new Map();
 const reply=(res,status,data)=>{res.writeHead(status,cors);res.end(JSON.stringify(data));};
 return async(req,res)=>{
  const url=new URL(req.url,'http://internal'),login=url.pathname==='/auth/account',auth=req.headers.authorization||'',demo=auth.startsWith('Bearer '+PREFIX);
  if(!login&&!demo)return next(req,res);
  if(req.method==='OPTIONS'){res.writeHead(204,cors);res.end();return;}
  if(!a)return reply(res,404,{message:'演示账号尚未启用'});
  try{
   let route=url.pathname+url.search,body,headers={'Content-Type':'application/json'};
   if(login){
    if(req.method!=='POST'||!(req.headers['content-type']||'').startsWith('application/json'))return reply(res,400,{message:'请提交账号和密码'});
    if(Date.now()-start>=60000){attempts=0;failures.clear();start=Date.now();}
    if(++attempts>60)return reply(res,429,{message:'登录尝试过多，请一分钟后重试'});
    let input;try{input=JSON.parse((await read(req)).toString());}catch{return reply(res,400,{message:'请求格式不正确'});}
    const key=['visitor','counselor','admin'].includes(input.role)?input.role:'invalid';
    if((failures.get(key)||0)>=10)return reply(res,429,{message:'登录尝试过多，请一分钟后重试'});
    if(!valid(a,input)){failures.set(key,(failures.get(key)||0)+1);return reply(res,401,{message:'账号或密码不正确'});}
    route=input.role==='visitor'?'/auth/visitor-receipt':input.role==='counselor'?'/auth/counselor':'/auth/admin';
    body=JSON.stringify(input.role==='admin'?{password:a.backend.admin.password}:{credential:a.backend[input.role].credential});
    const upstream=await fetchImpl(TARGET+route,{method:'POST',redirect:'error',headers,body,signal:AbortSignal.timeout(30000)}),result=await upstream.json();
    if(upstream.ok){result.token=PREFIX+result.token;result.account_username=input.username;result.demo_account=true;if(input.role==='visitor')result.client_credential=a.backend.visitor.credential;}
    return reply(res,upstream.status,result);
   }
   if(!(/^\/(auth\/|rest\/v1\/|v1\/xg\/)/.test(url.pathname)||['/resolve','/xg/counselor-context'].includes(url.pathname)))return reply(res,404,{message:'Not found'});
   // Copy only application headers. Never forward cloud runtime credentials.
   for(const [k,v] of Object.entries(req.headers))if(['content-type','prefer','x-assessment-token'].includes(k))headers[k]=v;
   headers.authorization='Bearer '+auth.slice(('Bearer '+PREFIX).length);
   if(!['GET','HEAD'].includes(req.method))body=await read(req);
   const upstream=await fetchImpl(TARGET+route,{method:req.method,redirect:'error',headers,...(body?{body}:{}),signal:AbortSignal.timeout(45000)});
   let result=await upstream.json();
   if(upstream.ok&&url.pathname.startsWith('/auth/')&&typeof result.token==='string')result.token=PREFIX+result.token;
   // Demo sessions read the preview catalogue, which mirrors the real counselor
   // pool as a sanitised copy (no phone/email/wechat/licence/edit token), so the
   // demo shows realistic data while every write stays inside the preview island.
   return reply(res,upstream.status,result);
  }catch{return reply(res,502,{message:'演示服务暂不可用，请稍后重试'});}
 };
}
module.exports={createDemoRouter,configFromEnv,PREFIX,TARGET};
