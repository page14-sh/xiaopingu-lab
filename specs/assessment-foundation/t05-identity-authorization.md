# T05：可信身份与咨询关系校验

日期：2026-10-25。状态：本地实现与测试完成，未部署云端。

本文保留 T05 交付时的范围与测试记录。后续读取边界见 [T06 交付说明](t06-read-permissions.md)，同意机制见 [T07 交付说明](t07-consent.md)；资源数量以当前集合声明为准。

## 结果与范围

四评专用 API 已接入统一会话与周期归属校验。用户不能通过请求体提供 visitor_id、actor_id 或 role 来替代服务端身份；建案必须引用专用接口中的已审批申请，不能以旧评估记录上可修改的咨询师选择或申请状态作为授权依据。

这次完成身份、申请审批、建案、单案开关和作答权限入口。知情同意、填卡状态机、答案校验与计分分别仍在 T07、T09–T12，完整作答写入尚未开放；T06 的敏感数据读取白名单还待实现。

## 微信身份链路

1. 小程序通过 `wx.cloud.callFunction` 调用 `xg-identity` Event Function。
2. 云函数核对 `getWXContext()` 和当前调用 `context` 中的微信身份，验证 AppID，只接受微信小程序/开发者工具原生调用，不读取 event 中的用户身份。
3. 云函数签发60秒有效的 HMAC 身份凭证，包含固定签发方、目标服务 audience、AppID、OPENID、一次性随机 jti 和有效期。
4. 小程序把凭证提交到 `POST /auth/visitor`。API 验签、校验应用/服务/时效，通过事务消费 jti 并定位稳定来访 ID，然后签发1小时的服务端会话。
5. 原始 OPENID 不写入来访注册表、不作为 API 身份字段返回；稳定 ID 由 AppID 与 OPENID 的哈希生成。短时凭证本身包含签名保护的 OPENID，是凭证而非加密数据，必须只经 HTTPS 传输且不得记录日志。

