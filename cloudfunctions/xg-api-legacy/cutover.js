// Fixed-origin compatibility forwarding after the verified v2 cutover.
const https=require('node:https');
const TARGET='https://xiaopingu-assessment-308810-6-1300577165.sh.run.tcloudbase.com';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'authorization,apikey,content-type,prefer,x-assessment-token','Cache-Control':'no-store','Content-Type':'application/json'};
async function handleCutover(req,res,env=process.env){
 if(!env.XPG_V2_API_URL&&env.XPG_MIGRATION_PAUSED!=='1')return false;
 if(req.method==='OPTIONS'){res.writeHead(204,cors);res.end('');return true;}
 if(env.XPG_V2_API_URL){
  if(env.XPG_V2_API_URL!==TARGET)throw new Error('Invalid v2 forwarding target');
  const input=new URL(req.url,'http://legacy.internal'),url=new URL(TARGET);url.pathname=input.pathname;url.search=input.search;
  const headers={};for(const [key,value]of Object.entries(req.headers||{}))if(['authorization','content-type','prefer','x-assessment-token'].includes(key.toLowerCase()))headers[key.toLowerCase()]=value;
  const result=await new Promise((resolve,reject)=>{const request=https.request(url,{method:req.method,headers,timeout:15000},response=>{const chunks=[];let size=0;response.on('data',c=>{size+=c.length;if(size>5*1024*1024){response.destroy();reject(new Error('Response too large'));}else chunks.push(c);});response.on('end',()=>resolve({status:response.statusCode,body:Buffer.concat(chunks).toString('utf8')}));response.on('error',reject);});request.on('timeout',()=>request.destroy(new Error('Upstream timeout')));request.on('error',reject);request.end(['GET','HEAD'].includes(req.method)?undefined:req.__bodyRaw||'');});
  res.writeHead(result.status,cors);res.end(result.body);return true;
 }
 res.writeHead(503,{...cors,'Retry-After':'120'});res.end(JSON.stringify({code:'XPG_MIGRATION_PAUSED',message:'正在升级数据，请稍后刷新重试。原记录已保留。'}));return true;
}
module.exports={handleCutover,TARGET};
