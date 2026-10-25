# T17｜通知发送、重试与处理闭环

日期：2026-10-25。状态：本地实现及专项验收完成；未部署、未配置真实通道，也未向真实用户发送消息。

## 已完成

- T16随访队列和T13原始提醒接入统一持久发送任务；提醒计算结果、动作台账与发送任务同事务保存。
- worker领取租约、发送前复核、有限退避重试、站内兜底、结果未知隔离和管理员核对。
- 微信订阅消息签名桥及去重回执、腾讯云短信适配器，短信仅允许安全线。
- 私有通知地址绑定、站内信读取/已读、咨询师ack/CST回写、电话跟进要求。
- 独立发送扫描入口和脚本，所有外部调用均在数据库事务之外。

新增6个私有集合，声明共36个：xg_notification_attempts、xg_notification_inbox、xg_notification_recipients、xg_notification_audit、xg_notification_bridge、xg_alert_actions。xg_notification_tasks沿用T16，并增加到期扫描索引。集合声明不等于实际云端资源已创建。

## 状态与计量

| 状态/事实 | 含义 |
| --- | --- |
| queued | 有持久任务，尚未发起发送 |
| processing + prepared | worker取得租约，尚未进入外部调用阶段 |
| processing + dispatching | 已提交发送意图，开始调用通道；sent_at在此记录 |
| retry_wait | 服务商明确拒绝且可重试，等待next_attempt_at |
| blocked | 当前同意、开关或业务条件不允许发送，后续扫描重查 |
| sent + provider_accepted | 服务商接口明确受理；不等于用户收到或阅读 |
| sent + inapp_stored | 已保存可读取的站内消息；不等于用户已读 |
| uncertain | 可能已经发出但结果不确定，不自动重试外部调用 |
| cancelled | 随访已完成、提醒已关闭或来源失效，停止待发送工作 |
| failed | 任务或收件归属等异常，停止自动处理并留待核对 |

每次尝试单独保存channel、开始/结束时间、规范化结果、错误码和服务商回执ID。不会保存或返回完整请求头、服务商原始响应、密钥或手机号。

任务sent_at表示发起阶段，notified_at表示确认服务商受理或站内保存；站内信read_at必须由用户显式标记。提醒acked_at与CST的handled_at独立，发送成功不会自动确认或关闭提醒。

随访档案同步保存对应轮次的pending/failed/unknown/sent结果及通道。主通道失败而站内兜底成功时，任务标明primary_failed和inapp_stored，原始失败仍留在尝试记录中；不能把它统计为微信/短信成功。

## 并发、重试与未知结果

默认租约60秒，使用随机lease_token和确定attempt_id。只有持有当前租约且尚未过期的worker可以进入发送阶段；过期旧worker不能覆盖新任务状态。

- prepared阶段崩溃：过期后可安全重新领取，原owner在发送前被拦截。
- dispatching阶段失联：可能已经产生外部副作用，转uncertain，绝不当作普通失败自动重发。
- 服务商明确临时拒绝：默认最多3次主通道尝试，按1分钟、2分钟退避；预算耗尽转站内信。
- 永久拒绝、缺订阅授权或未配置通道：直接站内兜底，不记录虚假的外部成功。
- 未知结果：条件仍允许时保存一次站内提示，同时保留uncertain，等待人工核对。
- 已发出但保存结果失败：不会再次调用服务商；租约恢复按未知结果处理。
- 重复回执不改变计数；迟到回执只追加尝试事实，不覆盖已取消/新版本任务。

站内消息使用task_id作为主键，同一业务只保存一条。外部系统不提供端到端“恰好一次”保证；本实现禁止对未知结果盲目重试。跨通道可能同时收到外部消息和站内兜底，但业务提醒ID始终一致，不能把两者算成两个告警。

### 发送前复核

领取时和真正发起前均检查当前业务状态，最终复核与发送意图在同一事务内提交。

