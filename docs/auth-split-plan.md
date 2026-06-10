# 来访者小程序 + Web 登录拆分方案

## 目标边界

- 来访者：迁移到微信小程序，使用微信 `openid` 识别身份。
- 咨询师：继续使用 Web，但由 `cid`/`edit_token` 访问逐步迁移为 Web 登录。
- 管理员：继续使用 Web，但由前端固定密码逐步迁移为 Web 登录。

## 身份模型

### 来访者

小程序调用 `wx.login()` 获取 code，再由后端换取 `openid`。实验阶段可用小程序配置里的 mock openid 跑通页面，但正式版必须使用云函数或 API。

推荐绑定关系：

```text
visitor_users.openid -> visitor_users.id -> assessments.visitor_user_id
```

同时在 `assessments.visitor_openid` 保留冗余字段，方便小程序低成本查询“我的评估”。

### 咨询师

短期兼容：

```text
edit_token / cid -> counselor_id -> Web session
```

目标形态：

```text
counselor_web_accounts -> counselor_id -> only own match requests
```

### 管理员

短期兼容：

```text
admin password -> sessionStorage web session
```

目标形态：

```text
admin_web_accounts / Supabase Auth role=admin -> management APIs
```

## 迁移步骤

1. 执行 `migration-auth-split.sql`，新增身份表与 `assessments` 绑定字段。
2. 在微信小程序后台配置合法 request 域名：
   - Supabase REST 域名，或
   - 自建 API / 云函数域名。
3. 小程序端先跑通：
   - 微信登录
   - 创建评估
   - 查看我的评估
   - 提交 PCOMS
4. Web 端逐步把 `admin.html`、`counselor.html?cid=` 的入口替换成账号登录。
5. 正式上线前，把所有敏感读写改到服务端 API，前端不再直接持有可读全表的 anon key。

## 当前实现说明

本分支新增了：

- `miniprogram/`：来访者小程序功能骨架。
- `web-auth.js`：后台与咨询师 Web 登录会话工具。
- `migration-auth-split.sql`：身份拆分数据库迁移。

现有 H5 来访者页面仍保留，方便回滚和对照迁移。
