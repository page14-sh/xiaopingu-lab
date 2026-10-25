const cloud = require('wx-server-sdk');
const cloudbase = require('@cloudbase/node-sdk');
const { createIdentityHandler } = require('./handler');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
exports.main = createIdentityHandler({
  getWXContext: () => cloud.getWXContext(),
  parseContext: (context) => cloudbase.parseContext(context),
  secret: process.env.XPG_IDENTITY_BRIDGE_SECRET,
  appId: process.env.XPG_MINIPROGRAM_APPID,
  audience: process.env.XPG_IDENTITY_AUDIENCE
});
