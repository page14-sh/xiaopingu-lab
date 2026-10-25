const SITE='https://xpg-demo-d3gzsswtcc3233ea0-1300577165.tcloudbaseapp.com';
const REST='https://xpg-demo-d3gzsswtcc3233ea0-1300577165.ap-shanghai.app.tcloudbase.com/xpg-rest';
const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'authorization,apikey,content-type,prefer,x-assessment-token','Cache-Control':'no-store'};
function reply(res,status,body){res.writeHead(status,{...CORS,'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));}
function createGateway({fetchImpl=fetch}={}){return async(req,res)=>{
 try{
  const url=new URL(req.url,'http://legacy.invalid');
  if(req.method==='OPTIONS'){res.writeHead(204,CORS);res.end();return;}
  if(url.pathname==='/health'){reply(res,200,{ok:true,mode:'legacy-compatibility-gateway',version:'security-20261025'});return;}
  if(/^\/(rest\/v1\/|auth\/|wx\/|xg\/)/.test(url.pathname)||['/resolve','/wechat/login'].includes(url.pathname)){
   const headers={'content-type':'application/json'};
   for(const key of ['authorization','content-type','prefer','x-assessment-token'])if(typeof req.headers[key]==='string')headers[key]=req.headers[key];
   const parts=[];let bytes=0;
   if(!['GET','HEAD'].includes(req.method))for await(const part of req){bytes+=part.length;if(bytes>2*1024*1024){reply(res,413,{message:'请求过大'});return;}parts.push(part);}
   // Fixed upstream; never forward gateway-injected context, cookies or cloud credentials.
   const response=await fetchImpl(REST+url.pathname+url.search,{method:req.method,headers,redirect:'error',signal:AbortSignal.timeout(30000),...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(parts)}:{})});
   res.writeHead(response.status,{...CORS,'Content-Type':response.headers.get('content-type')||'application/json'});
   res.end(req.method==='HEAD'?'':await response.text());return;
  }
  if(!['GET','HEAD'].includes(req.method)||url.pathname.startsWith('/v1/')){reply(res,410,{message:'请从原站点入口进入对应业务'});return;}
  const pathname=url.pathname==='/admin'?'/admin.html':url.pathname;
  // String concatenation deliberately preserves the fixed host, including // paths.
  res.writeHead(302,{...CORS,Location:SITE+pathname+url.search,'Referrer-Policy':'no-referrer'});res.end();
 }catch{reply(res,502,{message:'业务接口暂不可用，请稍后重试'});}
};}
module.exports={createGateway,SITE,REST};
