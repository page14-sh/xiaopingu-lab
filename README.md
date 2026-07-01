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

本地演示咨询师账号：

```text
账号：counselor
密码：xiaopingu2026
```

小程序端：

```text
用微信开发者工具打开 miniprogram/ 目录
```

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
