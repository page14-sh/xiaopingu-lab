const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createStatisticsRepository, summarize, reportRange, DATASETS } = require('./statistics');
const { memoryAssessmentStore } = require('./test-support');
const { COLLECTIONS: C, SCALES: S } = require('./model');
const { createRequestHandler, signSession } = require('../app');
const { createAssessmentRepository } = require('./repository');
const { createIdentityRepository } = require('./identity-repository');
const at = '2026-10-20T01:00:00.000Z', later = '2026-10-20T02:00:00.000Z';
const now = Date.parse('2026-10-25T04:00:00.000Z');
const range = (metric='all',extra={}) => reportRange({from:'2026-10-20',to:'2026-10-20',metric,...extra},now);
const event = (i,extra={}) => ({event_id:`e-${i}`,visitor_id:`v-${i}`,match_id:`m-${i}`,scale_code:S.baseline,session_no:0,follow_round:'',
  started_at:at,status:'submitted',submitted_at:later,duration_ms:1000*(i+1),quality_flag:'ok',...extra});
const rows = (n,fn=event) => Array.from({length:n},(_,i)=>fn(i));
const metrics = (data,metric='all') => summarize(data,range(metric)).metrics;
const suppressed = (value) => assert.deepEqual(value,{status:'suppressed',reason:'insufficient_cohort'});

test('T18 Shanghai inclusive days, valid calendar dates and bounded default range',()=>{
  const r=range(); assert.equal(new Date(r.start).toISOString(),'2026-10-19T16:00:00.000Z');
  assert.equal(new Date(r.end).toISOString(),'2026-10-20T16:00:00.000Z');
  assert.equal(reportRange({},now).from,'2026-09-26');
  for(const input of [{from:'2026-02-30',to:'2026-03-01'},{from:'2026-10-20'}, {from:'2026-01-01T00:00:00Z',to:'2026-01-02'},
    {from:'2026-10-21',to:'2026-10-20'},{from:'2026-10-20',to:'2026-10-26'},{from:'2024-01-01',to:'2026-10-20'},{metric:'scores'}]){
    assert.throws(()=>reportRange(input,now),{code:'XG_BAD_PARAM'});
  }
});

test('T18 all started attempts stay in denominator after terminal transitions',()=>{
  const events=rows(10,i=>event(i,i<5?{status:'abandoned',submitted_at:null,abandoned_at:later}:{}));
  const m=metrics({events},'abandon_rate');
  assert.deepEqual(m.attempt_counts,{status:'available',started:10,submitted:5,abandoned:5,pending:0});
  assert.equal(m.abandon_rate.value,.5); assert.equal(m.abandon_rate.denominator,10);
  assert.equal(m.attempt_abandon_rate.value,.5);
});

test('T18 attempt retries and repeated reads do not inflate business positions',()=>{
  const events=rows(5,i=>event(i,{status:'abandoned',submitted_at:null,abandoned_at:later}));
  events.push(...rows(5,i=>event(i,{event_id:`retry-${i}`})));
  const m=metrics({events:[...events,...structuredClone(events)]},'abandon_rate');
  assert.equal(m.abandon_rate.denominator,5); assert.equal(m.abandon_rate.value,0);
  assert.equal(m.attempt_abandon_rate.denominator,10); assert.equal(m.attempt_abandon_rate.value,.5);
});

test('T18 pending or rejected retry keeps a business position unresolved',()=>{
  const events=rows(5,i=>event(i,{status:'abandoned',submitted_at:null,abandoned_at:later}));
  events.push(...rows(5,i=>event(i,{event_id:`retry-${i}`,status:'rejected',submitted_at:null})));
  const m=metrics({events},'abandon_rate'); assert.equal(m.abandon_rate.value,0);
  assert.equal(m.attempt_counts.pending,5); assert.equal(m.attempt_counts.abandoned,5);
});

test('T18 cycle and follow-up rounds are independent positions while first start selects cohort',()=>{
  const events=rows(5);
  events.push(...rows(5,i=>event(i,{event_id:`cycle2-${i}`,match_id:`next-${i}`})));
  for(const follow_round of ['1m','3m'])events.push(...rows(5,i=>event(i,{event_id:`${follow_round}-${i}`,scale_code:S.follow,session_no:4,follow_round})));
  assert.equal(metrics({events},'abandon_rate').abandon_rate.denominator,20);
  events.push(...rows(5,i=>event(i,{event_id:`old-${i}`,started_at:'2026-10-18T01:00:00.000Z',status:'abandoned',abandoned_at:at})));
  const m=metrics({events},'abandon_rate'); assert.equal(m.abandon_rate.denominator,15); assert.equal(m.attempt_counts.started,20);
});

