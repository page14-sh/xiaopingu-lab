const { COLLECTIONS, requireId, AssessmentError } = require('./model');
const { DATASETS } = require('./statistics-source');

// Legacy assessments are written only by the trusted intake service, in a transaction
// with its private ownership record. They are not exposed as arbitrary xg writes.
const allowedCollections = new Set([...Object.values(COLLECTIONS), 'assessments']);

function checkCollection(name) {
  if (!allowedCollections.has(name)) throw new Error('Unknown assessment collection');
}

function checked(result) {
  // The installed SDK can return an error object instead of throwing on get/set.
  if (!result || result.code) {
    const error = new Error('CloudBase assessment operation failed');
    error.code = result?.code || 'XG_STORAGE_ERROR';
    throw error;
  }
  return result;
}

function singleDocument(result) {
  const { data } = checked(result);
  // Nontransactional get returns an array; transaction doc.get returns an object/null.
  if (Array.isArray(data)) return data[0] || null;
  if (data === null) return null;
  if (data && typeof data === 'object') return data;
  throw new Error('Unexpected CloudBase document response');
}

function createCloudBaseAssessmentStore(db, {
  maxTransactionAttempts = 8,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onTransactionEvent = () => {}
} = {}) {
  if (!Number.isSafeInteger(maxTransactionAttempts) || maxTransactionAttempts < 1 || maxTransactionAttempts > 20) {
    throw new Error('Invalid transaction retry budget');
  }
  function observe(event) {
    try { onTransactionEvent(event); }
    catch { process.emitWarning('Assessment transaction observer failed', { code: 'XG_OBSERVER_FAILED' }); }
  }
  function access(database) {
    return {
      async get(collection, id) {
        checkCollection(collection);
        requireId(id, 'document_id');
        return singleDocument(await database.collection(collection).doc(id).get());
      },
      async put(collection, id, record) {
        checkCollection(collection);
        requireId(id, 'document_id');
        const { _id, ...data } = record;
        const result = checked(await database.collection(collection).doc(id).set(data));
        const inserted = result.upsertedId || (Array.isArray(result.upserted)
          && result.upserted.some((item) => typeof item._id === 'string' && item._id.length));
        if (result.updated !== 1 && !inserted) {
          throw new Error('CloudBase did not persist the assessment document');
        }
      }
    };
  }

  return {
    get: access(db).get,
    async dueLlmJobs(at, limit) {
      const result = checked(await db.collection(COLLECTIONS.llmJobs)
        .where({status:db.command.in(['pending','retry_wait','blocked','processing']),next_attempt_at:db.command.lte(at)})
        .orderBy('next_attempt_at','asc').orderBy('_id','asc').field({_id:true}).limit(limit).get());
      if(!Array.isArray(result.data))throw new Error('Unexpected CloudBase query response');return result.data;
    },
    async recoverableLlmJobs(at, limit) {
      const result = checked(await db.collection(COLLECTIONS.llmJobs).where({status:'failed',recovery_eligible:true,recover_at:db.command.lte(at)})
        .orderBy('recover_at','asc').orderBy('_id','asc').field({_id:true}).limit(limit).get());
      if(!Array.isArray(result.data))throw new Error('Unexpected CloudBase query response');return result.data;
    },
    async llmJobsPage({status,after,limit}) {
      const result = checked(await db.collection(COLLECTIONS.llmJobs).where({...(status?{status}:{}),...(after?{_id:db.command.gt(after)}:{})})
        .orderBy('_id','asc').field(Object.fromEntries(['_id','job_id','event_id','match_id','status','generation','revision','attempts','total_attempts','model','prompt_version','created_at','updated_at','completed_at','next_attempt_at','recover_at','last_error'].map(k=>[k,true]))).limit(limit).get());
      if(!Array.isArray(result.data))throw new Error('Unexpected CloudBase query response');return result.data;
    },
    async expiredEvents(at, limit) {
      const result = checked(await db.collection(COLLECTIONS.events)
        .where({ status: db.command.in(['started','rejected']), expires_at: db.command.lte(at) })
        .orderBy('expires_at','asc').orderBy('_id','asc').field({ _id: true, event_id: true }).limit(limit).get());
      if (!Array.isArray(result.data)) throw new Error('Unexpected CloudBase query response'); return result.data;
    },
    async statisticsPage(name, { from, to, asOf, after, limit }) {
      if (!Object.hasOwn(DATASETS,name)) throw new Error('Unknown statistics source');
      const spec = DATASETS[name], command = db.command;
      const upper = spec.throughNow || asOf < to ? command.lte(asOf) : command.lt(to);
      const filter = { [spec.time]: spec.historical ? command.lte(asOf) : command.gte(from).and(upper),
        ...(after ? { _id: command.gt(requireId(after,'cursor')) } : {}) };
      const projection = Object.fromEntries(['_id',...spec.fields].map((key)=>[key,true]));
      const result = checked(await db.collection(spec.collection).where(filter).orderBy('_id','asc').field(projection).limit(limit).get());
      if (!Array.isArray(result.data)) throw new Error('Unexpected CloudBase query response'); return result.data;
    },
    async dueNotifications(at, limit) {
      const result = checked(await db.collection(COLLECTIONS.notificationTasks)
        .where({ status: db.command.in(['queued','retry_wait','blocked','processing']), next_attempt_at: db.command.lte(at) })
        .orderBy('next_attempt_at','asc').orderBy('_id','asc').limit(limit).get());
      if (!Array.isArray(result.data)) throw new Error('Unexpected CloudBase query response'); return result.data;
    },
    async notificationAttempts(taskId) {
      requireId(taskId,'task_id');
      const result = checked(await db.collection(COLLECTIONS.notificationAttempts).where({ task_id: taskId }).orderBy('number','desc').limit(100).get());
      if (!Array.isArray(result.data)) throw new Error('Unexpected CloudBase query response'); return result.data.reverse();
    },
    async messagesForRecipient(role, id, { limit, offset }) {
      requireId(id,'recipient_id');
      const result = checked(await db.collection(COLLECTIONS.notificationInbox).where({ recipient_role: role, recipient_id: id })
        .orderBy('created_at','desc').orderBy('_id','asc').skip(offset).limit(limit).get());
      if (!Array.isArray(result.data)) throw new Error('Unexpected CloudBase query response'); return result.data;
    },
    async dueFollowups(at, limit) {
      const result = checked(await db.collection(COLLECTIONS.followupJobs)
        .where({ status: db.command.in(['scheduled','blocked','queued']), next_check_at: db.command.lte(at) })
        .orderBy('next_check_at', 'asc').orderBy('_id', 'asc').limit(limit).get());
      if (!Array.isArray(result.data)) throw new Error('Unexpected CloudBase query response');
      return result.data;
    },
    // Only a confirmed transaction conflict retries automatically. A lost commit
    // response is ambiguous: the caller must retry the SAME request_id to consult
    // its atomically persisted receipt. Never blindly repeat an uncertain commit.
    async transaction(work) {
      for (let attempt = 1; attempt <= maxTransactionAttempts; attempt++) {
        let transaction;
        let phase = 'start';
        try {
          transaction = await db.startTransaction();
          phase = 'work';
          const result = await work(access(transaction));
          phase = 'commit';
          checked(await transaction.commit());
          observe({ type: 'committed', attempt });
          return result;
        } catch (error) {
          if (transaction) {
            try { checked(await transaction.rollback()); }
            catch (rollbackError) {
              observe({ type: 'rollback_failed', attempt, code: rollbackError?.code || 'UNKNOWN' });
            }
          }
          if (error?.code === 'DATABASE_TRANSACTION_CONFLICT') {
            observe({ type: 'conflict', attempt });
            if (attempt === maxTransactionAttempts) {
              throw new AssessmentError('XG_TRANSACTION_BUSY', '并发冲突暂未消退，请使用原 request_id 重试', 503);
            }
            await sleep(Math.min(400, 25 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 25));
            continue;
          }
          if (phase === 'commit') {
            observe({ type: 'commit_unknown', attempt, code: error?.code || 'UNKNOWN' });
            throw new AssessmentError('XG_COMMIT_UNKNOWN', '提交结果尚未确认，请使用原 request_id 重试', 503);
          }
          throw error;
        }
      }
    },
    async consentHistoryForVisitor(visitorId, scope, { limit, offset }) {
      requireId(visitorId, 'visitor_id');
      const result = checked(await db.collection(COLLECTIONS.consentHistory)
        .where({ visitor_id: visitorId, scope }).orderBy('revision', 'asc').skip(offset).limit(limit).get());
      if (!Array.isArray(result.data)) throw new Error('Unexpected CloudBase query response');
      return result.data;
    },
    async llmResultsForMatch(matchId, { limit, offset }) {
      requireId(matchId, 'match_id');
      const result = checked(await db.collection(COLLECTIONS.llmResults)
        .where({ match_id: matchId }).orderBy('_id', 'asc').skip(offset).limit(limit).get());
      if (!Array.isArray(result.data)) throw new Error('Unexpected CloudBase query response');
      return result.data;
    },
    async eventsForMatch(matchId) {
      requireId(matchId, 'match_id');
      const rows = [];
      const pageSize = 100;
      for (let offset = 0; ; offset += pageSize) {
        const result = checked(await db.collection(COLLECTIONS.events)
          .where({ match_id: matchId })
          .orderBy('session_no', 'asc').orderBy('_id', 'asc')
          .skip(offset).limit(pageSize).get());
        if (!Array.isArray(result.data)) throw new Error('Unexpected CloudBase query response');
        rows.push(...result.data);
        if (result.data.length < pageSize) return rows;
      }
    }
  };
}

module.exports = { createCloudBaseAssessmentStore };
