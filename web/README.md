# 小平菇 Web

本模块包含所有 HTML 页面和 Web 端共享脚本。

启动：

```bash
npm run start:web
```

访问：

```text
http://127.0.0.1:8080/index.html
```

本地 API 配置在 `web/supabase-config.js`：

```js
url: 'http://127.0.0.1:8787'
```

演示前请先启动 `server` 模块。

本地演示咨询师账号：

```text
账号：counselor   对应 本地演示咨询师
账号：counselor2  对应 调试咨询师
密码：xiaopingu2026
```

也可以直接打开工作台：

```text
http://127.0.0.1:8080/counselor.html?cid=00000000-0000-4000-8000-000000000001
http://127.0.0.1:8080/counselor.html?cid=00000000-0000-4000-8000-000000000002
```
