# T04：按咨询周期隔离数据

日期：2026-10-25。范围：本地服务端数据层实现；不含生产部署、完整提交接口和身份登录。

本文保留 T04 交付时的范围与测试记录。后续身份接口见 [T05 交付说明](t05-identity-authorization.md)，读取边界见 [T06 交付说明](t06-read-permissions.md)，同意机制见 [T07 交付说明](t07-consent.md)；资源数量以当前集合声明为准。

## 实现落点

- [数据模型与业务键](../../cloudrun/xiaopingu-api/assessment/model.js)
- [周期数据仓库](../../cloudrun/xiaopingu-api/assessment/repository.js)
- [CloudBase 适配器](../../cloudrun/xiaopingu-api/assessment/cloudbase-store.js)
- [集合与索引声明](../../cloudrun/xiaopingu-api/assessment/collections.json)

`createCloudBaseStore(db).assessment` 已接入现有服务端的存储工厂，容器构建会复制该模块。模块初始化不访问数据库，不创建集合；尚未开放 `/v1/xg/*` 路由。旧 REST 集合白名单不包含任何四评集合，即使管理员也不能经通用 REST 绕过四评业务服务写入。

## 数据归属

| 集合 | 文档主键 | 作用 |
|---|---|---|
| xg_matches | match_id | 不可变的双方身份、来源评估、前序周期；活动/结案状态及数据版本 |
| xg_active_matches | 哈希(visitor_id, counselor_id) | 一个双方组合只占用一个活动周期；结案释放，历史周期不删除 |
| xg_assessment_events | event_id | 作答尝试，均带 match_id、visitor_id、counselor_id |
| xg_submissions | 哈希(match_id, scale_code, position, follow_round) | 只为 submitted 占用有效提交名额；失败/放弃不占名额 |
| xg_baseline_profiles | match_id | 原始基线与首节重测分开存储，不按来访 ID 覆盖 |
| xg_end_profiles | match_id | 结案、服务评价、1 月及 3 月随访分别存储 |

标识哈希以 JSON 数组编码各组成部分后计算 SHA-256，避免字符串分隔符造成拼接歧义。

position 对常规 M1/M2/M3 使用真实节次；M0、结案、服务评价、随访使用周期位置。这样无法通过换一个结案节次重复填写同一张结案卡，随访则由 follow_round 区分两轮。M0 仅允许节次0，其他卡片节次至少1；随访必须关联已结案周期的最终节次。

## 内部调用契约

| 方法 | 约束 |
|---|---|
| createMatch(input) | 身份字段与 match_id 来自可信上层；同一 match_id 重复创建返回原周期，不能改双方身份；新周期可引用同一来访的已关闭前序周期 |
| closeMatch(matchId, sessionNo) | 记录最终节次，不能早于已提交记录或与已有结案卡的节次冲突；保留档案、释放当前活动名额；重复关闭不会影响新周期 |
| insertEvent(input) | 插入不可变尝试；归属从周期派生，不接受跨周期身份；成功提交同时更新名额与对应档案 |
| getEvent(matchId, eventId) | 必须同时提供周期和事件，不能凭事件 ID 读取其他周期 |
| getProfiles(matchId) | 从同一事务快照读取该周期的基线与结案档案 |
| listEvents(matchId) | 数据库条件查询限定 match_id，逐页读取，不沿用旧存储的1000行上限 |
| getTrend(matchId) | 只返回该周期已提交 M1；基线单独返回，不加入其他周期或 M2/M3；检查周期版本防止混合不同提交时刻的分页结果 |

这是一层**内部持久化接口**，不是授权服务或计分接口。上层仍须完成真实身份、关系确认、同意、卡片时机和答案校验；scores 必须是后端计分结果，不可直接转发请求体。首节重测的7天条件、真实节次推进由后续业务服务校验。本项只提供其隔离存储位置。

`insertEvent` 当前是不可变尝试插入原语；开始行升级为已提交的状态机在 T09 实现，不能提前拿它替代完整 `/events` 流程。请求 client_event_id 幂等、持久化异步任务与完整提交事务在 T10/T19 接入。

## 一致性和失败行为

- 周期创建与活动名额占用处于同一事务；同一周期的成功名额、档案、事件和版本更新也处于同一事务。
- 每次写入修改该周期版本文档，作为提交/结案的共同写入锚点。SDK 可重试事务冲突；事务回调不含通知、LLM 或随机生成 ID 的副作用。
- 同一 event_id 重试相同数据可返回原记录，改内容或跨周期复用会失败；有效名额已被其他事件占用时返回 XG_ALREADY_SUBMITTED。
- 适配器同时检查 SDK 抛出的异常和返回的错误对象；不能把读取失败当作不存在，也不能把无实际写入的响应当作成功。
- 趋势读取前后检查周期版本，变化时最多重读3次，仍变化返回可重试错误，不返回混合版本结果。
- 基线与结案按周期键直接取档案；档案/事件的冗余身份与周期不匹配时拒绝返回。

SDK 调用按本仓库锁定并安装的 `@cloudbase/node-sdk 3.18.3` / `@cloudbase/database 1.4.3` 源码核对：使用事务 `collection().doc().get()/set()`；事务 get 返回对象/null，普通 get 返回数组。查询通过数据库 `where({match_id})` 完成，不下载整个业务集合后筛选。[官方事务说明](https://docs.cloudbase.net/database/transaction)

## 验证

执行：项目根目录 `npm run test:cloudbase`。

本地结果：30 项测试通过，其中新增21项（14项数据仓库、6项SDK适配、1项旧REST隔离）；运行时间与结果以本次命令输出为准。

新增测试包括：

1. 同一来访从 A 周期结案，再与 B 开始周期，重新提交基线及第1节；趋势独立。
2. B 周期活动时，A 周期的随访仍只更新 A。
3. 同一咨询师重新开案，旧基线和结案数据保留。
4. 周期身份不可改写，前序周期不能引用其他来访。
5. 读取必须带周期；跨周期复用事件 ID 或伪造归属被拒绝。
6. rejected/abandoned 不占成功名额；成功答卷不可通过重复请求改分。
7. 原始基线与重测分开；另一周期的基线不受影响。
8. 1m/3m 分开，换节次不能重复占同一随访或结案位置。
9. 写入失败整体回滚；本地事务模型中的重复提交、并发随访不丢数据。
10. 使用真实安装 SDK、替换网络传输，验证读写形状、错误传播、回滚和1005条单周期分页。
11. 所有四评集合在旧通用 REST 路径均返回404。

内存事务测试是串行原子性模型，SDK测试使用模拟传输；它们不证明真实云环境下的锁行为、权限或事务冲突。真实 CloudBase 验证在 T10/T21 补齐，不把离线测试报告为云端通过。

## 云资源与下一项边界

`collections.json` 是资源声明，**不是已经执行的迁移，也不是可直接传给 CLI 的命令参数**。本次未创建云集合、索引、权限规则，未迁移旧 PCOMS 或部署容器。

启用新 API 前，在隔离环境创建声明的6个集合，配置客户端读写均拒绝，并验证 `xg_assessment_events(match_id, session_no, _id)` 查询索引及服务端事务。真实索引接受情况、权限和并发行为须留痕；生产操作仍按 T22 发布流程进行。

T05 接入真实身份、可信匹配关系和专用业务服务时，必须使用这层周期存储，不能根据旧 assessments 上可变的 selected_counselor_id 查询四评历史。T06 再完成角色字段白名单；当前持久层返回的分数/原始答案不得直接作为来访 API 响应。
