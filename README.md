# 小平菇 · 心理咨询自助评估转介系统

> Lab Edition v1.2 — 含咨询师精准匹配

## 项目结构

```
xiaopingu-lab/
├── index.html          # 来访者评估端（主页面）
├── counselor.html      # 咨询师档案录入
├── supabase-config.js  # 数据后端配置（含建表SQL）
├── manifest.json       # PWA 配置
├── vercel.json         # Vercel 部署配置
└── package.json
```

## 本地预览

```bash
npx serve . -l 3000
```

## 启用数据后端

1. 在 [supabase.com](https://supabase.com) 创建免费项目
2. 复制 `supabase-config.js` 中的 SQL 到 SQL Editor 执行
3. 填入 `SUPABASE_URL` 和 `SUPABASE_ANON_KEY`
4. 将 `enableDataCollection` 改为 `true`

## 功能

- 来访者 4 步评估问卷 + 智能转介建议
- 咨询师 5 步档案录入（资质/取向/议题/方式/简介）
- 加权精准匹配：议题40% + 取向25% + 程度20% + 门槛15%
- 移动端响应式 + PWA + 草稿自动保存