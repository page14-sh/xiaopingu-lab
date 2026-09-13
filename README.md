# 小平菇 · 心理咨询自助评估转介系统

> Lab Edition v1.2 — 含咨询师精准匹配

项目已拆成三个可独立演示的模块：

```
xiaopingu-lab/
├── server/       # 本地 API 服务 + Supabase SQL 迁移
├── web/          # HTML Web 页面
├── miniprogram/  # 微信小程序端
└── docs/         # 设计与迁移说明
```

## CloudBase 演示环境

- 首页与 API：<https://xiaopingu-api-308810-6-1300577165.sh.run.tcloudbase.com/>
- 首页内管理中心：<https://xiaopingu-api-308810-6-1300577165.sh.run.tcloudbase.com/admin>
- 健康检查：<https://xiaopingu-api-308810-6-1300577165.sh.run.tcloudbase.com/health>
- 环境 ID：`xpg-demo-d3gzsswtcc3233ea0`（上海）
- 运行：同一个 CloudRun 容器托管首页、管理中心与 API；`0.25 CPU / 0.5 GB`，最小实例数 `0`，最大实例数 `2`
- 数据：CloudBase NoSQL，业务集合仅允许管理端访问，客户端统一经过 API

首页点击“管理中心”即可在同一页面进入后台；也可以直接打开 `/admin`。管理员密码保存在本机被 Git 忽略的 `.env.cloudbase.local` 中；不要把该文件提交或发送给他人。服务端 API Key 将于 `2026-12-04` 到期，届时需轮换后重新部署服务环境变量。

云端密码拆分配置（需部署新版服务后生效）：
- `XPG_ADMIN_PASSWORD`：管理中心密码，保留现有值。
- `XPG_DEMO_COUNSELOR_PASSWORD`：演示账号 `counselor` / `counselor2` 的独立密码，在 `.env.cloudbase.local` 中配置。
- 演示账号登录还要求 `XPG_DEMO_MODE=1`；未配置演示密码时拒绝账号登录，不回退使用管理员密码。编辑码登录不受影响。

部署时须同时更新服务代码和云托管环境变量，保留其他环境变量；仅修改本地 `.env.cloudbase.local` 不会改变远端配置。


CloudBase API 自动缩容到 0，长时间无访问后的第一次请求可能稍慢。验证：

```bash
npm run test:cloudbase
curl https://xiaopingu-api-308810-6-1300577165.sh.run.tcloudbase.com/health
```

### 同步本地演示数据

同步脚本读取被 Git 忽略的 `server/local-data.json`，按业务 `id` 合并到 CloudBase NoSQL。默认只预览；`--apply` 才会写入。脚本不会删除云端记录，也不会用时间更旧或相同的本地记录覆盖云端。

```bash
# 预览差异
npm run sync:cloudbase:data

# 应用同步
npm run sync:cloudbase:data -- --apply
```

当前已同步：16 条评估、6 条会话、9 条 PCOMS 评分和 1 条访客记录；云端保留 3 条咨询师记录。

## 分别启动

### 给本地 Agent 的启动指令

同事拉下项目后，可以直接让本地 agent 执行：

```text
请在项目根目录启动小平菇本地演示环境：
1. 启动服务端：npm run start:server
2. 启动 Web 页面：npm run start:web
3. 告诉我 Web 首页和 server health 地址
4. 如果我要调试小程序，请检查 miniprogram/utils/config.js 里的本机局域网 IP 是否正确
```

启动后访问：

```text
Web 首页：http://127.0.0.1:8080/index.html
Server health：http://127.0.0.1:8787/health
```

如果本机没有 Node/npm，但有 Docker，可以让 agent 执行：

```text
请用 Docker Compose 启动 server：docker compose -f server/docker-compose.yml up --build
```

### 手动启动

服务端：

```bash
npm run start:server
```

Docker 方式启动服务端：

```bash
npm run docker:server
```

只有 Docker、没有 Node/npm 时：

```bash
docker compose -f server/docker-compose.yml up --build
```

Web 页面：

```bash
npm run start:web
```

然后打开：

```text
http://127.0.0.1:8080/index.html
```

本地文件服务演示咨询师账号：

```text
账号：counselor
密码：xiaopingu2026（仅本地文件服务）
```

小程序端：

```text
用微信开发者工具打开 miniprogram/ 目录
```

当前小程序开发配置指向 CloudRun 的微信域名。正式发布前仍需在微信后台绑定 CloudBase 环境和合法请求域名，并把演示用 `/wechat/login` 切换为 `wx.cloud` 原生身份。

开发者工具本地调试时，小程序当前会访问：

```text
http://192.168.3.54:8787
http://127.0.0.1:8787
http://localhost:8787
```

其中 `192.168.3.54` 是当前机器的局域网 IP。换机器或换 Wi-Fi 后，请让本地 agent 先用 `ifconfig`/系统网络信息确认新 IP，并更新 `miniprogram/utils/config.js` 的 `apiBase`、`supabaseUrl` 和 `localApiHosts`。

## 数据后端

本地演示默认使用 `server/local-api-server.js`，数据写入 `server/local-data.json`。该文件已被 `.gitignore` 忽略。

如果使用 Docker Compose，数据会写入 Docker volume `xiaopingu-server-data`，换机器演示时只需要安装 Docker。

如需切回 Supabase：

1. 在 Supabase SQL Editor 执行 `server/migrations/supabase-setup.sql`
2. 按需执行 `server/migrations/migration-*.sql`
3. 将 `web/supabase-config.js` 和 `miniprogram/utils/config.js` 改回线上 API 地址

## 模块说明

- `server/`：本地 REST API，兼容项目现有 `/rest/v1/...` 调用形状，并提供小程序开发用 `/wechat/login`
- `web/`：来访者评估、咨询师入驻、后台管理、PCOMS 页面
- `miniprogram/`：来访者微信小程序端，覆盖创建评估、查看我的评估、填写 PCOMS 评分
