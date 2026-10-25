const { AssessmentError, COLLECTIONS: C, SCALES: S, scopeOf, assertScope, eventPosition } = require('./model');
const { verifyEventBasis, contentHash } = require('./provenance');
const { requireMatch } = require('./event-storage');
const DIMENSIONS = Object.freeze(['ORS', '联盟', '稳定度', '目标进展']);
const BASE_WEIGHTS = Object.freeze({ ORS: .35, 联盟: .35, 稳定度: .2, 目标进展: .1 });
const PROMPT_VERSION = 'xg-analysis-t19-v1';
const UNSAFE_TEXT = /恶化|病情|严重|抑郁|焦虑症|诊断|用药|药物|人格障碍|自杀倾向|躁狂|躁郁|双相|精神分裂|精神病|强迫症|恐惧症|惊恐障碍|创伤后应激|治愈|疗效|好转|diagnos|disorder|medicat|suicid|depress|bipolar|schizophren|PTSD|ADHD/i;
const PRIVATE_TEXT = /(?:\d[\s-]*){7,}|https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i;
const SYSTEM_PROMPT = `你是问卷数据辅助分析助手。只依据给定数值输出中性描述，不作诊断、疾病或人格判断，不建议用药，不推断未提供的信息，不评价疗效。输入不含姓名、联系方式或逐字稿，不要求补充这些信息。
维度权重 ORS=0.35、联盟=0.35、稳定度=0.20、目标进展=0.10；tag_weights 仅是经管理员审核的本周期辅助分析倍率，不能改变主分或预警。
输出严格 JSON，且仅包含 summary、dim_scores、suggest_actions、tag_weight_adjust。summary 非空且最多60字。dim_scores 必须恰有 ORS、联盟、稳定度、目标进展四键；available_dimensions 中为 false 的维度必须填 null，其余为0至100数值，不能根据缺失数据编造分数。
suggest_actions 最多2条中性沟通建议，每条最多200字。tag_weight_adjust 最多3条，tag 只能为有数据的上述维度，不重复；delta 在-0.2至0.2之间，reason 非空且最多200字。建议不会自动生效。不得输出个人身份信息、联系方式、链接、诊断或病情结论。`;
function invalid(code = 'XG_LLM_INVALID_OUTPUT') { throw new AssessmentError(code, '模型结果未通过校验', 422); }
function object(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value,k));
}
function safeText(value, max) {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max || /[\u0000-\u001f\u007f<>]/.test(value)) invalid();
  const normalized=value.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,'').trim();
  if(!normalized||[...normalized].length>max)invalid();
  if (UNSAFE_TEXT.test(normalized) || PRIVATE_TEXT.test(normalized)) invalid('XG_LLM_UNSAFE_OUTPUT');
  return normalized;
}
function validateOutput(raw, available) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16000) invalid();
  let text = raw.trim();
  if (/^```(?:json)?\s*\n[\s\S]*\n```$/i.test(text)) text = text.replace(/^```(?:json)?\s*\n/i,'').replace(/\n```$/,'');
  let value; try { value = JSON.parse(text); } catch { invalid('XG_LLM_INVALID_JSON'); }
  if (!object(value,['summary','dim_scores','suggest_actions','tag_weight_adjust']) || !object(value.dim_scores,DIMENSIONS)) invalid();
  const summary = safeText(value.summary,60), dim_scores = {};
  for (const key of DIMENSIONS) {
    const score = value.dim_scores[key];
    if (available[key] ? typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100 : score !== null) invalid();
    dim_scores[key] = score;
  }
  if (!Array.isArray(value.suggest_actions) || value.suggest_actions.length > 2 || !Array.isArray(value.tag_weight_adjust) || value.tag_weight_adjust.length > 3) invalid();
  const suggest_actions = value.suggest_actions.map(v => safeText(v,200)), tags = new Set();
  const tag_weight_adjust = value.tag_weight_adjust.map(v => {
    if (!object(v,['tag','delta','reason']) || !DIMENSIONS.includes(v.tag) || !available[v.tag] || tags.has(v.tag) ||
        typeof v.delta !== 'number' || !Number.isFinite(v.delta) || Math.abs(v.delta) > .2) invalid();
    tags.add(v.tag); return { tag:v.tag, delta:v.delta, reason:safeText(v.reason,200) };
  });
  return {summary,dim_scores,suggest_actions,tag_weight_adjust};
}
function defaultWeights(match) { return {...scopeOf(match),revision:0,weights:Object.fromEntries(DIMENSIONS.map(k=>[k,1]))}; }
async function weightsIn(tx,match) {
  const record = await tx.get(C.tagWeights,match.match_id) || defaultWeights(match); assertScope(record,match);
  if (!Number.isSafeInteger(record.revision) || record.revision < 0 || !object(record.weights,DIMENSIONS) ||
      DIMENSIONS.some(k => !Number.isFinite(record.weights[k]) || record.weights[k] < .1 || record.weights[k] > 2)) {
    throw new AssessmentError('XG_LLM_WEIGHTS_INVALID','辅助分析权重配置异常',503);
  }
  return record;
}
async function sourceIn(tx,eventId) {
  const event = await tx.get(C.events,eventId);
  if (!event || event.event_id !== eventId) throw new AssessmentError('XG_NOT_FOUND','作答记录不存在',404);
  const match = await requireMatch(tx,event.match_id); assertScope(event,match); verifyEventBasis(event);
  if (event.status !== 'submitted' || event.quality_flag !== 'ok') throw new AssessmentError('XG_LLM_INELIGIBLE','仅有效且质量合格的答卷进入模型',409);
  return {event,match};
}
function numericAnswers(event) {
  const allowed = event.basis.items.filter(i=>i.applicable && i.item_type!=='text').map(i=>i.code);
  return Object.fromEntries(allowed.filter(k=>Number.isFinite(event.raw_answers[k])).map(k=>[k,event.raw_answers[k]]));
}
async function buildSnapshot(tx,event,match) {
  const records = new Map([[event.event_id,event]]);
  // Only current-session professional cards/state, and at most three adjacent
  // state observations. Deterministic slot reads fit the transaction API.
  if ([S.state,S.feel,S.pro].includes(event.scale_code)) {
    const positions = [S.state,S.feel,S.pro].map(scale_code=>({scale_code,session_no:event.session_no}));
    for(let n=Math.max(2,event.session_no-2);n<event.session_no;n++)positions.push({scale_code:S.state,session_no:n});
    for(const position of positions) {
      const slot = await tx.get(C.submissions,eventPosition({match_id:match.match_id,...position}).submission_id); assertScope(slot,match);
      if (!slot) continue;
      const row = await tx.get(C.events,slot.event_id); assertScope(row,match);
      if (!row || row.event_id!==slot.event_id || row.scale_code!==position.scale_code || row.session_no!==position.session_no) throw new AssessmentError('XG_SCOPE_MISMATCH','模型来源不一致');
      if (row.status==='submitted' && row.quality_flag==='ok') { verifyEventBasis(row); records.set(row.event_id,row); }
    }
  }
  const current = [...records.values()].filter(e=>e.session_no===event.session_no);
  const select = (...scales) => current.find(e=>scales.includes(e.scale_code));
  const state = select(S.baseline,S.state), feel=select(S.feel),pro=select(S.pro);
  const available = {ORS:!!state,联盟:!!feel && !!pro && pro.session_no>1,稳定度:!!pro || ['s8','s9','s10'].every(k=>Number.isFinite(state?.raw_answers[k])),目标进展:!!state};
  const weights = await weightsIn(tx,match);
  const payload = {
    scale_code:event.scale_code,session_no:event.session_no,follow_round:event.follow_round,
    cards:current.map(e=>({scale_code:e.scale_code,answers:numericAnswers(e)})),
    trend:[...records.values()].filter(e=>e.scale_code===S.state&&e.session_no>=2).sort((a,b)=>a.session_no-b.session_no).slice(-3)
      .map(e=>({session_no:e.session_no,total:e.scores.total})),
    available_dimensions:available,base_weights:BASE_WEIGHTS,tag_weights:weights.weights
  };
  return {payload,input_hash:contentHash(payload),weight_revision:weights.revision,
    sources:[...records.values()].map(e=>({event_id:e.event_id,basis_hash:e.basis.basis_hash}))};
}
async function enqueueLlm(tx,match,event,timestamp) {
  if (event.quality_flag!=='ok') return;
  const existing = await tx.get(C.llmJobs,event.event_id); assertScope(existing,match);
  if (existing) return;
  await tx.put(C.llmJobs,event.event_id,{...scopeOf(match),event_id:event.event_id,job_id:event.event_id,
    status:'pending',generation:1,revision:1,attempts:0,total_attempts:0,created_at:timestamp,updated_at:timestamp,next_attempt_at:timestamp});
}
module.exports={DIMENSIONS,BASE_WEIGHTS,PROMPT_VERSION,SYSTEM_PROMPT,UNSAFE_TEXT,PRIVATE_TEXT,validateOutput,weightsIn,sourceIn,buildSnapshot,enqueueLlm};
