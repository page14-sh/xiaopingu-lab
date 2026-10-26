// The original platform UI and real preview API, with fixed demo account login.
// No generated intake, approval, or card endpoints are exposed here.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {verifyAccount}=require('./platform-auth.cjs');
const root=path.resolve(__dirname,'../..'),config=require('../../specs/test-chain/config.json'),PORT=process.env.XPG_DEMO_VERIFY==='1'?8797:8796,ORIGIN='http://127.0.0.1:'+PORT;
assert.equal(config.prefix,'xg_preview_7d0a8e2622_');assert.equal(config.synthetic_only,true);
function accounts(){const a=JSON.parse(fs.readFileSync(root+'/.private/test-chain/'+(PORT===8797?'platform-verify-accounts':'platform-accounts')+'.json'));assert.equal(a.backend.prefix,config.prefix);assert.equal(a.backend.api_url,config.api_url);return a;}
function json(res,status,body){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));}
async function body(req){let size=0,parts=[];for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw Error('请求过大');parts.push(chunk);}return Buffer.concat(parts);}
function app(){return http.createServer(async(req,res)=>{try{
 if(req.headers.host!=='127.0.0.1:'+PORT)return json(res,403,{message:'仅允许本机演示平台入口'});
 const url=new URL(req.url,ORIGIN);
 if(url.pathname==='/journey.html'){res.writeHead(302,{Location:'/', 'Cache-Control':'no-store'});res.end();return;}
 if(url.pathname.startsWith('/__journey/'))return json(res,410,{message:'流程演示工具已停用，请使用平台原页面登录操作'});
 if(url.pathname==='/api/auth/account'){
  if(req.method!=='POST'||!(req.headers['content-type']||'').startsWith('application/json')||req.headers.origin&&req.headers.origin!==ORIGIN||req.headers['sec-fetch-site']==='cross-site')return json(res,403,{message:'请从平台登录表单提交'});
  const data=JSON.parse((await body(req)).toString()||'{}'),a=accounts();if(!verifyAccount(a,data))return json(res,401,{message:'账号或密码不正确'});
  const role=data.role,route=role==='visitor'?'/auth/visitor-receipt':role==='counselor'?'/auth/counselor':'/auth/admin';
  const input=role==='admin'?{password:a.backend.admin.password}:{credential:a.backend[role].credential};
  const r=await fetch(config.api_url+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(30000)});const output=await r.json();
  if(r.ok&&role==='visitor')output.client_credential=a.backend.visitor.credential;
  if(r.ok)output.account_username=data.username;
  return json(res,r.status,output);
 }
 if(url.pathname.startsWith('/api/')){
  const headers={};for(const [k,v]of Object.entries(req.headers))if(['authorization','content-type','prefer','x-assessment-token'].includes(k))headers[k]=v;
  const data=['GET','HEAD'].includes(req.method)?undefined:await body(req),r=await fetch(config.api_url+url.pathname.slice(4)+url.search,{method:req.method,headers,...(data?{body:data}:{}),signal:AbortSignal.timeout(45000)});
  // A test-only eligible pool; the original matching/scoring algorithm still runs unchanged.
  if(r.ok&&req.method==='GET'&&url.pathname==='/api/rest/v1/counselors'&&url.searchParams.get('is_active')==='eq.true'&&url.searchParams.get('review_status')==='eq.approved'){
   const rows=await r.json();return json(res,200,rows.filter(x=>x.id===accounts().backend.counselor.id));
  }
  res.writeHead(r.status,{'Content-Type':r.headers.get('content-type')||'application/json','Cache-Control':'no-store'});res.end(Buffer.from(await r.arrayBuffer()));return;
 }
 if(url.pathname==='/__demo/account-ui.js'){res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(__dirname,'platform-account-ui.js')));return;}
 const file=path.resolve(root+'/legacy-web','.'+(url.pathname==='/'?'/index.html':url.pathname));
 if(!file.startsWith(root+'/legacy-web/')||!fs.existsSync(file)||!fs.statSync(file).isFile())return json(res,404,{message:'页面不存在'});
 let content=fs.readFileSync(file);
 if(file.endsWith('supabase-config.js'))content=content.toString().replace(/url: '[^']+'/,'url: \''+ORIGIN+'/api\'')+'\nSUPABASE_CONFIG.accountLogin=true;';
 if(file.endsWith('.html'))content=content.toString().replace(/<head>/i,'<head><script src="/__demo/account-ui.js"></script>');
 res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end(content);
 }catch(e){json(res,502,{message:e.code||e.message||'演示服务暂不可用'});}});}
if(require.main===module){accounts();app().listen(PORT,'127.0.0.1',()=>console.log('Original platform demo: '+ORIGIN+'/'));}
module.exports={app};
