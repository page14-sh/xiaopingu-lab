# 线上旧链路的定点修复文件

这些文件来自 2026-10-25 实际静态托管源码，修复前哈希在 `outputs/security/source-baseline.json`。它们比仓库原 `web/` 更新。本目录不是完整站点，不应整目录替换线上资源；其余 C/V/A 页面、样式、图片和认证资源继续使用原站点文件。

本轮只上传：`counselor.html`、`index.html`、`supabase-config.js`、`my-assessment.html`、`c1-work.html`、`assets/xg-config.js`、`session.html`。发布前核对远端版本，发布后比对实际下载哈希。

真实数据仍在旧集合，旧链路分别使用 `xpg-rest` 与 `xg-api`。新版四评后端在独立预览服务中，不能仅改 API URL 就把这些页面切到新版契约。

详见 [安全闭环记录](../specs/assessment-foundation/security-closure.md)。
