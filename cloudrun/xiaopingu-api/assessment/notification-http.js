const { AssessmentError, requireId } = require('./model');
const { fields, deny } = require('./authorization');
function params(search, allowed) {
  for (const key of search.keys()) if (!allowed.includes(key) || search.getAll(key).length!==1) throw new AssessmentError('XG_BAD_PARAM','查询参数不合法',400);
}
async function handleNotifications({req,res,url,principal,service,readJson,sendJson}) {
  const path=url.pathname;
  const messages=path==='/v1/xg/messages';
  const read=/^\/v1\/xg\/messages\/([A-Za-z0-9_-]+)\/read$/.exec(path);
  const act=/^\/v1\/xg\/alerts\/([A-Za-z0-9_-]+)\/(ack|cst)$/.exec(path);
  const admin=/^\/v1\/xg\/admin\/notifications\/([A-Za-z0-9_-]+)(\/resolve)?$/.exec(path);
  const binding=path==='/v1/xg/admin/notification-recipient';
  if (!messages&&!read&&!act&&!admin&&!binding) return false;
  if (admin||binding ? principal.role!=='admin' : act ? principal.role!=='counselor' : !['visitor','counselor'].includes(principal.role)) deny();
  if (!service) throw new AssessmentError('XG_NOT_READY','通知服务尚未配置',503);
  if (messages&&req.method==='GET') {
    params(url.searchParams,['limit','offset']);
    const number=(key,fallback)=>{ const s=url.searchParams.get(key); if(s===null)return fallback; if(!/^(0|[1-9][0-9]*)$/.test(s))throw new AssessmentError('XG_BAD_PARAM','分页不合法',400); return Number(s); };
    sendJson(res,200,await service.messages(principal,{limit:number('limit',50),offset:number('offset',0)}));
  } else {
    params(url.searchParams,[]);
    if (admin&&!admin[2]&&req.method==='GET') sendJson(res,200,await service.task(principal,requireId(admin[1],'task_id')));
    else if (req.method==='POST'&&(read||act||binding||admin?.[2])) {
      const body=await readJson(req);
      if(read){fields(body,[]);sendJson(res,200,await service.markRead(principal,requireId(read[1],'message_id')));}
      else if(act){fields(body,act[2]==='ack'?['match_id','expected_revision','note']:['match_id','expected_revision','note','cst_step','close','phone_followup_done']);sendJson(res,200,await service.act(principal,act[1],act[2],body));}
      else if(binding){fields(body,['counselor_id','expected_revision','reason','openid','appid','phone_e164','phone_verified','disabled']);sendJson(res,200,await service.bindRecipient(principal,body));}
      else {fields(body,['expected_revision','outcome','reason','evidence_reference']);sendJson(res,200,await service.resolve(principal,admin[1],body));}
    } else sendJson(res,405,{error:{code:'XG_METHOD_NOT_ALLOWED',message:'该接口不支持此方法'}});
  }
  return true;
}
module.exports={handleNotifications};
