// Loopback-only UI for synthetic CloudBase preview accounts; never proxies production.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),config=require('../../specs/test-chain/config.json'),{provision}=require('./setup.cjs');
assert.equal(config.synthetic_only,true);assert.equal(config.prefix,'xg_preview_7d0a8e2622_');
const PORT=8796,ORIGIN='http://127.0.0.1:'+PORT,upstream=new URL(config.api_url);
function accounts(){const a=JSON.parse(fs.readFileSync(root+'/.private/test-chain/latest.json'));assert.equal(a.prefix,config.prefix);assert.equal(a.api_url,config.api_url);return a;}
function json(res,status,body){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));}
async function read(req){let size=0,chunks=[];for await(const c of req){size+=c.length;if(size>1024*1024)throw new Error('请求过大');chunks.push(c);}return Buffer.concat(chunks);}
async function api(route,body,token,method){const response=await fetch(upstream.origin+route,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(45000)});const data=await response.json();if(!response.ok)throw new Error(data.error?.message||data.message||'测试服务请求失败 HTTP '+response.status);return data;}
async function login(role){const a=accounts();if(role==='visitor')return {...await api('/auth/visitor-receipt',{credential:a.visitor.credential}),credential:a.visitor.credential};if(role==='counselor')return api('/auth/counselor',{credential:a.counselor.credential});if(role==='admin')return api('/auth/admin',{password:a.admin.password});throw new Error('未知测试角色');}
async function pending(){const a=accounts(),session=await login('visitor'),id=crypto.randomUUID();await api('/rest/v1/assessments',{id,view_token:id,client_claim_secret:a.visitor.credential,visitor_name:a.visitor.name,visitor_age:30,visitor_gender:'未填写',description:'合成初评，仅验证操作链路',score_mood:2,score_anxiety:1,score_sleep:1,score_function:1,score_relation:1,total_score:6,severity:'轻度',crisis_level:'safe'},session.token);
 await api('/rest/v1/assessments?id=eq.'+id,{match_request_cid:a.counselor.id,match_request_name:a.visitor.name,match_request_contact:'合成联调资料，无真实联系方式'},session.token,'PATCH');return {assessment_id:id,status:'pending'};}
function app(){return http.createServer(async(req,res)=>{try{
 if(req.headers.host!=='127.0.0.1:'+PORT){json(res,403,{message:'仅允许本机测试入口'});return;}
 const url=new URL(req.url,ORIGIN);
 if(url.pathname.startsWith('/__journey/')){
  if(req.headers.origin&&req.headers.origin!==ORIGIN||req.headers['sec-fetch-site']==='cross-site'){json(res,403,{message:'禁止跨站调用测试账号'});return;}
  if(url.pathname==='/__journey/info'&&req.method==='GET'){const a=accounts();json(res,200,{run_id:a.run_id,visitor:a.visitor.name,counselor:a.counselor.name,synthetic:true,prefix:config.prefix});return;}
  if(req.method!=='POST'||!(req.headers['content-type']||'').startsWith('application/json')){json(res,405,{message:'需要同源 JSON 请求'});return;}
  const body=JSON.parse((await read(req)).toString()||'{}');
  if(url.pathname==='/__journey/login')json(res,200,await login(body.role));
  else if(url.pathname==='/__journey/prepare')json(res,200,await pending());
  else if(url.pathname==='/__journey/new-run'){const a=await provision({fresh:true});json(res,200,{run_id:a.run_id});}
  else json(res,404,{message:'无此操作'});return;
 }
 if(url.pathname.startsWith('/api/')){
  const headers={};for(const [k,v]of Object.entries(req.headers))if(['authorization','content-type','prefer','x-assessment-token'].includes(k))headers[k]=v;
  const body=['GET','HEAD'].includes(req.method)?undefined:await read(req),r=await fetch(upstream.origin+url.pathname.slice(4)+url.search,{method:req.method,headers,...(body?{body}:{}),signal:AbortSignal.timeout(45000)});
  res.writeHead(r.status,{'Content-Type':r.headers.get('content-type')||'application/json','Cache-Control':'no-store'});res.end(Buffer.from(await r.arrayBuffer()));return;
 }
 let file=url.pathname==='/'||url.pathname==='/journey.html'?path.join(__dirname,'journey.html'):path.resolve(root+'/legacy-web','.'+url.pathname);
 if(file!==path.join(__dirname,'journey.html')&&!file.startsWith(root+'/legacy-web/')){json(res,404,{});return;}
 if(!fs.existsSync(file)||!fs.statSync(file).isFile()){json(res,404,{message:'页面不存在'});return;}
 let body=fs.readFileSync(file);
 if(file.endsWith('supabase-config.js')){const a=accounts();body=body.toString().replace(/url: '[^']+'/,'url: \''+ORIGIN+'/api\'')+'\nwindow.XPG_TEST_JOURNEY='+JSON.stringify({counselor_id:a.counselor.id,run_id:a.run_id})+';';}
 if(file.endsWith('.html'))body=body.toString().replace(/<body([^>]*)>/i,'<body$1><aside style="background:#fff4cc;color:#57471c;padding:10px 18px;position:relative;z-index:99999">独立联调测试区 · 仅合成数据 · 测试签署不产生真实服务关系 · <a href="/journey.html">切换测试身份 / 查看步骤</a></aside>');
 res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end(body);
 }catch(e){json(res,502,{message:e.code||e.message||'测试服务暂不可用'});}});}
if(require.main===module){accounts();app().listen(PORT,'127.0.0.1',()=>console.log('Synthetic CloudBase journey: '+ORIGIN+'/journey.html'));}
module.exports={app,pending,login};