test('T18 completion-time cohorts, continuous percentiles and day boundaries',()=>{
  const events=rows(5,i=>event(i,{started_at:'2026-10-19T15:59:59.999Z',submitted_at:'2026-10-19T16:00:00.000Z'}));
  events.push(event(100,{submitted_at:'2026-10-20T16:00:00.000Z'}));
  const m=metrics({events}); assert.deepEqual(m.fill_duration_ms,{status:'available',n:5,p50:3000,p90:4600,unit:'milliseconds'});
  assert.equal(m.low_quality_rate.value,0);
  suppressed(m.abandon_rate);
});

test('T18 low quality uses valid submissions only, not rejects or unknown legacy quality',()=>{
  const events=rows(10,i=>event(i,{quality_flag:i<5?'low':'ok'}));
  events.push(event(11,{status:'rejected'}),event(12,{quality_flag:undefined}),event(13,{started_at:undefined}));
  const m=metrics({events},'low_quality_rate').low_quality_rate;
  assert.equal(m.denominator,10); assert.equal(m.numerator,5); assert.equal(m.value,.5);
});

test('T18 privacy counts distinct people and hides nonzero small subgroups and complements',()=>{
  for(const events of [[],rows(5,i=>event(i,{visitor_id:'one-person'})),rows(4)]) {
    const m=metrics({events}); suppressed(m.fill_duration_ms); suppressed(m.low_quality_rate); suppressed(m.attempt_counts);
  }
  for(const lowCount of [1,9])suppressed(metrics({events:rows(10,i=>event(i,{quality_flag:i<lowCount?'low':'ok'}))},'low_quality_rate').low_quality_rate);
  suppressed(metrics({events:rows(10,i=>event(i,{status:i===0?'rejected':'submitted'}))},'abandon_rate').attempt_counts);
  assert.equal(metrics({events:rows(5,i=>event(i,{quality_flag:'low'}))},'low_quality_rate').low_quality_rate.value,1);
});

test('T18 ack alone is not CST action; handling latency uses original trigger by type',()=>{
  const alerts=rows(10,i=>({alert_id:`a-${i}`,visitor_id:`v-${i}`,initial_level:'L3',alert_type:'outcome',triggered_at:at,
    status:i<5?'closed':'acked',acked_at:later,handled_at:i<5?later:null}));
  const m=metrics({alerts}); assert.equal(m.remind_ack_rate.value,1); assert.equal(m.remind_action_rate.value,.5);
  assert.deepEqual(m.alert_handle_time_h.outcome,{status:'available',n:5,p50:1,p90:1,unit:'hours'});
  suppressed(m.alert_handle_time_h.alliance);
  for(const a of alerts.slice(5))a.cst_started_at=later;
  assert.equal(metrics({alerts},'remind_action_rate').remind_action_rate.value,1);
  alerts.push({alert_id:'legacy',visitor_id:'v-private',created_at:at,status:'closed',handled_at:later});
  assert.equal(metrics({alerts},'remind_action_rate').remind_action_rate.denominator,10);
});

test('T18 follow-up denominator includes blocked and unnotified plans; return must match cycle and round',()=>{
  const followups=rows(10,i=>({job_id:`j-${i}`,match_id:`m-${i}`,visitor_id:`v-${i}`,session_no:4,follow_round:'1m',due_at:at,status:'blocked'}));
  const events=rows(5,i=>event(i,{scale_code:S.follow,session_no:4,follow_round:'1m'}));
  events.push(...rows(5,i=>event(i+5,{scale_code:S.follow,session_no:4,follow_round:'3m'})));
  events.push(...rows(5,i=>event(i+5,{event_id:`wrong-${i}`,match_id:`new-${i+5}`,scale_code:S.follow,session_no:4,follow_round:'1m'})));
  const m=metrics({followups,events},'follow_return_rate');
  assert.equal(m.follow_return_rate['1m'].denominator,10); assert.equal(m.follow_return_rate['1m'].value,.5);
  suppressed(m.follow_return_rate['3m']); assert.equal(m.follow_on_time_rate.reason,'return_deadline_not_defined');
  for(const e of events)e.submitted_at='2026-10-19T23:00:00.000Z';
  assert.equal(metrics({followups,events},'follow_return_rate').follow_return_rate['1m'].value,0);
});

