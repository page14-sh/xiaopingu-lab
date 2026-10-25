// 云函数入口：HTTP 触发
// 访问地址：https://xpg-demo-d3gzsswtcc3233ea0-1300577165.ap-shanghai.app.tcloudbase.com/xpg-rest/...
const core = require('./app.js');

exports.main = async (event) => {
  const method = (event.httpMethod || 'GET').toUpperCase();
  let rawPath = event.path || '/';
  rawPath = rawPath.replace(/^\/xpg-rest(?=\/|$)/, '') || '/';
  const headers = event.headers || {};
  let bodyRaw = event.body || '';
  if (event.isBase64Encoded) bodyRaw = Buffer.from(bodyRaw, 'base64').toString('utf8');

  let qs = event.queryStringParameters || event.queryString;
  if (qs && typeof qs === 'object') qs = new URLSearchParams(qs).toString();

  const req = { method, url: rawPath + (qs ? '?' + qs : ''), headers, __bodyRaw: bodyRaw };
  let __resolve;
  const resPromise = new Promise((r) => { __resolve = r; });
  const res = {
    statusCode: 200, __headers: {},
    writeHead(code, hdrs) { this.statusCode = code; this.__headers = hdrs || {}; },
    end(body) { __resolve({ statusCode: this.statusCode, headers: this.__headers, body: body || '' }); }
  };

  await core.handleRequest(req, res);
  const result = await resPromise;
  return { statusCode: result.statusCode, headers: { ...result.headers }, body: result.body, isBase64Encoded: false };
};
