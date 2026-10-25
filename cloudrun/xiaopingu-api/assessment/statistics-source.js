const { COLLECTIONS: C } = require('./model');
// Strict server-side projections. No answers, scores, free-text notes, contacts,
// leases or provider response bodies enter the analytics reader.
const DATASETS = Object.freeze({
  llmJobs: {collection:C.llmJobs,time:'created_at',fields:['job_id','visitor_id','created_at','status','completed_at','last_error']},
  events: { collection: C.events, time: 'started_at', historical: true, fields: ['event_id','match_id','visitor_id','scale_code','session_no','follow_round','status','started_at','submitted_at','abandoned_at','expires_at','duration_ms','quality_flag'] },
  alerts: { collection: C.alertActions, time: 'created_at', fields: ['alert_id','match_id','visitor_id','alert_type','initial_level','created_at','triggered_at','status','acked_at','cst_started_at','handled_at'] },
  followups: { collection: C.followupJobs, time: 'due_at', fields: ['job_id','match_id','visitor_id','follow_round','session_no','due_at','status','completed_at'] },
  tasks: { collection: C.notificationTasks, time: 'created_at', fields: ['task_id','match_id','visitor_id','kind','status','created_at','delivery_result','notified_at','resolved_at'] },
  attempts: { collection: C.notificationAttempts, time: 'started_at', throughNow: true, fields: ['attempt_id','task_id','started_at','finished_at','state','late_result.kind','late_result.recorded_at'] },
  messages: { collection: C.notificationInbox, time: 'created_at', throughNow: true, fields: ['message_id','task_id','created_at','read_at'] }
});
module.exports = { DATASETS };
