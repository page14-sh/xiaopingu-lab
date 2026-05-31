# 小平菇 · 心理咨询自助评估转介系统

> Lab Edition v1.2 — 含咨询师精准匹配

## 项目结构

```
xiaopingu-lab/
├── index.html              # 来访者评估端
├── counselor.html          # 咨询师档案录入
├── admin.html              # 数据管理后台
├── session.html            # PCOMS 评分填写
├── session-dashboard.html  # PCOMS 追踪面板
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
4. 填入 `supabase-config.js` 中的 URL 和 Key
5. 将 `enableDataCollection` 改为 `true`

## 功能

- 来访者 4 步评估问卷 + 智能转介建议
- 咨询师 5 步档案录入（资质/取向/议题/方式/简介）
- 加权精准匹配：20 维度 145 分制
- PCOMS 循证追踪（ORS/SRS 评分 + 临床预警）
- 诚信声明 + 管理后台审核
- PDF/Excel 导出
- 移动端响应式 + PWA + 草稿自动保存
- 滑动拼图验证码
