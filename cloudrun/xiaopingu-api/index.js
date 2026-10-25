const http = require('http');
const path = require('path');
const cloudbase = require('@cloudbase/node-sdk');
const { createCloudBaseStore, createRequestHandler } = require('./app');
const { createStaticHandler } = require('./static');
const { providerFromEnvironment } = require('./assessment/notification-provider');
const {runtimePolicy,namespaceDatabase,disabledNotifications}=require('./runtime-policy');
const { llmProviderFromEnvironment } = require('./assessment/llm-provider');

const env = process.env.TCB_ENV;
const accessKey = process.env.CLOUDBASE_APIKEY;
const adminPassword = process.env.XPG_ADMIN_PASSWORD;
const demoCounselorPassword = process.env.XPG_DEMO_COUNSELOR_PASSWORD;
const sessionSecret = process.env.XPG_SESSION_SECRET;

if (!env || !accessKey || !adminPassword || !sessionSecret) {
  throw new Error('Required CloudBase runtime configuration is missing');
}

const policy=runtimePolicy();
const app = cloudbase.init({ env, accessKey });
const store = createCloudBaseStore(namespaceDatabase(app.database(),policy.prefix), { notificationProvider: policy.notificationsEnabled?providerFromEnvironment(app):disabledNotifications, llmProvider: policy.llmEnabled?llmProviderFromEnvironment():{ready:false} });
const apiHandler = createRequestHandler({
  store,
  adminPassword,
  demoCounselorPassword,
  sessionSecret,
  serviceSecrets: { matching: process.env.XPG_MATCH_SERVICE_SECRET, scheduler: process.env.XPG_SCHEDULER_SECRET },
  identityBridge: {
    secret: process.env.XPG_IDENTITY_BRIDGE_SECRET,
    appId: process.env.XPG_MINIPROGRAM_APPID,
    audience: process.env.XPG_IDENTITY_AUDIENCE
  },
  demoMode: process.env.XPG_DEMO_MODE === '1'
});
// The isolated API preview does not present the legacy PCOMS UI as the new product.
const handler = policy.preview ? apiHandler : createStaticHandler(path.join(__dirname, 'public'), apiHandler);

const port = Number(process.env.PORT || 8787);
http.createServer(handler).listen(port, '0.0.0.0', () => {
  console.log(`Xiaopingu CloudBase API listening on port ${port}`);
});
