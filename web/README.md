# 小平菇 Web

本模块包含所有 HTML 页面和 Web 端共享脚本。

CloudRun 线上地址：

```text
https://xiaopingu-api-308810-6-1300577165.sh.run.tcloudbase.com/
```

首页的“管理中心”按钮会在同页打开受保护的管理工作区；直接入口为 `/admin`。

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
密码：xiaopingu2026（仅本地文件服务；CloudBase 部署密码见项目根目录忽略提交的 `.env.cloudbase.local`）
```

也可以直接打开工作台：

```text
http://127.0.0.1:8080/counselor.html?cid=00000000-0000-4000-8000-000000000001
http://127.0.0.1:8080/counselor.html?cid=00000000-0000-4000-8000-000000000002
```


## 四评接口与上线状态（T21）

当前四评新增后端使用`/v1/xg`，以[API契约](../specs/assessment-foundation/api-contract.md)及[数据契约](../specs/assessment-foundation/data-contract.md)为准，不能执行原包SQL初始化。现有Web页面主要仍是旧准入/PCOMS演示，后端测试通过不表示完整四评表单/审核页面已实现或发布。现网地址不作为本地新增功能部署成功的证据；实际联调层次见[T21记录](../specs/assessment-foundation/t21-integration.md)。
