# 四评当前数据、资源与配置契约

更新：2026-10-25。当前实现采用CloudRun Node + CloudBase NoSQL，全部xg资源经服务端API访问。原包03/04/05/10 SQL及pg_cron仅用于理解历史方案，不执行于当前环境。

## 资源真源

[collections.json](../../cloudrun/xiaopingu-api/assessment/collections.json) 是42个四评集合、文档键、索引及客户端拒绝策略的机器可读声明；[model.js](../../cloudrun/xiaopingu-api/assessment/model.js) 定义运行时集合映射。T21仅在独立前缀集合中验证，不代表canonical名称已部署。

| 资源组 | 集合/职责 |
| --- | --- |
| 周期 | matches、active_matches；match_id及双方并行周期锁 |
| 身份与匹配 | visitors、identity_assertions、intake_owners、match_requests；一次性签名断言、可信归属、申请/审批 |
| 作答与档案 | assessment_events、submissions、baseline_profiles、end_profiles；尝试、唯一成功名额、原基线/重测、结案/随访 |
| 同意 | consent_policies、consent_documents、consent_states、consent_history；用途独立、不可覆盖文案及签署/撤销历史 |
| 依据与配置 | item_versions、rule_versions、assessment_release、case_assessment_configs；不可变定义、发布指针与周期配置历史 |
| 幂等/审计 | event_transitions、request_receipts；状态修订及操作回执，同业务事务保存 |
| 组合 | combination_jobs、raw_signals、session_combinations、combination_history；待重算代次、原始规则、展示结果与证据历史 |
| 阶段开关 | case_switches、rollout_policy、rollout_history；有效权限和回滚历史 |
| 随访 | followup_jobs；结案后1/3自然月，原周期归属 |
| 通知 | notification_tasks、notification_attempts、notification_inbox、notification_recipients、notification_audit、notification_bridge、alert_actions |
| LLM | llm_jobs、llm_attempts、llm_results、llm_history、llm_audit、tag_weight_proposals、tag_weights |

表中省略共同前缀xg_。旧assessments/counselors为准入/咨询师集成依赖，不加入四评新集合数量；T21另外建立它们的隔离测试副本，不读写原业务集合。

## 不变式

- 身份及归属从可信会话和周期解析，不由客户端传入分数、counselor_id或visitor_id决定。新的咨询关系不能重用旧周期ID。
- 尝试event_id、操作request_id、成功名额submission_id各自独立。只有submitted占成功名额，rejected/abandoned不占。
- 已提交原始答卷、冻结题面/规则及成功名额不可覆盖；复算只报告差异，不修补历史。缺依据不按最新版补造。
- 所有提交成功必需写入、同意锁、回执、事件审计、档案及持久任务入队共享事务；外部发送/模型调用在事务外。
- worker在租约/代次及实际来源复核后提交结果，旧worker不能覆盖新状态。事务失败和未知提交结果不伪装成功。
- 每个业务文档保留match_id/visitor_id/counselor_id作用域，读取和关联检查冗余归属；坏数据失败关闭，不猜测迁移归属。
- 任何聚合、导出或脚本不得暴露运行时凭据；日志不打印完整headers、环境变量、服务商原始响应或模型原始异常。

## 题库与规则

7种卡片、42题。定义源为assessment/definitions；发布版本不可复用不同内容。七题状态0–70、选修0–30单独保存；ORS最终取整；首节M3 p6不适用，无完整六题分及双向差；结案/随访主分各0–60，补足分按阶段展示。

低质量合法作答仍保存确定性分数和规则证据，但不进入LLM目标及上下文。缺节中断连续窗口。原始L2与组合展示L1分别保存；L3和持平信号不因联盟稳定降级。ALL-GAP按周期/节次/规则键去重，锚定M2并引用双卡证据。正式临床/测量有效性不由工程阈值测试证明。

## 配置分区

| 配置 | 注入位置/用途 |
| --- | --- |
| TCB_ENV、CLOUDBASE_APIKEY | CloudRun服务端数据库；不得发至客户端 |
| XPG_ADMIN_PASSWORD、XPG_SESSION_SECRET | 服务端管理员及会话签名 |
| XPG_DEMO_MODE、XPG_DEMO_COUNSELOR_PASSWORD | 旧演示功能；demo会话仍不能进入真实四评 |
| XPG_MATCH_SERVICE_SECRET、XPG_SCHEDULER_SECRET | 两类独立服务凭据；不能相同 |
| XPG_IDENTITY_BRIDGE_SECRET、XPG_MINIPROGRAM_APPID、XPG_IDENTITY_AUDIENCE | CloudRun与xg-identity云函数身份桥 |
| XPG_NOTIFY_BRIDGE_SECRET、XPG_NOTIFY_FUNCTION、XPG_NOTIFY_TEMPLATES | 微信订阅消息签名桥、函数及模板映射 |
| XPG_SMS_CONFIG、XPG_SMS_SECRET_ID、XPG_SMS_SECRET_KEY、XPG_SMS_TOKEN | 安全线短信适配器；缺配置不能假装发送 |
| XG_LLM_BASE_URL、XG_LLM_API_KEY、XG_LLM_MODEL | 既有兼容模型服务；未配置任务保持待处理 |
| XPG_API_BASE、XPG_SCHEDULER_SECRET | scripts独立调度调用；非浏览器配置 |

仅列变量名，不在文档保存真实值。现有CloudRun代码发布、密钥注入、函数发布、微信真机环境和定时器配置是不同步骤；只改本地.env不会更新云端。

## 索引与隔离验证

索引按collections.json逐项创建并核验，禁止为“试一下”而删除现有业务索引。腾讯云提供[UpdateTable](https://cloud.tencent.com/document/product/876/127964)管理集合索引和[DescribeTable](https://cloud.tencent.com.cn/document/api/876/127966)读取索引结构；T21脚本只对本轮独立名称调用这些接口。

`ADMINONLY`管理面回读核验、服务端越权测试、真实微信客户端直连数据库测试是不同证据。前两项不能替代后一项。实际未运行的客户端、云托管路由、外部通知/模型及性能项均在T21报告中列明。

T21脚本固定已授权演示环境，每次生成随机前缀；所有collection/transaction访问强制映射，未映射集合即拒绝。预检查名称不存在后才记录创建意图并创建；失败和成功均清理本轮拥有的集合，删除后再读取确认不存在。报告不包含临时凭据或登录token。

```bash
node scripts/t21-isolated-integration.cjs --run
# 若上次清理中断，只允许传入本项目outputs/t21中的该轮报告
node scripts/t21-isolated-integration.cjs --cleanup outputs/t21/<该轮报告>.json
```

这不是生产资源迁移脚本，也不升级或修改环境套餐。正式发布和回滚材料由T22单独审查。
