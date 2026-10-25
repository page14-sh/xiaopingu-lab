// Independent scheduler entry. Configure an external scheduler for 09:00
// Asia/Shanghai. Secrets are read only from injected environment variables.
async function dispatchFollowups({ apiBase, secret, limit = 20, maxBatches = 20, fetchImpl = fetch, jobType = 'followup' }) {
  let base;
  try { base = new URL(apiBase); } catch { throw new Error('Invalid dispatch endpoint'); }
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname))) ||
      base.username || base.password || base.search || base.hash || typeof secret !== 'string' || Buffer.byteLength(secret) < 32 ||
      !['followup','notifications','expiry'].includes(jobType) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 100) {
    throw new Error('Invalid scheduler configuration');
  }
  const summary = { batches: 0, scanned: 0, queued: 0, blocked: 0, completed: 0, errors: 0, more_possible: false };
  if (jobType === 'notifications') Object.assign(summary,{sent:0,retry_wait:0,uncertain:0,cancelled:0,failed:0});
  if (jobType === 'expiry') Object.assign(summary,{reaped:0,skipped:0});
  for (let i = 0; i < maxBatches; i++) {
    let response;
    const endpoint = { followup: '/v1/xg/jobs/follow-dispatch', notifications: '/v1/xg/jobs/notification-deliver', expiry: '/v1/xg/jobs/events-expire' }[jobType];
    try { response = await fetchImpl(new URL(endpoint, base), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify({ limit })
    }); } catch { throw new Error('Scheduler request failed; retry the same scan later'); }
    if (!response.ok) throw new Error(`Scheduler HTTP ${response.status}`);
    const data = await response.json();
    if (!Number.isSafeInteger(data.scanned) || !Array.isArray(data.results) || !Array.isArray(data.errors)) throw new Error('Invalid scheduler response');
    summary.batches++; summary.scanned += data.scanned; summary.errors += data.errors.length;
    for (const result of data.results) {
      const state = result.outcome || result.status;
      if (['queued','blocked','completed','sent','retry_wait','uncertain','cancelled','failed','reaped','skipped'].includes(state) && typeof summary[state] === 'number') summary[state]++;
    }
    summary.more_possible = data.more_possible === true;
    if (summary.errors || !summary.more_possible) break;
  }
  return summary;
}
if (require.main === module) {
  dispatchFollowups({ apiBase: process.env.XPG_API_BASE, secret: process.env.XPG_SCHEDULER_SECRET })
    .then((summary) => { console.log(JSON.stringify(summary)); if (summary.errors || summary.more_possible) process.exitCode = 1; })
    .catch(() => { console.error('Follow-up scheduler failed; check configuration and retry.'); process.exitCode = 1; });
}
module.exports = { dispatchFollowups };
