# 随访调度适配器（未部署、未启用）

本轮保留真实通知关闭，未添加任何线上 cron。这个适配器面向新版受认证的 `/v1/xg/jobs/follow-dispatch`，只生成到期任务，不发送消息，也不调用旧 `xg-api` 会伪记发送结果的旧分发器。

目录已包含 `index.js` 入口与 `dispatch-followups.cjs` 调度实现（来自同名脚本）。使用支持 fetch 的 Node.js 运行时，保持函数非匿名调用；部署并测试后再添加匹配 `XPG_FOLLOWUP_TRIGGER` 的 Timer。初始 `XPG_FOLLOWUP_SCHEDULER_ENABLED=0`。

启用前还需确定目标正式服务、随访同意与触达策略、运行频率、告警负责人。凭据从环境变量注入，不使用前端令牌。后端现有事务及任务 ID 保证重复扫描不会重复生成同一轮随访。一次触发只扫描一批，`more_possible` 为真时需要后续调度继续扫描，不能报告全部完成。
