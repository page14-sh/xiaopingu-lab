# 四评当前 API 契约

更新：2026-10-25。以T01–T20当前实现为准；联调证据与未验证项见 [T21报告](t21-integration.md)。本文件描述原生接口；迁移后的已部署登录、初评兼容、审批与运营看板补充见 [v2 源码与接入契约](../../docs/v2-source-and-api.md)。原交付包06的SQL/Supabase接口示意不作为运行契约。

## 公共约定

- 根路径 `/v1/xg`，JSON请求/响应；所有敏感响应及错误使用 `Cache-Control: no-store`。
- 人员接口使用 `Authorization: Bearer <服务端会话>`；会话必须aud=xg-assessment、demo=false，且角色/认证方式匹配。来访支持可信微信身份或独立填写凭证身份（intake-receipt）；旧评估链接只授予历史读取权限。咨询师需有效审批身份。
- 服务接口使用独立 `XPG_MATCH_SERVICE_SECRET` 或 `XPG_SCHEDULER_SECRET`；两者不能相同，均至少32字节，不能用普通管理员会话代替。
- 请求字段采用白名单，身份、归属、计分、版本依据均由服务端决定。标识只接受1–128位字母、数字、下划线、连字符。
- 业务错误形如 `{"error":{"code":"XG_...","message":"..."}}`；不返回SDK异常、完整请求头、环境变量或通道原始响应。
- 401身份无效；403无权/跨周期；404不存在；409状态、版本、同意或唯一名额冲突；422答案/模型校验失败；503暂不可用或无法提供完整统计。旧通用REST不开放任何xg集合。

## 身份与咨询周期

| 方法/路径 | 身份 | 请求/返回要点 |
| --- | --- | --- |
| POST `/auth/visitor`（不带/v1/xg） | 微信身份桥断言 | `{assertion}`；校验一次性签名断言，返回token、expires_at、visitor.id |
| GET `/me` | 三类有效人员 | 当前id/role，不返回密钥 |
| POST `/intakes` | 来访 | `{answers, visitor_name?}`；新准入记录及可信归属，返回assessment_id |
| POST `/match-requests` | 来访 | `{assessment_id,counselor_id}`；校验本人准入记录及有效咨询师 |
| POST `/match-requests/:id/approve` | 该咨询师/管理员 | 空对象；申请审批，幂等 |
| POST `/matches` | 该咨询师/管理员 | `{request_id,previous_match_id?}`；只从已批准申请建立周期 |
| GET `/matches/:id` | 本周期双方/管理员 | 周期元数据 |

一个match_id是一段咨询周期。重新匹配、更换咨询师、结案后再咨询均新周期；旧随访不迁移。相同双方不能重复创建并行active周期。已有旧PCOMS记录不自动补造四评周期。

## 同意与卡片提示

| 方法/路径 | 身份 | 要点 |
| --- | --- | --- |
| GET `/me/consent?scope=assessment或followup` | 来访 | 当前签署状态及必需文案版本/哈希 |
| POST `/me/consent` | 来访 | scope、version、document_hash、agreed、channel、client_event_id、expected_revision；新增201，幂等200 |
| GET `/me/consent/history` | 来访 | scope、limit、offset；仅本人历史 |
| GET `/admin/consents` | 管理员 | visitor_id、scope、limit、offset |
| GET `/prompts/next` | 本周期来访/咨询师 | match_id、session_no?、scope?；无当前同意/暂停采集不推卡；随访核对原计划到期 |

正式同意书需在部署前明确版本并发布。合成测试文案不是正式授权文案。咨询师不能读取来访完整签署历史。文案升级后旧签署不满足当前同意要求；撤销会阻止新采集和外部任务后续处理。

## 作答状态机

**开始** `POST /events/start`：match_id、scale_code、session_no、follow_round?、client_event_id、request_id?。返回event_id、状态/修订、开始/到期时间和冻结form。首节p6不适用，动态题面与选修配置一并冻结。没有独立实现原包的GET `/scales`；当前题面从开始/恢复响应取得。

**提交** `POST /events`：match_id、event_id、request_id、answers，可选duration_ms（仅作客户端记录）；兼容归属字段若出现必须与原尝试相符。核心耗时以服务端时间为准。有效提交201、重复请求200；拒绝422保留rejected与错误字段，不占成功名额。修正答案须换request_id，可继续使用原event_id。

**放弃** `POST /events/abandon`：match_id、event_id、request_id、reason?；reason为user_exit/page_leave/timeout，默认user_exit。已提交不可被放弃覆盖；timeout必须达到服务端到期时间。

client_event_id标识一次填卡尝试；request_id标识一次操作及其不可变负载；成功名额按周期/卡/有效节次位置/随访轮次唯一。不同重试概念不得混用。旧失败请求重放返回原请求结果及当前事件状态，不回退已成功提交。

来访提交响应只含保存状态与中性提示，不含分数。咨询师提交M3可收到该卡允许显示的分数；首节不适用时为null。默认30分钟超时，rejected不延长到期时间。

## 读取与后台配置