test('T18 notification acceptance, durable inbox and reads are separate; delivery union deduplicates',()=>{
  const tasks=rows(10,i=>({task_id:`t-${i}`,visitor_id:`v-${i}`,created_at:at,status:i<5?'sent':'queued',sent_at:later}));
  const attempts=rows(5,i=>({attempt_id:`a-${i}`,task_id:`t-${i}`,started_at:at,state:'accepted',finished_at:later}));
  const messages=rows(5,i=>({message_id:`msg-${i}`,task_id:`t-${i}`,created_at:later,read_at:null}));
  const m=metrics({tasks,attempts,messages},'notifications').notifications;
  for(const key of ['provider_accepted_rate','inapp_stored_rate','delivery_confirmed_rate'])assert.equal(m[key].value,.5);
  assert.equal(m.inapp_read_rate.value,0); assert.equal(m.external_read_rate.reason,'no_external_read_receipts');
  assert.equal(m.unresolved_rate.value,0);
  assert.equal(metrics({tasks},'notifications').notifications.delivery_confirmed_rate.value,0);
});

test('T18 late acceptance and operator resolution count, while uncertain does not imply delivery',()=>{
  const tasks=rows(10,i=>({task_id:`t-${i}`,visitor_id:`v-${i}`,created_at:at,status:i<5?'uncertain':'sent',
    delivery_result:i<5?'unknown':'operator_confirmed',notified_at:i<5?null:later}));
  let m=metrics({tasks},'notifications').notifications;
  assert.equal(m.provider_accepted_rate.value,.5); assert.equal(m.unresolved_rate.value,.5);
  const attempts=rows(5,i=>({attempt_id:`a-${i}`,task_id:`t-${i}`,started_at:at,state:'unknown',late_result:{kind:'accepted',recorded_at:'2026-10-24T00:00:00.000Z'}}));
  m=metrics({tasks,attempts},'notifications').notifications; assert.equal(m.provider_accepted_rate.value,1);
});

test('T19 LLM success scans actual jobs only and suppresses an empty denominator',async()=>{
  const names=[];const repo=createStatisticsRepository({statisticsPage:async(name)=>{names.push(name);return []; }},{now:()=>now});
  const result=await repo.report({metric:'llm_success'});assert.deepEqual(names,['llmJobs']);suppressed(result.metrics.llm_success_rate);
});

test('T19 LLM rates use unique eligible jobs and suppress small failure categories',()=>{
  const llmJobs=rows(10,i=>({job_id:`j-${i}`,visitor_id:`v-${i}`,created_at:at,status:i<5?'done':'failed',completed_at:i<5?later:null,last_error:'XG_LLM_UPSTREAM_4XX'}));
  const result=metrics({llmJobs:[...llmJobs,...llmJobs]},'llm_success');
  assert.equal(result.llm_success_rate.value,.5);assert.equal(result.llm_success_rate.denominator,10);
  assert.equal(result.llm_status_rates.failed.value,.5);assert.equal(result.llm_failure_reasons.upstream.value,1);
  llmJobs[9].last_error='XG_LLM_INVALID_JSON';suppressed(metrics({llmJobs},'llm_success').llm_failure_reasons.upstream);
});

