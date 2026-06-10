# 小平菇 · 心理咨询自助评估转介系统

> Lab Edition v1.2 — 含咨询师精准匹配

> 分支说明：当前版本开始拆分为「来访者微信小程序 + 咨询师 Web 工作台 + 后台 Web 管理」。

## 项目结构

```
xiaopingu-lab/
├── index.html              # 来访者评估端
├── counselor.html          # 咨询师档案录入
├── admin.html              # 数据管理后台
├── session.html            # PCOMS 评分填写
├── session-dashboard.html  # PCOMS 追踪面板
├── miniprogram/            # 来访者微信小程序端
├── web-auth.js             # Web 端登录会话工具
├── supabase-config.js      # 数据后端配置（含匹配算法）
├── manifest.json           # PWA 配置
├── vercel.json             # Vercel 部署配置
└── supabase-setup.sql      # 建表 SQL
```

## 本地预览

```bash
python3 -m http.server 3000
# 或
npx serve . -l 3000
```

## 启用数据后端

1. 在 [supabase.com](https://supabase.com) 创建免费项目
2. 复制 `supabase-setup.sql` 到 SQL Editor 执行
3. 按需执行 `migration-*.sql` 迁移脚本
4. 执行 `migration-auth-split.sql`，启用小程序来访者身份与 Web 登录账号表
5. 填入 `supabase-config.js` 中的 URL 和 Key
6. 将 `enableDataCollection` 改为 `true`

## 微信小程序端

小程序源码位于 `miniprogram/`，覆盖来访者侧核心功能：

- 微信身份初始化（开发期可用 `devOpenid`）
- 创建评估记录
- 查看「我的评估」
- 填写 PCOMS ORS/SRS 评分

配置入口：

```js
// miniprogram/utils/config.js
module.exports = {
  apiBase: '',             // 正式版推荐填写自建 API / 云函数域名
  supabaseUrl: '...',
  supabaseAnonKey: '...',
  devOpenid: 'dev-openid-xiaopingu'
}
```

正式上线建议使用云函数或 API 完成 `wx.login` 的 `code2session`，不要在小程序端直接处理微信密钥。

## Web 登录边界

- `admin.html`：管理员 Web 登录，当前兼容原本的前端密码，并写入 `web-auth.js` 会话。
- `counselor.html`：咨询师 Web 工作台，当前兼容 `cid` / `edit_token` 入口，并写入咨询师会话。
- 目标方案见 `docs/auth-split-plan.md`。

## 功能

- 来访者 4 步评估问卷 + 智能转介建议
- 咨询师 5 步档案录入（资质/取向/议题/方式/简介）
- 加权精准匹配：20 维度 145 分制
- PCOMS 循证追踪（ORS/SRS 评分 + 临床预警）
- 诚信声明 + 管理后台审核
- PDF/Excel 导出
- 移动端响应式 + PWA + 草稿自动保存
- 滑动拼图验证码
- 来访者微信小程序端骨架
- Web 端管理员 / 咨询师会话边界