| 方法/路径 | 身份 | 要点 |
| --- | --- | --- |
| GET `/events` | 本周期人员/管理员 | match_id必填；event_id/scale_code/session_no/follow_round及limit/offset可选；先做角色字段和卡片过滤再分页 |
| GET `/trend` | 本周期咨询师/管理员 | match_id、from_session/to_session、limit/offset；仅状态趋势，重测单列 |
| GET `/person-compare` | 本周期咨询师/管理员 | 基线、重测、结案、两轮随访分栏，不生成跨量表统一差值 |
| GET `/llm-results` | 本周期咨询师/管理员 | match_id、event_id?、limit/offset；安全建议、可空维度、模型/代次/辅助权重版本，advisory_only=true |
| GET `/admin/event-basis` | 管理员 | match_id/event_id；冻结依据 |
| GET `/admin/event-score-replay` | 管理员 | match_id/event_id；只读复算差异 |
| GET `/admin/session-combination` | 管理员 | match_id/session_no，revision?；原始及组合证据与历史 |
| GET/POST `/admin/rule-thresholds` | 管理员 | POST使用rule_version、expected_revision、thresholds、reason，新版本不改旧依据 |
| GET/POST `/case-switch` | 本案咨询师/管理员 | match_id及提醒/CST开关；新客户端应提供expected_revision、reason，旧兼容调用仍允许省略 |
| GET/POST `/admin/rollout` | 管理员 | 全局enable_reminder/enable_cst/emergency_stop/collection_paused，写入须expected_revision、reason |
| POST `/admin/rollout/rollback` | 管理员 | expected_revision、reason；保留历史数据 |
| GET `/admin/rollout/history` | 管理员 | scope、match_id?、revision |
| GET `/counselor/inbox` | 本周期咨询师/管理员 | match_id、session_no?、alert_type?、status?、limit/offset；来访禁读 |

来访不读分数、预警、LLM、趋势或M3原始记录；咨询师原始作答字段仅开放本人周期M2/M3及规定的趋势/阶段摘要。管理员也不透传内部数据库记录。安全线始终显示，普通L3只在全局开放时显示；停用提醒不删计分/证据。

## 通知与LLM管理

| 方法/路径 | 身份 | 要点 |
| --- | --- | --- |
| GET `/messages` | 本人来访/咨询师 | 私有站内信分页 |
| POST `/messages/:id/read` | 收件本人 | 空对象，明确已读 |
| POST `/alerts/:id/ack` | 本案咨询师 | match_id、expected_revision、note |
| POST `/alerts/:id/cst` | 本案咨询师 | 上述字段及cst_step、close?、phone_followup_done?；顺序及开关检查 |
| GET `/admin/notifications/:id` | 管理员 | 发送任务及安全尝试摘要 |
| POST `/admin/notifications/:id/resolve` | 管理员 | expected_revision、outcome=accepted/not_sent、reason、evidence_reference |
| POST `/admin/notification-recipient` | 管理员 | 已核验咨询师地址绑定；精确字段见T17，不公开联系人列表 |
| GET `/admin/llm-jobs` | 管理员 | status?、after?、limit?游标分页 |
| GET `/admin/llm-jobs/:event_id` | 管理员 | 当前代任务、建议、审核及辅助权重 |
| POST `/admin/llm-jobs/:event_id/reprocess` | 管理员 | expected_revision、request_id、reason；新代次，不覆盖历史 |
| POST `/admin/llm-jobs/:event_id/review` | 管理员 | generation、expected_revision、decision=approved/rejected、reason |
| POST `/admin/llm-proposals/:id/review` | 管理员 | decision、expected_revision、expected_weight_revision、reason |
| GET/POST `/admin/llm-weights/:match_id` | 管理员 | POST完整四维倍率、expected_revision、request_id、reason；只影响辅助分析 |

发送受理、站内存储、已读、ack、CST、关闭、真实随访提交分别计量。通知未知结果不自动重发；LLM可有限重算但可能重复计费。模型建议不自动修改权重，更不修改主分和预警。详细重试、审核及脱敏契约见T17/T19。

## 专用服务入口与统计

| POST路径 | 凭据 | 请求 |
| --- | --- | --- |
| `/m4/close` | matching | match_id、session_no；原子结案及1/3自然月计划 |
| `/jobs/follow-dispatch` | scheduler | limit? |
| `/jobs/notification-deliver` | scheduler | limit? |
| `/jobs/events-expire` | scheduler | limit?，1–100 |
| `/jobs/llm-run` | scheduler | limit?，1–5 |
| `/jobs/llm-recover` | scheduler | limit?，1–100 |
| `/internal/llm-score` | scheduler | event_id，仅处理既有任务 |

入口拒绝查询参数和额外字段。独立脚本在scripts目录，通过平台调度调用，不依赖CloudRun进程常驻。

`GET /admin/stats`仅管理员：metric、from/to；严格上海自然日，含首末日，最多366天，默认近30天。schema=stats-t19-v1。发起分母来自started_at事实，尝试与业务位置分别去重；LLM分母来自真实任务。每项至少5名不同来访，比例非零分子/补集也需满足门槛。按期随访因缺截止窗口仍明确不可用；外部已读无回执不可用。每源10,000条读取预算，超限503而非静默截断。完整口径见T18/T19。
