const http = require('http');
const path = require('path');
const cloudbase = require('@cloudbase/node-sdk');
const { createCloudBaseStore, createRequestHandler } = require('./app');
const { createStaticHandler } = require('./static');

const env = process.env.TCB_ENV;
const accessKey = process.env.CLOUDBASE_APIKEY;
const adminPassword = process.env.XPG_ADMIN_PASSWORD;
const demoCounselorPassword = process.env.XPG_DEMO_COUNSELOR_PASSWORD;
const sessionSecret = process.env.XPG_SESSION_SECRET;

if (!env || !accessKey || !adminPassword || !sessionSecret) {
  throw new Error('Required CloudBase runtime configuration is missing');
}

const app = cloudbase.init({ env, accessKey });
const store = createCloudBaseStore(app.database());
const apiHandler = createRequestHandler({
  store,
  adminPassword,
  demoCounselorPassword,
  sessionSecret,
  demoMode: process.env.XPG_DEMO_MODE === '1'
});
const handler = createStaticHandler(path.join(__dirname, 'public'), apiHandler);

const port = Number(process.env.PORT || 8787);
http.createServer(handler).listen(port, '0.0.0.0', () => {
  console.log(`Xiaopingu CloudBase API listening on port ${port}`);
});
