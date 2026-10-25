const { createHmac, createHash, timingSafeEqual } = require('node:crypto');
function createSubscribeHandler({ secret, store, send, now = Date.now }) {
  return async function handler(event) {
    if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) return { kind: 'rejected', code: 'BRIDGE_NOT_CONFIGURED' };
    if (typeof event?.payload !== 'string' || event.payload.length > 20000 || typeof event.signature !== 'string' || !/^[a-f0-9]{64}$/.test(event.signature)) return { kind: 'rejected', code: 'BRIDGE_UNAUTHORIZED' };
    const expected = createHmac('sha256', secret).update(event.payload).digest();
    if (!timingSafeEqual(expected, Buffer.from(event.signature, 'hex'))) return { kind: 'rejected', code: 'BRIDGE_UNAUTHORIZED' };
    let body;
    try { body = JSON.parse(Buffer.from(event.payload, 'base64url').toString('utf8')); } catch { return { kind: 'rejected', code: 'BRIDGE_BAD_REQUEST' }; }
    if (!Number.isSafeInteger(body.issued_at) || Math.abs(now()-body.issued_at) > 60000 ||
        !/^[a-f0-9]{64}$/.test(body.request_id || '') || !/^[A-Za-z0-9_-]{1,128}$/.test(body.openid || '') ||
        typeof body.templateId !== 'string' || !body.templateId || typeof body.page !== 'string' ||
        !body.data || Object.getPrototypeOf(body.data) !== Object.prototype || !['formal','trial','developer'].includes(body.miniprogramState)) return { kind: 'rejected', code: 'BRIDGE_BAD_REQUEST' };
    const message = { touser: body.openid, templateId: body.templateId, page: body.page, data: body.data, miniprogramState: body.miniprogramState, lang: 'zh_CN' };
    const hash = createHash('sha256').update(JSON.stringify(message)).digest('hex');
    let claim;
    try { claim = await store.claim(body.request_id, hash); } catch { return { kind: 'unknown', code: 'BRIDGE_CLAIM_UNKNOWN' }; }
    if (claim) return claim.hash !== hash ? { kind: 'rejected', code: 'BRIDGE_ID_CONFLICT' } : claim.result || { kind: 'unknown', code: 'BRIDGE_PENDING' };
    let result;
    try {
      const response = await send(message);
      const code = response?.errCode ?? response?.errcode;
      result = code === 0 ? { kind: 'accepted', code: 'WX_OK' } : Number.isInteger(code)
        ? { kind: code === -1 ? 'retryable' : 'rejected', code: `WX_${code}` } : { kind: 'unknown', code: 'WX_RESPONSE_UNKNOWN' };
    } catch (error) {
      const code = error?.errCode ?? error?.errcode;
      result = Number.isInteger(code) ? { kind: code === -1 ? 'retryable' : 'rejected', code: `WX_${code}` } : { kind: 'unknown', code: 'WX_RESPONSE_UNKNOWN' };
    }
    try { await store.complete(body.request_id, hash, result); } catch { return { kind: 'unknown', code: 'BRIDGE_COMMIT_UNKNOWN' }; }
    return result;
  };
}
function createBridgeStore(db) {
  const check = (r) => { if (!r || r.code) throw new Error('Bridge database error'); return r; };
  const written = (r) => {
    check(r);
    if (r.updated !== 1 && !r.upsertedId && !(Array.isArray(r.upserted) && r.upserted.some((item) => item._id))) throw new Error('Bridge receipt was not persisted');
  };
  async function transaction(work) {
    const tx = await db.startTransaction();
    try { const result = await work(tx); check(await tx.commit()); return result; }
    catch (error) { try { await tx.rollback(); } catch { error.rollbackFailed = true; } throw error; }
  }
  const get = async (tx, id) => { const r = check(await tx.collection('xg_notification_bridge').doc(id).get()); return Array.isArray(r.data) ? r.data[0] : r.data; };
  return {
    claim: (id, hash) => transaction(async (tx) => {
      const old = await get(tx, id); if (old) return old;
      written(await tx.collection('xg_notification_bridge').doc(id).set({ hash, status: 'pending' })); return null;
    }),
    complete: (id, hash, result) => transaction(async (tx) => {
      const old = await get(tx, id); if (!old || old.hash !== hash) throw new Error('Bridge receipt mismatch');
      if (old.result) {
        if (JSON.stringify(old.result) !== JSON.stringify(result)) throw new Error('Bridge result is immutable');
        return;
      }
      written(await tx.collection('xg_notification_bridge').doc(id).set({ hash, status: 'complete', result }));
    })
  };
}
module.exports = { createSubscribeHandler, createBridgeStore };
