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
