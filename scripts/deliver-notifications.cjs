const { dispatchFollowups } = require('./dispatch-followups.cjs');
dispatchFollowups({ apiBase: process.env.XPG_API_BASE, secret: process.env.XPG_SCHEDULER_SECRET, jobType: 'notifications' })
  .then((summary) => { console.log(JSON.stringify(summary)); if (summary.errors || summary.uncertain || summary.failed || summary.more_possible) process.exitCode = 1; })
  .catch(() => { console.error('Notification worker failed; inspect task audit and retry the scan.'); process.exitCode = 1; });
