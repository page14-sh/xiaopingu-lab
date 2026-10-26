# 当前 CloudBase v2 Web 发布源码

正式页面由本目录的 HTML、JS、CSS 增量发布到既有静态托管。后端为 `cloudrun/xiaopingu-api/`，服务名 `xiaopingu-assessment`；`web/` 和旧 Supabase SQL 是历史演示资料，不是当前发布入口。

- [v2 源码与接口契约](../docs/v2-source-and-api.md)：独立填写凭证、咨询师编辑码、审批、冻结题面和后台接口。
- [完整链路操作](../docs/test-chain-walkthrough.md)：本机可视化入口连接 CloudBase 独立测试区。
- [迁移与运行说明](../specs/v2-cutover/operations.md)：旧记录保留、历史身份、归属待核对与恢复边界。

发布只上传实际 HTML/JS/CSS 文件；保留现有图片和不在本目录的资源。不要上传 README、私有账号、`.env*` 或测试服务器代码。

当前默认域名仍受平台浏览器访问限制；正式网页需已备案的自定义域名。联调入口 `http://127.0.0.1:8796/journey.html` 使用单独浏览器来源和合成数据，测试密码不授予正式库权限。