核对当前调用上下文，是为避免云函数实例复用时读取到上一位调用者残留的环境身份。参考 [CloudBase 实例复用说明](https://docs.cloudbase.net/cloud-function/instance)；实现使用仓库当前 SDK 导出的 `cloudbase.parseContext(context)`。代码见 [云函数入口](../../cloudfunctions/xg-identity/index.js)、[签发逻辑](../../cloudfunctions/xg-identity/handler.js)、[验签与授权](../../cloudrun/xiaopingu-api/assessment/authorization.js)。

小程序已新增 [四评请求客户端](../../miniprogram/utils/xg-api.js)，并在 app 启动时初始化云环境。`ensureXgSession()` / `xgRequest()` 会自动调用原生身份链路；缓存只在内存中保留有效服务端会话，不读取旧的 xpg_visitor 演示身份，不自动回退到 `/wechat/login`。后续四评页面使用这个客户端。

现有旧页面仍走原演示流程，本次不把尚未完成的四评流程接到旧 PCOMS 填卡页面。原生登录、微信环境绑定和云函数部署未做真机验证，不代表已经可在当前云端登录。

## 服务端身份边界

- 四评会话必须包含 audience=`xg-assessment`、明确角色、主体、有限有效期、非演示标记及对应认证方式。
- visitor 必须来自微信身份凭证交换，且注册表中存在未停用身份。
- counselor 必须通过非空编辑码认证，并在每次四评请求时确认账号仍启用、已审核且不是演示账号。
- admin 沿用服务端密码认证，可审批/建案和读取单案开关，但不能代来访/咨询师填写卡片。
- 演示密码会话和固定演示咨询师 ID 不可进入四评；旧的无 audience 会话需要重新登录。
- 只凭请求头里的 OPENID、请求体里的 user_id、猜到的事件 ID 或评估链接均不能获得四评身份。

## 可信申请与建案

现有 assessments 的 visitor_user_id / match_request_status 可经旧链路写入，不能直接升级为可信授权数据。因此新增明确的专用流程：

| 接口 | 权限与行为 |
|---|---|
| POST /auth/visitor | 一次性微信身份凭证换取会话；不接受客户端 role/openid/visitor_id |
| GET /v1/xg/me | 返回已验证的主体 ID 和角色 |
| POST /v1/xg/intakes | 仅来访；接收 answers 和可选 visitor_name，在同一事务中写入来源评估及私有归属记录；不接收分数或审批状态 |
| POST /v1/xg/match-requests | 仅来访；assessment_id 必须由本人通过可信入口创建，counselor_id 必须有效；创建 pending 申请 |
| POST /v1/xg/match-requests/:id/approve | 仅申请所指咨询师或管理员；记录审批人和角色，不接受客户端改归属 |
| POST /v1/xg/matches | 仅对应咨询师或管理员；根据 approved request_id 推导双方及来源，生成稳定周期 ID，重复调用不新建周期 |
| GET /v1/xg/matches/:id | 本周期双方或管理员；只返回周期元数据，不返回作答、分数或 LLM 内容 |
| GET /v1/xg/case-switch?match_id=… | 本周期咨询师或管理员可读 |
| POST /v1/xg/case-switch | 仅本周期咨询师；只接受 match_id、enable_reminder、enable_cst，归属和 updated_by 从服务端推导 |

新入口的来源评估使用 `xg_managed=true`，不能通过旧通用 REST 读取、修改或删除。私有归属记录与申请集合均不进入通用集合白名单。旧评估不自动认领、不自动迁移为可信申请；之后如需要迁移，要独立验证历史归属。

`/intakes` 只建立可信来源及保存输入，不替代现有准入计分/匹配算法，也不声称该算法已经与新入口联调。新的四评页面和申请操作 UI 尚未实现，当前可经接口联调。

## 作答权限入口

`POST /v1/xg/events/start`、`POST /v1/xg/events` 和 `POST /v1/xg/events/abandon` 已接统一校验：

- 未登录、错误签名、过期或错误 audience 返回401。
- 跨来访、跨咨询师、角色代填和跨周期挪用事件返回403。
- M0/M1/M2/M4 只能由本周期来访填写；M3 只能由本周期咨询师填写；管理员不能代填。
- 带 event_id 时必须属于 match_id，已有卡片、节次、随访轮次不可被请求改写；放弃请求现在明确要求 match_id + event_id。
- 事件存储带服务端派生的 actor_id/actor_role，便于后续状态机验证作者。
- 客户端提供身份、分数、状态等非白名单字段返回400。
- 校验通过后暂返回501 `XG_NOT_IMPLEMENTED`，不写入未经同意/计分校验的答案。这是后续功能未开放，不应显示提交成功。

对分数、曲线、LLM 的完整读取接口仍未开放，避免在 T06 前直接返回底层仓库对象。

## 配置与部署待办

新增资源已写入 [集合声明](../../cloudrun/xiaopingu-api/assessment/collections.json)：xg_visitors、xg_identity_assertions、xg_intake_owners、xg_match_requests、xg_case_switches，加上 T04 六个集合共11个，客户端直接读写均拒绝。还需复用现有 assessments 集合保存可信来源记录。

云函数和 CloudRun 均需通过环境配置安全注入：

| 变量 | 约定 |
|---|---|
| XPG_IDENTITY_BRIDGE_SECRET | 两侧一致、至少32字节的独立高熵随机密钥；不要复用会话密钥，不入仓库或聊天 |
| XPG_MINIPROGRAM_APPID | 两侧一致；须与目标小程序一致，仓库当前为 wxc2b0a7a471a5809f |
| XPG_IDENTITY_AUDIENCE | 两侧一致且按环境区分，如 xpg-api:xpg-demo-d3gzsswtcc3233ea0 |
| XPG_SESSION_SECRET | CloudRun 已有会话签名密钥，继续保留 |

部署 xg-identity 时只开放所绑定小程序的原生调用，不配置公开 HTTP 入口；验证 AppID/环境绑定、当前调用 context 的实际结构及同一实例连续不同用户调用。缺少配置时 API 返回503，不能回退演示身份。

jti 防重放记录只可在 expires_at 之后清理；在有效期内不能删除。清理任务与密钥轮换/真实环境验证列入后续运维联调。

本次未创建云集合、未配置真实密钥、未部署函数或容器、未发布小程序。

## 本地验证

运行 `npm run test:cloudbase`。测试覆盖：身份凭证篡改/过期/错误应用/错误 audience、防重放、同用户稳定映射、不同用户隔离、停用身份、非本人申请/审批、未审批建案、跨周期事件、角色代填、单案开关归属、旧 REST 绕过、小程序登录失败无演示回退、会话失效和云函数入口的实际 SDK context 解析。

结果：46 项全部通过，本项新增16项（11项身份/授权、4项云函数入口与小程序客户端、1项SDK持久化）。

SDK适配测试还覆盖可信来源评估与归属记录的事务写入，以及专用申请审批持久化。测试通过只证明本地逻辑和离线 SDK 协议，不代表微信真机认证或真实云数据库并发已经验收；这些仍由 T21/T22 留痕验证。
