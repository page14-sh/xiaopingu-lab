const cloud = require('wx-server-sdk');
const cloudbase = require('@cloudbase/node-sdk');
const { createSubscribeHandler, createBridgeStore } = require('./handler');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
if (!process.env.TCB_ENV) throw new Error('Notification function environment is required');
const database = cloudbase.init({ env: process.env.TCB_ENV }).database();
exports.main = createSubscribeHandler({ secret: process.env.XPG_NOTIFY_BRIDGE_SECRET,
  store: createBridgeStore(database), send: (message) => cloud.openapi.subscribeMessage.send(message) });
