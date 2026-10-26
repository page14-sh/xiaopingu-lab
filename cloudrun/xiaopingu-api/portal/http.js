const {createLegacyRest}=require('./legacy-rest');
const {history}=require('./history');
const {AUDIENCE,fields,deny,authorizeMatch}=require('../assessment/authorization');
const {COLLECTIONS:C,AssessmentError}=require('../assessment/model');
const HISTORY_AUDIENCE='xg-history';
function createPortalHttp({portal,signSession,sessionSecret,readJson,sendJson}){
 const rest=createLegacyRest({db:portal.db,hooks:portal});
 return async function(req,res,url,session){
  const p=url.pathname;
  if(!['/auth/visitor-receipt','/auth/history','/resolve','/xg/counselor-context'].includes(p)&&!p.startsWith('/v1/xg/portal/')&&!p.startsWith('/rest/v1/'))return false;
  res.setHeader('Cache-Control','no-store');res.setHeader('Vary','Authorization');
  try{
   if(['/auth/visitor-receipt','/auth/history'].includes(p)&&req.method==='POST'){
    const body=await readJson(req);fields(body,['credential']);const readonly=p==='/auth/history';
    const owner=await portal[readonly?'historyReceipt':'receipt'](body.credential),exp=Date.now()+3600000;
    const token=signSession({role:'visitor',subject:owner.visitor_id,aud:readonly?HISTORY_AUDIENCE:AUDIENCE,auth_method:readonly?'legacy-history':'intake-receipt',assessment_id:owner.assessment_id,read_only:readonly,demo:false,exp},sessionSecret);
    sendJson(res,200,{token,expires_at:exp,read_only:readonly,...owner});return true;
   }
   if(p==='/resolve'&&req.method==='GET'){
    const owner=await portal.historyReceipt(req.headers['x-assessment-token']);const row=await portal.source.get('assessments',owner.assessment_id);
    if(String(row.short_id||'').replace(/-/g,'').toUpperCase()!==String(url.searchParams.get('code')||'').replace(/-/g,'').toUpperCase())deny();
    sendJson(res,200,{id:row.id,view_token:row.view_token});return true;
   }
   if(p.startsWith('/rest/v1/')){
    let caller={role:'anonymous'};
    if(session){
     // Pending counselors may edit their own application but may not enter native four-assessment routes.
     if(session.aud!==AUDIENCE||session.demo!==false)deny();
     require('../assessment/authorization').requirePrincipal(session);
     if(session.role==='counselor'){const counselor=await portal.source.get('counselors',session.subject);if(!counselor||counselor.is_demo)deny();caller={role:'counselor',counselorId:session.subject,counselor,principal:session};}
     else {await portal.member(session);caller={role:session.role,principal:session};}
    }
    if(['POST','PATCH'].includes(req.method))req.__bodyRaw=JSON.stringify(await readJson(req));
    await rest(req,res,p.slice('/rest/v1/'.length),url.searchParams,caller);return true;
   }
   const readOnly=session?.aud===HISTORY_AUDIENCE&&session.role==='visitor'&&session.read_only===true;
   if(readOnly){
    if(p!=='/v1/xg/portal/history'||req.method!=='GET'||url.searchParams.get('assessment_id')!==session.assessment_id)deny('旧链接仅供查阅对应历史');
    const owner=await portal.source.get(C.intakes,session.assessment_id);if(owner?.visitor_id!==session.subject)deny();
   }else await portal.member(session);
   if(p==='/v1/xg/portal/history'&&req.method==='GET'){
    const q=Object.fromEntries(url.searchParams);fields(q,['assessment_id','source','after','limit']);
    sendJson(res,200,await history(portal,session,{...q,limit:q.limit===undefined?50:Number(q.limit)}));
   }else if(p==='/v1/xg/portal/board'&&req.method==='GET')sendJson(res,200,await portal.board(session));
   else if(p==='/v1/xg/portal/cases'&&req.method==='GET')sendJson(res,200,await portal.cases(session));
   else if(p==='/xg/counselor-context'&&req.method==='GET')sendJson(res,200,await portal.context(session,url.searchParams.get('asid')||url.searchParams.get('assessment_id')));
   else if(p==='/v1/xg/portal/migration'&&req.method==='GET'){
    if(session.role!=='admin')deny();const rows=await portal.scan(C.legacyRecords);sendJson(res,200,{archived_records:rows.length,unlinked_records:rows.filter(x=>x.link_status!=='linked').length,runs:await portal.scan(C.migrationRuns)});
   }else if(['/v1/xg/portal/case-config','/v1/xg/portal/close'].includes(p)){
    if(!['counselor','admin'].includes(session.role))deny();
    const body=req.method==='POST'?await readJson(req):Object.fromEntries(url.searchParams);
    fields(body,p.endsWith('/close')?['match_id','session_no']:req.method==='GET'?['match_id']:['match_id','optional_enabled','focus_text','expected_revision']);
    const match=await portal.assessment.getMatch(body.match_id);authorizeMatch(session,match);
    if(p.endsWith('/close')&&req.method==='POST')sendJson(res,200,await portal.assessment.closeMatch(match.match_id,body.session_no));
    else if(p.endsWith('/case-config')&&req.method==='GET')sendJson(res,200,await portal.provenance.getCaseConfig(match.match_id));
    else if(p.endsWith('/case-config')&&req.method==='POST')sendJson(res,200,await portal.provenance.setCaseConfig(match.match_id,{...body,changed_by:session.subject}));
    else throw new AssessmentError('XG_NOT_FOUND','接口不存在',404);
   }else throw new AssessmentError('XG_NOT_FOUND','接口不存在',404);
  }catch(error){sendJson(res,error.statusCode||error.status||500,{code:error.code||'XG_STORAGE_ERROR',message:error.statusCode||error.status?error.message:'服务暂时不可用'});}
  return true;
 };
}
module.exports={createPortalHttp,HISTORY_AUDIENCE};
