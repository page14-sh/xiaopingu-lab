# 小平菇 Miniprogram

本模块是微信小程序端。

启动方式：

```text
用微信开发者工具打开 miniprogram/ 目录
```

API 配置在 `utils/config.js`，当前默认指向 CloudRun 演示服务：

```js
apiBase: 'https://xiaopingu-api-xpg-demo-d3gzsswtcc3233ea0-1300577165.ap-shanghai.run.wxcloudrun.com',
supabaseUrl: 'https://xiaopingu-api-xpg-demo-d3gzsswtcc3233ea0-1300577165.ap-shanghai.run.wxcloudrun.com'
```

开发者工具本地调试时，`project.private.config.json` 已关闭 `urlCheck`。

当前 `/wechat/login` 仅用于演示环境。正式上传前需要在微信后台绑定 CloudBase 环境和合法请求域名，并改用 `wx.cloud` 原生身份获取 OPENID。


## 四评适配边界（T21）

`utils/xg-api.js`已提供`wx.cloud`身份桥会话交换、`/v1/xg`请求及同步触发的订阅授权辅助函数；与旧`/wechat/login`演示登录分开。需要在目标环境发布`cloudfunctions/xg-identity`并注入双方一致的桥密钥/AppID/audience。当前已有页面仍含旧PCOMS流程，不把辅助客户端模块等同于完整四评页面或真机联调通过。

接口以[当前四评契约](../specs/assessment-foundation/api-contract.md)为准；部署、合法域名、真机身份与订阅消息配置的验证范围见[T21记录](../specs/assessment-foundation/t21-integration.md)。演示账号不得绕过真实四评身份/同意检查。