- 随访：原周期/轮次/到期时间、是否已答、当前followup同意版本、来访可用状态、collection_paused。
- 提醒：当前有效原始信号、组合修订、处理是否已关闭、周期归属、全局/单案/紧急停用优先级。
- 发送授权通过后发生的撤销不能撤回已经进入外部系统的请求，因此保留授权点与迟到结果审计，不承诺取消已发出的消息。

提醒开关修改不重新计分、不批量重新发送历史sent任务。原始信号失效或CST关闭会取消待发送工作；已经sent的事实保留。

## 通道实现

### 微信订阅消息

CloudRun通过已配置的Event Function `xg-subscribe-send` 调用微信OpenAPI。桥接请求携带HMAC签名、60秒时效及attempt_id；函数先写入私有去重记录，再在事务外调用 `cloud.openapi.subscribeMessage.send`。相同尝试重复到达只读取原回执；处理中或提交结果未知时不会再次调用微信。

实现：[云函数](../../cloudfunctions/xg-subscribe-send/handler.js)、[CloudRun适配器](../../cloudrun/xiaopingu-api/assessment/notification-provider.js)。包中声明subscribeMessage.send权限，依赖沿用项目固定的wx-server-sdk与CloudBase Node SDK版本。调用方式及订阅错误分类参考 [CloudBase官方订阅消息示例](https://docs.cloudbase.net/recipes/add-subscribe-message-cloud-function)。

微信订阅授权与业务知情同意是两回事。小程序新增 `requestXgSubscription(templateId)` 辅助函数，须在用户点击回调中立即调用，不能先await登录/网络。函数只返回平台是否接受，不伪造业务同意或发送额度；最终是否可发送由微信接口判定。用户未授权/额度不足时按失败兜底，不跳过平台授权。

来访的openid/appid仅在可信微信身份交换后写入私有通知地址集合，登录响应不增加openid。咨询师地址只能由管理员核验后绑定。

### 安全短信

采用腾讯云SendSms 2021-01-11接口及TC3签名，固定访问官方HTTPS域名；只允许DISSOC安全任务使用sms，普通随访/提醒不能借用短信通道。

只有业务Code=Ok且回执与本次SessionContext、收件号码一致时才记为受理。HTTP成功本身不是业务成功；SessionContext仅作关联，不被当作服务商幂等锁。[发送接口](https://cloud.tencent.com/document/api/382/55981)、[TC3签名规则](https://cloud.tencent.com/document/product/266/31757)。

任何短信失败，包括临时限流，都会在当前权限仍允许时立即保存站内提示，并给咨询师动作台账设置phone_followup_required。短信可继续有限重试；站内提示不重复创建，电话要求不会因为后来服务商受理就自动消失。

## 咨询师动作与站内信

`GET /v1/xg/counselor/inbox?match_id=...&status=pending`

默认pending包括open和acked，**已查看但未完成的提醒仍留在待处理列表**。支持open、acked、closed、all；仍受T15当前可见性约束并在过滤后分页。新增action_revision、cst_step和电话跟进标记，不暴露私有联系方式或隐藏的原始等级。

`POST /v1/xg/alerts/:id/ack`

```json
{ "match_id": "cycle-id", "expected_revision": 0, "note": "已查看，待核对" }
```

`POST /v1/xg/alerts/:id/cst`

```json
{
  "match_id": "cycle-id",
  "expected_revision": 2,
  "cst_step": 3,
  "note": "已完成核对并记录后续安排",
  "phone_followup_done": true,
  "close": true
}
```

仅该周期咨询师可写，管理员不能代填。CST须当前开关允许，步骤不回退、不跳步；关闭必须完成第3步，且满足所需电话跟进。phone_followup_done是咨询师明确确认的人工动作，不由系统假装完成电话。变更带修订冲突和追加审计，当前同一请求重试不重复记账。

关闭CST会原子取消queued/retry_wait/blocked/processing任务，已在网络中的迟到回执只留审计，不重新打开提醒。

站内信入口：

- `GET /v1/xg/messages?limit=50&offset=0`：仅读取本人且当前仍允许展示的消息，过滤后分页。
- `POST /v1/xg/messages/:id/read`，空JSON：本人显式标记已读，重复调用保持同一read_at。

来访只能收到自己的随访提示，咨询师安全/复核提示不混入来访列表。已撤销同意、暂停或已完成业务的消息按当前守卫隐藏。

## 管理员运维

- `GET /v1/xg/admin/notifications/:id`：脱敏任务状态和最近100次尝试；不返回lease_token或地址。
- `POST /v1/xg/admin/notifications/:id/resolve`：仅处理uncertain，需expected_revision、outcome（accepted/not_sent）、reason、evidence_reference。确认已受理后补记事实；确认未发出才允许再次进入重试。不得凭超时猜测未发送。
- `POST /v1/xg/admin/notification-recipient`：counselor_id、expected_revision、disabled、reason；可更新openid/appid或phone_e164/phone_verified。账号必须有效且非演示。手机号须由管理员核验并显式确认，系统不冒充手机号所有权验证。未提供的地址保留，显式null清除；响应只返回是否已绑定和修订，不回显地址。

管理动作、联系人绑定摘要、自动电话要求、ack/CST均有追加审计。外部自动化不能调用这些管理员入口代替审核。

## 部署配置与触发

独立发送入口：`POST /v1/xg/jobs/notification-deliver`，请求 `{ "limit": 20 }`，使用T16专用调度secret。不能指定任意收件人、内容、任务状态或发送网址。

脚本：`node scripts/deliver-notifications.cjs`，使用XPG_API_BASE和XPG_SCHEDULER_SECRET，默认最多20批；错误、未知结果或未处理完时非零退出，便于执行器告警。重跑扫描不会自动重发uncertain任务。建议在T21由独立定时执行器按分钟触发，T16随访扫描仍按日运行；本次未创建线上定时器。

外部通道可选配置：

| 环境变量 | 用途 |
| --- | --- |
| XPG_NOTIFY_FUNCTION | 微信Event Function名称 |
| XPG_NOTIFY_BRIDGE_SECRET | CloudRun与发送桥共享的独立强secret，至少32字节 |
| XPG_MINIPROGRAM_APPID | 必须与可信收件绑定及云函数关联的小程序一致 |
| XPG_NOTIFY_TEMPLATES | 按followup/alert配置templateId、已发布page、data及miniprogramState的JSON |
| XPG_SMS_CONFIG | appId、templateId、signName、region和params的JSON |
| XPG_SMS_SECRET_ID / XPG_SMS_SECRET_KEY / XPG_SMS_TOKEN | 独立短信权限凭据；不使用CloudBase API Key冒充腾讯云签名密钥 |
| 云函数TCB_ENV | 明确指向相同环境，预先创建私有桥接回执集合 |

未配置通道或地址时按明确不可用处理并站内兜底，不写虚假外部成功。上线前须配置真实模板、微信平台关联/授权、短信签名及经核对的咨询师联系人；模板文案须保持中性，不带分数、症状或诊断。本项没有自动取得任何用户的微信订阅权限。

## 验收与边界

`npm run test:cloudbase`：**381项通过，0失败**，T17新增44项；原337项全部保留。

测试覆盖并发领取、租约失效前后恢复、旧worker隔离、发送前撤销/暂停、显式临时错误退避与预算、永久失败兜底、超时未知隔离、落库失败不重发、重复/迟到回执、安全短信立即兜底、已读与处理分离、CST顺序和关闭竞争、管理员核对、联系人隐私、来源原子入队、签名桥鉴权/去重、短信请求/回执关联、SDK查询与桥接事务协议、小程序同步授权辅助函数及本地HTTP权限。

所有发送测试使用模拟微信/短信响应，未向真实用户发送消息。云函数包、CloudRun配置、36个集合与索引、安全规则、真实模板和送达链路仍需T21/T22联调；本项不声称已验证真库并发或真实送达。T18已实现服务商受理、站内存储、用户阅读、咨询师处理的分别计量，并保存首次触发/首次CST时间；统计口径与小样本保护见 [T18说明](t18-statistics-expiry.md)。
