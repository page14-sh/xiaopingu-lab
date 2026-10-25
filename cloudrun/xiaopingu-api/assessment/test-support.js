const { COLLECTIONS } = require('./model');
const { defaultVersionBundle, contentHash } = require('./provenance');
const { DATASETS } = require('./statistics-source');

// Test data only. Production startup never publishes or seeds these versions.
function assessmentVersionSeed() {
  const bundle = defaultVersionBundle();
  const metadata = { published_by: 'test', published_at: '2026-10-25T00:00:00.000Z' };
  return [
    { collection: COLLECTIONS.itemVersions, id: bundle.item_version,
      record: { version: bundle.item_version, definition: bundle.catalog, content_hash: contentHash(bundle.catalog), ...metadata } },
    { collection: COLLECTIONS.ruleVersions, id: bundle.rule_version,
      record: { version: bundle.rule_version, definition: bundle.rules, content_hash: contentHash(bundle.rules), ...metadata } },
    { collection: COLLECTIONS.assessmentRelease, id: 'current', record: {
      item_version: bundle.item_version, rule_version: bundle.rule_version,
      item_hash: contentHash(bundle.catalog), rule_hash: contentHash(bundle.rules), revision: 1, ...metadata
    } }
  ];
}

// A rollback-capable, serial test store. It models atomic commits, not CloudBase MVCC.
function memoryAssessmentStore({ withVersions = true } = {}) {
  let records = Object.fromEntries([...Object.values(COLLECTIONS), 'assessments'].map((name) => [name, new Map()]));
  if (withVersions) for (const { collection, id, record } of assessmentVersionSeed()) {
    records[collection].set(id, { ...record, _id: id });
  }
  let pending = Promise.resolve();
  let failCollection;
  const copy = (value) => value == null ? null : structuredClone(value);
  function access(data) {
    return {
      async get(collection, id) { return copy(data[collection].get(id)); },
      async put(collection, id, record) {
        if (collection === failCollection) {
          failCollection = undefined;
          throw new Error('Injected storage failure');
        }
        data[collection].set(id, { ...copy(record), _id: id });
      }
    };
  }
  return {
    get: (...args) => access(records).get(...args),
    async dueLlmJobs(at,limit) { return [...records[COLLECTIONS.llmJobs].values()].filter(j=>['pending','retry_wait','blocked','processing'].includes(j.status)&&typeof j.next_attempt_at==='string'&&j.next_attempt_at<=at)
      .sort((a,b)=>a.next_attempt_at.localeCompare(b.next_attempt_at)||a._id.localeCompare(b._id)).slice(0,limit).map(j=>({_id:j._id})); },
    async recoverableLlmJobs(at,limit) { return [...records[COLLECTIONS.llmJobs].values()].filter(j=>j.status==='failed'&&j.recovery_eligible===true&&typeof j.recover_at==='string'&&j.recover_at<=at)
      .sort((a,b)=>a.recover_at.localeCompare(b.recover_at)||a._id.localeCompare(b._id)).slice(0,limit).map(j=>({_id:j._id})); },
    async llmJobsPage({status,after,limit}) { return [...records[COLLECTIONS.llmJobs].values()].filter(j=>(!status||j.status===status)&&(!after||j._id>after)).sort((a,b)=>a._id.localeCompare(b._id)).slice(0,limit).map(copy); },
    async expiredEvents(at,limit) { return [...records[COLLECTIONS.events].values()].filter((e)=>['started','rejected'].includes(e.status)&&typeof e.expires_at==='string'&&e.expires_at<=at)
      .sort((a,b)=>a.expires_at.localeCompare(b.expires_at)||a._id.localeCompare(b._id)).slice(0,limit).map((e)=>({_id:e._id,event_id:e.event_id})); },
    async statisticsPage(name,{from,to,asOf,after,limit}) {
      const spec=DATASETS[name], inclusive=spec.throughNow||asOf<to, upper=inclusive?asOf:to;
      return [...records[spec.collection].values()].filter((row)=>typeof row[spec.time]==='string'&&(!after||row._id>after)&&
        (spec.historical?row[spec.time]<=asOf:row[spec.time]>=from&&(inclusive?row[spec.time]<=upper:row[spec.time]<upper)))
        .sort((a,b)=>a._id.localeCompare(b._id)).slice(0,limit).map((row)=>{
          const result={_id:row._id};for(const field of spec.fields){const parts=field.split('.');if(parts.length===1){if(row[field]!==undefined)result[field]=copy(row[field]);}
            else if(row[parts[0]]?.[parts[1]]!==undefined){result[parts[0]]||={};result[parts[0]][parts[1]]=copy(row[parts[0]][parts[1]]);}}
          return result;
        });
    },
    async dueNotifications(at, limit) {
      return [...records[COLLECTIONS.notificationTasks].values()].filter((r) => ['queued','retry_wait','blocked','processing'].includes(r.status) && typeof r.next_attempt_at === 'string' && r.next_attempt_at <= at)
        .sort((a,b)=>a.next_attempt_at.localeCompare(b.next_attempt_at)||a._id.localeCompare(b._id)).slice(0,limit).map(copy);
    },
    async notificationAttempts(taskId) { return [...records[COLLECTIONS.notificationAttempts].values()].filter((r)=>r.task_id===taskId).sort((a,b)=>a.number-b.number).slice(-100).map(copy); },
    async messagesForRecipient(role,id,{limit,offset}) { return [...records[COLLECTIONS.notificationInbox].values()].filter((r)=>r.recipient_role===role&&r.recipient_id===id)
      .sort((a,b)=>b.created_at.localeCompare(a.created_at)||a._id.localeCompare(b._id)).slice(offset,offset+limit).map(copy); },
    async dueFollowups(at, limit) {
      return [...records[COLLECTIONS.followupJobs].values()]
        .filter((r) => ['scheduled','blocked','queued'].includes(r.status) && typeof r.next_check_at === 'string' && r.next_check_at <= at)
        .sort((a,b) => a.next_check_at.localeCompare(b.next_check_at) || a._id.localeCompare(b._id)).slice(0, limit).map(copy);
    },
    transaction(work) {
      const result = pending.then(async () => {
        const snapshot = structuredClone(records);
        const output = await work(access(snapshot));
        records = snapshot;
        return output;
      });
      pending = result.then(() => undefined, () => undefined);
      return result;
    },
    async eventsForMatch(matchId) {
      return [...records[COLLECTIONS.events].values()]
        .filter((row) => row.match_id === matchId)
        .sort((a, b) => a.session_no - b.session_no || a._id.localeCompare(b._id))
        .map(copy);
    },
    async llmResultsForMatch(matchId, { limit, offset }) {
      return [...records[COLLECTIONS.llmResults].values()].filter((row) => row.match_id === matchId)
        .sort((a, b) => a._id.localeCompare(b._id)).slice(offset, offset + limit).map(copy);
    },
    async consentHistoryForVisitor(visitorId, scope, { limit, offset }) {
      return [...records[COLLECTIONS.consentHistory].values()]
        .filter((row) => row.visitor_id === visitorId && row.scope === scope)
        .sort((a, b) => a.revision - b.revision).slice(offset, offset + limit).map(copy);
    },
    failNextWriteTo(collection) { failCollection = collection; },
    snapshot() { return structuredClone(records); }
  };
}

module.exports = { memoryAssessmentStore, assessmentVersionSeed };
