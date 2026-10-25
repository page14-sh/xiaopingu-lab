const { createHash, createHmac } = require('node:crypto');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const hmac = (key, text) => createHmac('sha256', key).update(text).digest();
function smsHeaders(config, body, time) {
  const timestamp = Math.floor(time/1000), date = new Date(time).toISOString().slice(0,10), host = 'sms.tencentcloudapi.com';
  const signed = 'content-type;host', headers = `content-type:application/json\nhost:${host}\n`;
  const canonical = `POST\n/\n\n${headers}\n${signed}\n${hash(body)}`, scope = `${date}/sms/tc3_request`;
  const signingKey = hmac(hmac(hmac(`TC3${config.secretKey}`, date), 'sms'), 'tc3_request');
  const signature = createHmac('sha256', signingKey).update(`TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`).digest('hex');
  return { 'content-type': 'application/json', host, 'X-TC-Action': 'SendSms', 'X-TC-Version': '2021-01-11',
    'X-TC-Region': config.region || 'ap-guangzhou', 'X-TC-Timestamp': String(timestamp),
    Authorization: `TC3-HMAC-SHA256 Credential=${config.secretId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
    ...(config.token ? { 'X-TC-Token': config.token } : {}) };
}
function createNotificationProvider({ cloudbaseApp, bridgeSecret, functionName, appId, templates = {}, sms = {}, fetchImpl = fetch, now = Date.now, timeoutMs = 10000 } = {}) {
  return { async send(input) {
    const { recipient, channel, task, attempt_id, safety } = input;
    if (channel === 'miniprogram') {
      const template = templates[task.kind];
      if (!recipient?.openid || recipient.appid !== appId || !cloudbaseApp || !functionName || !bridgeSecret || Buffer.byteLength(bridgeSecret) < 32 ||
          !template?.templateId || !template.page || !template.data) return { kind: 'rejected', code: 'WX_NOT_CONFIGURED' };
      const payload = Buffer.from(JSON.stringify({ request_id: attempt_id, issued_at: now(), openid: recipient.openid,
        templateId: template.templateId, page: template.page, data: template.data, miniprogramState: template.miniprogramState || 'formal' })).toString('base64url');
      let timer;
      try {
        const response = await Promise.race([cloudbaseApp.callFunction({ name: functionName, data: { payload, signature: createHmac('sha256', bridgeSecret).update(payload).digest('hex') } }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timeout')), timeoutMs); })]);
        return typeof response.result === 'string' ? JSON.parse(response.result) : response.result;
      } catch { return { kind: 'unknown', code: 'WX_BRIDGE_RESPONSE_UNKNOWN' }; }
      finally { clearTimeout(timer); }
    }
    if (channel !== 'sms' || !safety) return { kind: 'rejected', code: 'CHANNEL_NOT_ALLOWED' };
    if (!recipient?.phone_verified || !/^\+[1-9]\d{6,14}$/.test(recipient.phone_e164 || '') ||
        !sms.secretId || !sms.secretKey || !sms.appId || !sms.templateId || !sms.signName) return { kind: 'rejected', code: 'SMS_NOT_CONFIGURED' };
    const body = JSON.stringify({ PhoneNumberSet: [recipient.phone_e164], SmsSdkAppId: sms.appId, SignName: sms.signName,
      TemplateId: sms.templateId, TemplateParamSet: sms.params || [], SessionContext: attempt_id });
    try {
      const response = await fetchImpl('https://sms.tencentcloudapi.com', { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(10000), headers: smsHeaders(sms, body, now()), body });
      const data = (await response.json())?.Response, sent = data?.SendStatusSet?.[0];
      if (sent?.Code === 'Ok') return data.SendStatusSet.length === 1 && typeof sent.SerialNo === 'string' && sent.SerialNo &&
        sent.SessionContext === attempt_id && sent.PhoneNumber === recipient.phone_e164
        ? { kind: 'accepted', code: 'SMS_OK', provider_receipt_id: sent.SerialNo }
        : { kind: 'unknown', code: 'SMS_RECEIPT_MISMATCH' };
      const code = data?.Error?.Code || sent?.Code;
      if (!code || code.startsWith('InternalError')) return { kind: 'unknown', code: 'SMS_RESPONSE_UNKNOWN' };
      return { kind: code.startsWith('RequestLimitExceeded') ? 'retryable' : 'rejected', code: `SMS_${code}` };
    } catch { return { kind: 'unknown', code: 'SMS_RESPONSE_UNKNOWN' }; }
  } };
}
function providerFromEnvironment(cloudbaseApp, env = process.env) {
  const json = (value) => { try { return value ? JSON.parse(value) : {}; } catch { return {}; } };
  return createNotificationProvider({ cloudbaseApp, appId: env.XPG_MINIPROGRAM_APPID, bridgeSecret: env.XPG_NOTIFY_BRIDGE_SECRET,
    functionName: env.XPG_NOTIFY_FUNCTION, templates: json(env.XPG_NOTIFY_TEMPLATES),
    sms: { ...json(env.XPG_SMS_CONFIG), secretId: env.XPG_SMS_SECRET_ID, secretKey: env.XPG_SMS_SECRET_KEY, token: env.XPG_SMS_TOKEN } });
}
module.exports = { createNotificationProvider, providerFromEnvironment, smsHeaders };
