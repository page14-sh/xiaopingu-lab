# 小平菇 Miniprogram

本模块是微信小程序端。

启动方式：

```text
用微信开发者工具打开 miniprogram/ 目录
```

本地 API 配置在 `utils/config.js`：

```js
apiBase: 'http://192.168.3.54:8787',
supabaseUrl: 'http://192.168.3.54:8787'
```

开发者工具本地调试时，`project.private.config.json` 已关闭 `urlCheck`。

真机预览时，手机访问不到电脑上的 `127.0.0.1`。当前配置使用本机局域网 IP `192.168.3.54`，换网络或换机器后需要改成新机器的局域网 IP，或使用 HTTPS 内网穿透域名。
