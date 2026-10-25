const { AssessmentError } = require('./model');
const { fields, deny } = require('./authorization');
async function handleLlm({req,res,url,principal,service,readJson,sendJson}){
  const list=url.pathname==='/v1/xg/admin/llm-jobs';
  const job=url.pathname.match(/^\/v1\/xg\/admin\/llm-jobs\/([A-Za-z0-9_-]+)(?:\/(reprocess|review))?$/);
  const proposal=url.pathname.match(/^\/v1\/xg\/admin\/llm-proposals\/([A-Za-z0-9_-]+)\/review$/);
  const weights=url.pathname.match(/^\/v1\/xg\/admin\/llm-weights\/([A-Za-z0-9_-]+)$/);
  if(!list&&!job&&!proposal&&!weights)return false;
  if(principal.role!=='admin')deny();
  if(!service)throw new AssessmentError('XG_NOT_READY','模型服务尚未配置',503);
  if(list&&req.method==='GET'){
    for(const key of url.searchParams.keys())if(!['status','after','limit'].includes(key)||url.searchParams.getAll(key).length!==1)throw new AssessmentError('XG_BAD_PARAM','查询参数不合法',400);
    const input=Object.fromEntries(url.searchParams);if(input.limit!==undefined){if(!/^[1-9]\d*$/.test(input.limit))throw new AssessmentError('XG_BAD_PARAM','分页参数不合法',400);input.limit=Number(input.limit);}
    sendJson(res,200,await service.list(principal,input));return true;
  }
  if([...url.searchParams.keys()].length)throw new AssessmentError('XG_BAD_PARAM','此接口不接受查询参数',400);
  if(weights&&req.method==='GET'){sendJson(res,200,await service.weights(principal,weights[1]));return true;}
  if(job&&!job[2]&&req.method==='GET'){sendJson(res,200,await service.detail(principal,job[1]));return true;}
  if(req.method!=='POST'||(job&&!job[2])||list)throw new AssessmentError('XG_METHOD_NOT_ALLOWED','请求方法不支持',405);
  const body=await readJson(req);
  if(weights){fields(body,['weights','expected_revision','request_id','reason']);sendJson(res,200,await service.setWeights(principal,weights[1],body));}
  else if(proposal){fields(body,['decision','expected_revision','expected_weight_revision','reason']);sendJson(res,200,await service.reviewWeights(principal,proposal[1],body));}
  else if(job[2]==='review'){fields(body,['decision','expected_revision','generation','reason']);sendJson(res,200,await service.reviewResult(principal,job[1],body));}
  else {fields(body,['expected_revision','request_id','reason']);sendJson(res,200,await service.reprocess(principal,job[1],body));}
  return true;
}
module.exports={handleLlm};
