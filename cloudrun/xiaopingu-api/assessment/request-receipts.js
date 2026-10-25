const { COLLECTIONS: C, AssessmentError, requireId, documentKey, scopeOf } = require('./model');
const { requestHash } = require('./request-hash');

function requestIdentity(principal, operation, input, event) {
  const payload = operation === 'start' ? {
    match_id: input.match_id, scale_code: input.scale_code, session_no: input.session_no,
    follow_round: input.follow_round ?? '', client_event_id: input.client_event_id
  } : operation === 'submit' ? {
    match_id: input.match_id, event_id: input.event_id,
    answers: input.answers ?? null, duration_ms: input.duration_ms ?? null,
    scale_code: event.scale_code, session_no: event.session_no, follow_round: event.follow_round,
    client_event_id: event.client_event_id ?? null
  } : { match_id: input.match_id, event_id: input.event_id, reason: input.reason ?? 'user_exit' };
  const hash = requestHash(payload);
  // HTTP requires request_id for submit/abandon. Deterministic fallback is only
  // for existing trusted internal callers; it is not a network bypass.
  const requestId = input.request_id ?? (operation === 'start' ? input.client_event_id : documentKey('internal', operation, hash));
  requireId(requestId, 'request_id');
  return {
    id: documentKey('request', principal.role, principal.subject, operation, requestId),
    request_id: requestId, request_hash: hash, operation,
    actor_id: principal.subject, actor_role: principal.role
  };
}

async function readReceipt(tx, identity, event) {
  const receipt = await tx.get(C.requestReceipts, identity.id);
  if (!receipt) return null;
  if (['request_id', 'request_hash', 'operation', 'actor_id', 'actor_role'].some((field) => receipt[field] !== identity[field])) {
    throw new AssessmentError('XG_IDEMPOTENCY_CONFLICT', '同一 request_id 不可用于不同请求内容');
  }
  if (!event || receipt.event_id !== event.event_id || receipt.match_id !== event.match_id) {
    throw new AssessmentError('XG_RECEIPT_STATE_MISSING', '请求回执与事件状态不一致，请联系管理员', 503);
  }
  return receipt;
}

function replayReceipt(receipt, event) {
  return { event, duplicated: true, replayed: true,
    request_status: receipt.outcome.status, request_revision: receipt.outcome.revision,
    error: receipt.outcome.error || undefined,
    statusCode: receipt.outcome.status_code >= 400 ? receipt.outcome.status_code : 200 };
}

async function saveReceipt(tx, identity, match, result, timestamp) {
  const event = result.event;
  const outcome = {
    status: event.status, revision: event.event_revision || 0, error: result.error || null,
    status_code: result.statusCode || (identity.operation === 'abandon' || result.duplicated ? 200 : 201)
  };
  await tx.put(C.requestReceipts, identity.id, {
    ...scopeOf(match), ...identity, event_id: event.event_id, outcome, completed_at: timestamp
  });
  return { ...result, replayed: false, request_status: outcome.status, request_revision: outcome.revision };
}

module.exports = { requestIdentity, readReceipt, replayReceipt, saveReceipt };
