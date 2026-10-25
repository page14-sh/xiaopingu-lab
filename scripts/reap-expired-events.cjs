const { dispatchFollowups } = require('./dispatch-followups.cjs');
dispatchFollowups({ apiBase: process.env.XPG_API_BASE, secret: process.env.XPG_SCHEDULER_SECRET, jobType: 'expiry' })
  .then((summary) => { console.log(JSON.stringify(summary)); if (summary.errors || summary.more_possible) process.exitCode = 1; })
  .catch(() => { console.error('Expired-event cleanup failed; inspect the task result and retry.'); process.exitCode = 1; });
