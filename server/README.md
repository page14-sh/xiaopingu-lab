# 小平菇 Server

本模块用于本地演示 API。

启动：

```bash
npm run start:server
```

Docker Compose 启动：

```bash
docker compose -f server/docker-compose.yml up --build
```

或者在项目根目录：

```bash
npm run docker:server
```

默认地址：

```text
http://127.0.0.1:8787
```

数据文件：

```text
server/local-data.json
```

Docker Compose 模式下，数据会保存在 Docker volume：

```text
xiaopingu-server-data
```

常用 Docker 命令：

```bash
docker compose -f server/docker-compose.yml ps
docker compose -f server/docker-compose.yml logs -f
docker compose -f server/docker-compose.yml down
```

首次启动会拉取 `node:22-alpine` 镜像。如果 Docker Hub 访问失败，可以先配置 Docker 镜像源，或手动拉取一个可用的 Node 镜像后把 `server/Dockerfile` 第一行替换为该镜像。

支持接口：

- `GET /health`
- `POST /wechat/login`
- `/rest/v1/assessments`
- `/rest/v1/counselors`
- `/rest/v1/sessions`
- `/rest/v1/pcoms_ratings`
- `/rest/v1/visitor_users`

Supabase SQL 脚本放在 `server/migrations/`。
