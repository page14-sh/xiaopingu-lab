const { AssessmentError, SCALES: S, eventPosition } = require('./model');
const { DATASETS } = require('./statistics-source');
const DAY = 86400000, ZONE = 8*3600000, K = 5;
const METRICS = ['all','fill_duration','abandon_rate','low_quality_rate','alert_handle_time','remind_action_rate','follow_return_rate','notifications','llm_success'];
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AssessmentError('XG_BAD_PARAM','统计日期须为YYYY-MM-DD',400);
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0,10) !== value) throw new AssessmentError('XG_BAD_PARAM','统计日期不合法',400);
  return time-ZONE;
}
function reportRange({from,to,metric='all'},now) {
  if (!METRICS.includes(metric) || ((from===undefined)!==(to===undefined))) throw new AssessmentError('XG_BAD_PARAM','统计指标或日期区间不合法',400);
  const today = new Date(now+ZONE).toISOString().slice(0,10);
  if (from===undefined) { to=today; from=new Date(date(today)+ZONE-29*DAY).toISOString().slice(0,10); }
  const start=date(from),end=date(to)+DAY;
  if (end<=start || end-start>366*DAY || to>today) throw new AssessmentError('XG_BAD_PARAM','统计区间须为至多366天且不能包含未来日期',400);
  return {from,to,start,end,metric,asOf:now};
}
const time = (value) => typeof value === 'string' ? Date.parse(value) : NaN;
const within = (value,r) => time(value)>=r.start && time(value)<r.end && time(value)<=r.asOf;
const occurred = (value,r) => Number.isFinite(time(value)) && time(value)<=r.asOf;
const persons = (rows) => new Set(rows.map((r)=>r.visitor_id).filter((id)=>typeof id==='string'&&id)).size;
const hidden = () => ({status:'suppressed',reason:'insufficient_cohort'});
const unavailable = (reason) => ({status:'not_available',reason});
function unique(rows,key) { const result=new Map(); for(const row of rows) if(typeof row[key]==='string'&&!result.has(row[key])) result.set(row[key],row); return [...result.values()]; }
function ratio(rows, predicate, cohort) {
  const yes=rows.filter(predicate),no=rows.filter((r)=>!predicate(r));
  if(persons(rows)<K || (yes.length&&persons(yes)<K) || (no.length&&persons(no)<K))return hidden();
  return {status:'available',value:Math.round(yes.length/rows.length*10000)/10000,numerator:yes.length,denominator:rows.length,cohort};
}
function quantile(values,p){const n=(values.length-1)*p,lo=Math.floor(n),hi=Math.ceil(n);return values[lo]+(values[hi]-values[lo])*(n-lo);}
function distribution(rows, value, unit) {
  const selected=rows.filter((r)=>Number.isFinite(value(r))&&value(r)>=0);
  if(persons(selected)<K)return hidden();
  const values=selected.map(value).sort((a,b)=>a-b);
  return {status:'available',n:values.length,p50:Math.round(quantile(values,.5)*100)/100,p90:Math.round(quantile(values,.9)*100)/100,unit};
}
function outcome(event,r) {
  if(event.status==='submitted'&&occurred(event.submitted_at,r))return 'submitted';
  if(event.status==='abandoned'&&occurred(event.abandoned_at,r))return 'abandoned';
  return 'pending';
}
function summarize(data,r) {
  const metrics={},want=(name)=>r.metric==='all'||r.metric===name;
  const events=unique(data.events||[],'event_id').filter((e)=>typeof e.visitor_id==='string'&&e.visitor_id&&occurred(e.started_at,r));
  const submitted=events.filter((e)=>e.status==='submitted'&&within(e.submitted_at,r));
  if(want('fill_duration'))metrics.fill_duration_ms=distribution(submitted,(e)=>e.duration_ms,'milliseconds');
  if(want('low_quality_rate'))metrics.low_quality_rate=ratio(submitted.filter((e)=>['low','ok'].includes(e.quality_flag)),(e)=>e.quality_flag==='low','submitted_in_range');
  if(want('abandon_rate')) {
    const attempts=events.filter((e)=>within(e.started_at,r)),positions=new Map();
    for(const e of events){let key;try{key=eventPosition(e).submission_id;}catch{throw new AssessmentError('XG_STATS_SOURCE_INVALID','统计业务位置不合法',503);}
      const group=positions.get(key)||[];group.push(e);positions.set(key,group);}
    const cohort=[...positions.values()].filter((rows)=>within(rows.reduce((first,e)=>time(e.started_at)<time(first)?e.started_at:first,rows[0].started_at),r))
      .map((rows)=>({visitor_id:rows[0].visitor_id,outcome:rows.some((e)=>outcome(e,r)==='submitted')?'submitted':rows.some((e)=>outcome(e,r)==='pending')?'pending':'abandoned'}));
    metrics.abandon_rate=ratio(cohort,(e)=>e.outcome==='abandoned','business_position_first_started_in_range');
    metrics.attempt_abandon_rate=ratio(attempts,(e)=>outcome(e,r)==='abandoned','attempt_started_in_range');
    const groups=['submitted','abandoned','pending'].map((status)=>attempts.filter((e)=>outcome(e,r)===status));
    metrics.attempt_counts=persons(attempts)<K||groups.some((g)=>g.length&&persons(g)<K)?hidden():{
      status:'available',started:attempts.length,submitted:groups[0].length,abandoned:groups[1].length,pending:groups[2].length};
  }
  const alerts=unique(data.alerts||[],'alert_id').filter((a)=>within(a.triggered_at,r)&&['L2','L3'].includes(a.initial_level));
  if(want('alert_handle_time')) {
    metrics.alert_handle_time_h={};
    for(const type of ['outcome','alliance','stability','dissociation'])metrics.alert_handle_time_h[type]=distribution(
      alerts.filter((a)=>a.alert_type===type&&a.status==='closed'&&occurred(a.handled_at,r)),(a)=>(time(a.handled_at)-time(a.triggered_at))/3600000,'hours');
  }
  if(want('remind_action_rate')) {
    metrics.remind_action_rate=ratio(alerts,(a)=>occurred(a.cst_started_at,r)||(a.status==='closed'&&occurred(a.handled_at,r)),'raw_l2_l3_triggered_in_range');
    metrics.remind_ack_rate=ratio(alerts,(a)=>occurred(a.acked_at,r),'raw_l2_l3_triggered_in_range');
  }
  if(want('follow_return_rate')) {
    const follow=unique(data.followups||[],'job_id').filter((j)=>within(j.due_at,r));
    const success=new Map();for(const e of events)if(e.status==='submitted'&&e.scale_code===S.follow&&occurred(e.submitted_at,r)){
      const key=JSON.stringify([e.match_id,e.visitor_id,e.session_no,e.follow_round]);
      const old=success.get(key);if(!old||time(e.submitted_at)<time(old.submitted_at))success.set(key,e);
    }
    metrics.follow_return_rate={};
    for(const round of ['1m','3m'])metrics.follow_return_rate[round]=ratio(follow.filter((j)=>j.follow_round===round),(j)=>{
      const e=success.get(JSON.stringify([j.match_id,j.visitor_id,j.session_no,j.follow_round]));return !!e&&time(e.submitted_at)>=time(j.due_at);
    },'due_in_range_returned_by_as_of');
    metrics.follow_on_time_rate=unavailable('return_deadline_not_defined');
  }
  if(want('notifications')) {
    const tasks=unique(data.tasks||[],'task_id').filter((t)=>within(t.created_at,r)),ids=new Set(tasks.map((t)=>t.task_id));
    const accepted=new Set();
    for(const a of unique(data.attempts||[],'attempt_id'))if(ids.has(a.task_id)&&occurred(a.started_at,r)&&
      ((a.state==='accepted'&&occurred(a.finished_at,r))||(a.late_result?.kind==='accepted'&&occurred(a.late_result.recorded_at,r))))accepted.add(a.task_id);
    for(const t of tasks)if(['provider_accepted','operator_confirmed'].includes(t.delivery_result)&&occurred(t.notified_at,r))accepted.add(t.task_id);
    const messages=unique(data.messages||[],'message_id').filter((m)=>ids.has(m.task_id)&&occurred(m.created_at,r));
    const stored=new Set(messages.map((m)=>m.task_id)),read=new Set(messages.filter((m)=>occurred(m.read_at,r)).map((m)=>m.task_id));
    const cohort='notification_task_created_in_range';
    metrics.notifications={
      provider_accepted_rate:ratio(tasks,(t)=>accepted.has(t.task_id),cohort),
      inapp_stored_rate:ratio(tasks,(t)=>stored.has(t.task_id),cohort),
      delivery_confirmed_rate:ratio(tasks,(t)=>accepted.has(t.task_id)||stored.has(t.task_id),cohort),
      unresolved_rate:ratio(tasks,(t)=>t.status==='uncertain',cohort),
      inapp_read_rate:ratio(tasks.filter((t)=>stored.has(t.task_id)),(t)=>read.has(t.task_id),'stored_inapp_tasks'),
      external_read_rate:unavailable('no_external_read_receipts')
    };
  }
  if(want('llm_success')) {
    const jobs=unique(data.llmJobs||[],'job_id').filter(j=>within(j.created_at,r));
    metrics.llm_success_rate=ratio(jobs,j=>j.status==='done'&&occurred(j.completed_at,r),'eligible_llm_jobs_created_in_range');
    metrics.llm_status_rates={};
    for(const status of ['pending','processing','retry_wait','blocked','failed','review_required','done','cancelled'])metrics.llm_status_rates[status]=ratio(jobs,j=>j.status===status,'eligible_llm_jobs_created_in_range');
    const failed=jobs.filter(j=>['failed','review_required'].includes(j.status));
    const category=j=>/HUMAN/.test(j.last_error||'')?'human_review':/UNSAFE|INVALID_JSON|INVALID_OUTPUT|RESPONSE_TOO_LARGE/.test(j.last_error||'')?'output_validation':/TIMEOUT|NETWORK|LEASE_EXPIRED/.test(j.last_error||'')?'timeout_network':/UPSTREAM/.test(j.last_error||'')?'upstream':'other';
    metrics.llm_failure_reasons={};
    for(const key of ['human_review','output_validation','timeout_network','upstream','other'])metrics.llm_failure_reasons[key]=ratio(failed,j=>category(j)===key,'failed_or_review_required_jobs');
  }
  return {schema_version:'stats-t19-v1',range:{from:r.from,to:r.to,timezone:'Asia/Shanghai',to_inclusive:true},as_of:new Date(r.asOf).toISOString(),
    consistency:'bounded_observed_read',privacy:{minimum_distinct_visitors:K,small_nonzero_rate_subgroups_suppressed:true},
    coverage:'lifecycle_started_events_and_versioned_action_metadata',metrics};
}
function createStatisticsRepository(store,{now=Date.now,maxRows=10000}={}) {
  if(!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>100000)throw new Error('Invalid statistics row budget');
  return {async report(input={}){
    const r=reportRange(input,now()),data={},needed=new Set();
    if(['all','llm_success'].includes(r.metric))needed.add('llmJobs');
    if(['all','fill_duration','abandon_rate','low_quality_rate','follow_return_rate'].includes(r.metric))needed.add('events');
    if(['all','alert_handle_time','remind_action_rate'].includes(r.metric))needed.add('alerts');
    if(['all','follow_return_rate'].includes(r.metric))needed.add('followups');
    if(['all','notifications'].includes(r.metric))for(const name of ['tasks','attempts','messages'])needed.add(name);
    for(const name of needed){data[name]=[];let after;
      while(true){const page=await store.statisticsPage(name,{from:new Date(r.start).toISOString(),to:new Date(r.end).toISOString(),asOf:new Date(r.asOf).toISOString(),after,limit:100});
        if(data[name].length+page.length>maxRows)throw new AssessmentError('XG_STATS_TOO_LARGE','统计超出在线读取上限，请使用离线汇总',503);
        for(const row of page){if(typeof row._id!=='string'||(after&&row._id<=after))throw new AssessmentError('XG_STATS_SOURCE_INVALID','统计分页数据不一致',503);after=row._id;data[name].push(row);}
        if(page.length<100)break;
      }
    }
    return summarize(data,r);
  }};
}
module.exports={createStatisticsRepository,summarize,reportRange,DATASETS};