async function seed(db,collection,entries,key){await db.transaction(async tx=>{for(const row of entries)await tx.put(collection,row[key],row);});}
test('T18 repository keyset pagination includes all rows and fails instead of truncating a cap',async()=>{
  const db=memoryAssessmentStore();await seed(db,C.events,rows(205,i=>event(i,{event_id:`e-${String(i).padStart(4,'0')}`})),'event_id');
  const calls=[],source={...db,async statisticsPage(name,args){calls.push(args);return db.statisticsPage(name,args);}};
  const repo=createStatisticsRepository(source,{now:()=>now});
  const before=db.snapshot();const m=(await repo.report({metric:'abandon_rate',from:'2026-10-20',to:'2026-10-20'})).metrics;
  assert.equal(m.attempt_counts.started,205);assert.equal(calls.length,3);assert.equal(calls[1].after,'e-0099');assert.deepEqual(db.snapshot(),before);
  await assert.rejects(createStatisticsRepository(db,{now:()=>now,maxRows:200}).report({metric:'fill_duration'}),{code:'XG_STATS_TOO_LARGE',statusCode:503});
  await assert.rejects(createStatisticsRepository({statisticsPage:async()=>[{_id:'b'},{_id:'a'}]},{now:()=>now}).report({metric:'fill_duration'}),{code:'XG_STATS_SOURCE_INVALID'});
});

test('T18 reader projection excludes private fields and no identities escape aggregation',async()=>{
  const db=memoryAssessmentStore();await seed(db,C.events,rows(5,i=>event(i,{raw_answers:{s1:'PRIVATE'},scores:{total:42},contact:'PRIVATE'})),'event_id');
  for(const spec of Object.values(DATASETS))assert.equal(spec.fields.some(f=>/raw_answers|scores|phone|notes|provider_receipt/.test(f)),false);
  const page=await db.statisticsPage('events',{asOf:new Date(now).toISOString(),limit:100});
  assert.ok(page.every(e=>!e.raw_answers&&!e.scores&&!e.contact));
  const result=await createStatisticsRepository(db,{now:()=>now}).report({});
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|visitor_id|match_id|event_id|raw_answers|scores/);
});

test('T18 repository retains pre-range starts and post-range receipt evidence',async()=>{
  const db=memoryAssessmentStore();
  await seed(db,C.events,rows(5,i=>event(i,{started_at:'2026-10-18T00:00:00.000Z'})),'event_id');
  await seed(db,C.events,rows(5,i=>event(i,{event_id:`retry-${i}`})),'event_id');
  await seed(db,C.notificationTasks,rows(5,i=>({task_id:`t-${i}`,visitor_id:`v-${i}`,created_at:at,status:'sent'})),'task_id');
  await seed(db,C.notificationAttempts,rows(5,i=>({attempt_id:`a-${i}`,task_id:`t-${i}`,started_at:'2026-10-22T00:00:00.000Z',finished_at:'2026-10-22T01:00:00.000Z',state:'accepted'})),'attempt_id');
  const m=(await createStatisticsRepository(db,{now:()=>now}).report({from:'2026-10-20',to:'2026-10-20'})).metrics;
  suppressed(m.abandon_rate);assert.equal(m.attempt_counts.started,5);assert.equal(m.notifications.provider_accepted_rate.value,1);
});

test('T18 admin statistics reject individual filters, duplicate parameters and other roles without writes',async(t)=>{
  const db=memoryAssessmentStore();await db.transaction(tx=>tx.put(C.visitors,'visitor',{visitor_id:'visitor',provider:'wechat-cloud'}));
  const store={assessment:createAssessmentRepository(db),identity:createIdentityRepository(db),statistics:createStatisticsRepository(db,{now:()=>now}),
    async findById(){return {is_active:true,review_status:'approved'};},async list(){return [];}};
  const secret='stats-http-test-secret';const server=http.createServer(createRequestHandler({store,sessionSecret:secret}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=(role,query='',method='GET')=>fetch(`http://127.0.0.1:${server.address().port}/v1/xg/admin/stats${query}`,{method,headers:role?{authorization:`Bearer ${signSession({role,subject:role,aud:'xg-assessment',demo:false,auth_method:{admin:'admin-password',visitor:'wechat-cloud',counselor:'counselor-edit'}[role],exp:Date.now()+60000},secret)}`}:{}});
  const before=db.snapshot();assert.equal((await request(null)).status,401);
  for(const role of ['visitor','counselor'])assert.equal((await request(role)).status,403);
  for(const query of ['?visitor_id=visitor','?match_id=m','?counselor_id=c','?metric=all&metric=abandon_rate','?from=2026-10-20','?metric=bad'])assert.equal((await request('admin',query)).status,400);
  const response=await request('admin');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal((await response.json()).privacy.minimum_distinct_visitors,5);
  assert.notEqual((await request('admin','','POST')).status,200);assert.deepEqual(db.snapshot(),before);
});
