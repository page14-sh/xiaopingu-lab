// 云函数入口：HTTP 触发
// 访问地址：https://xpg-demo-d3gzsswtcc3233ea0-1300577165.ap-shanghai.app.tcloudbase.com/xg-api/...
const core = require('./app-core.js');

exports.main = async (event) => {
  const method = (event.httpMethod || 'GET').toUpperCase();
  let rawPath = event.path || '/';
  // 兜底剥离网关前缀（当前网关已剥，保留以防配置变化）
  rawPath = rawPath.replace(/^\/xg-api(?=\/|$)/, '') || '/';
  const headers = event.headers || {};
  let bodyRaw = event.body || '';
  if (event.isBase64Encoded) bodyRaw = Buffer.from(bodyRaw, 'base64').toString('utf8');

  // query：HTTP 触发为 queryStringParameters（对象）；invoke 调试为 queryString（字符串）
  let qs = event.queryStringParameters || event.queryString;
  if (qs && typeof qs === 'object') qs = new URLSearchParams(qs).toString();

  const req = {
    method,
    url: rawPath + (qs ? '?' + qs : ''),
    headers,
    __bodyRaw: bodyRaw
  };
  let __resolve;
  const resPromise = new Promise((r) => { __resolve = r; });
  const res = {
    statusCode: 200, __headers: {},
    writeHead(code, hdrs) { this.statusCode = code; this.__headers = hdrs || {}; },
    end(body) { __resolve({ statusCode: this.statusCode, headers: this.__headers, body: body || '' }); }
  };

  await core.handleRequest(req, res);
  const result = await resPromise;
  return {
    statusCode: result.statusCode,
    headers: { ...result.headers },
    body: result.body,
    isBase64Encoded: false
  };
};
