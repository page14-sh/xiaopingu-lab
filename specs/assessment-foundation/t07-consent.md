# T07：同意书版本、撤销与历史留痕

日期：2026-10-25。状态：本地工程机制和验证完成；正式文案未确认，未发布生产同意书，未部署云资源。

本文保留 T07 的交付范围与测试记录。后续历史依据见 [T08 交付说明](t08-scoring-provenance.md)，实际状态流转与同事务同意校验见 [T09 交付说明](t09-event-lifecycle.md)，资源数量以当前集合声明为准。

## 已实现的口径

- `assessment` 用于 M0/M1/M2/M3；`followup` 用于结案卡、服务评价、1月/3月随访。
- 同意按来访身份和用途保存，不按咨询周期重复建一份。撤销某一用途会影响该来访所有周期后续该用途的操作；不会自动撤销另一用途。
- 以服务端当前发布版本为准。版本、正文哈希和发布修订号必须与签署记录一致，旧版签署不能通过新版校验。
- 同一版本的标题和正文不可由本服务覆盖，变更必须发布新版本；不能重新启用旧版本使旧签署意外恢复有效。
- 签署、撤销和再次签署都追加历史动作。当前状态单独更新，不删除或改写旧动作；服务器生成时间与修订号。
- 仅来访本人可签署/撤销。咨询师不能读取同意记录或代签；管理员通过专用审计接口只读，不能代签或代撤销。

## 数据结构

新增四个客户端直接读写均拒绝的集合，总声明集合数由12增为16：

| 集合 | 主键 | 用途 |
|---|---|---|
| xg_consent_policies | scope | 当前必需版本、正文哈希、发布修订号及事务锚点 |
| xg_consent_documents | hash(scope, version) | 不可覆盖的标题、全文、正文哈希、发布人和发布时间 |
| xg_consent_states | hash(visitor_id, scope) | 当前签署版本、同意状态、签署/撤销时间、状态修订号及最后动作引用 |
| xg_consent_history | hash(visitor_id, client_event_id) | 仅追加的操作历史及幂等请求内容 |

文档哈希是对 `[scope, version, title, content]` 的 JSON 编码计算 SHA-256。正文读取时再次校验哈希与必需版本指针，配置异常时拒绝签署与使用，不能静默沿用旧同意。

物理数据库仍由服务端凭据管理；“不可覆盖/仅追加”是本服务的写入约束，不宣称拥有服务端数据库权限的人无法直接改库。上线前须验证真实数据库权限。

## API 契约

| 接口 | 谁可调用 | 行为 |
|---|---|---|
| GET /v1/xg/me/consent?scope=assessment | 来访本人 | 当前状态、required_version、当前文案和正文哈希；默认 scope=assessment |
| POST /v1/xg/me/consent | 来访本人 | 签署或撤销，只接受明确的业务字段 |
| GET /v1/xg/me/consent/history?scope=assessment | 来访本人 | 本用途历史；支持 limit/offset |
| GET /v1/xg/admin/consents?visitor_id=…&scope=assessment | 管理员 | 指定来访当前状态与历史；不支持写入 |
| GET /v1/xg/prompts/next?match_id=… | 周期双方 | 缺少有效同意时返回空卡片列表；完整排程尚未开放 |

状态接口返回：

```json
{
  "scope": "assessment",
  "configured": true,
  "agreed": false,
  "version": null,
  "document_hash": null,
  "agreed_at": null,
  "revoked_at": null,
  "revision": 0,
  "required_version": "v1",
  "required_document": {
    "version": "v1",
    "title": "已发布的正式标题",
    "content": "已发布的正式全文",
    "content_hash": "服务端返回的64位哈希",
    "published_at": "服务端发布时间"
  }
}
```

以上仅为接口结构示意，不是已发布文案。

签署请求：

```json
{
  "scope": "assessment",
  "version": "GET 返回的 required_version",
  "document_hash": "GET 返回的 required_document.content_hash",
  "agreed": true,
  "channel": "miniprogram",
  "client_event_id": "每次操作生成的新UUID",
  "expected_revision": 0
}
```

`expected_revision` 必须使用最近 GET 返回的 revision，首次为0。字段 channel 接受 miniprogram / web / app，是客户端声明的操作来源，不构成授权依据；本接口不支持纸质签署的代录。

撤销请求使用 `agreed=false`、当前签署的 `version` 和 `document_hash`，不是新文案的 required_version/content_hash。因此即使版本升级，仍可明确撤销以前签署的版本；缺少当前必需文案时也不会阻止已签记录撤销。

客户端不能提供 visitor_id、user_id、agreed_at、revoked_at 等归属/时间字段。首次有效操作返回201；同 client_event_id、同内容重试返回200及 duplicated=true。重复请求返回当前状态，不把历史动作重放成新的签署。

同一 client_event_id 改内容返回409 `XG_IDEMPOTENCY_CONFLICT`；状态修订号过期返回409 `XG_CONSENT_CONFLICT`。客户端必须重新读取状态，不能通过自动更换幂等键/修订号重试来代替用户重新确认。

## 版本升级与撤销后的行为

| 情况 | 结果 |
|---|---|
| 只签过 assessment v1，当前要求 v2 | agreed=false；旧签署历史保留，需要阅读并签署v2 |
| 撤销后再次同意同一版本 | 新增同意动作和新签署时间，旧签署与撤销动作不变 |
| 撤销后收到旧签署请求的网络重试 | 返回 duplicated=true 和当前撤销状态，不恢复同意 |
| 旧页面持有过期 revision，使用新请求ID再次提交同意 | 返回冲突，不恢复同意 |
| 同意书正文被绕过服务改写而哈希未同步 | 状态/使用校验返回配置错误；已持有签署版本和哈希仍可提交撤销 |
| 某用途没有正式发布文案 | GET 返回 configured=false、required_version/document=null；签署和开始/提交入口返回503 |
| 有文案但从未同意、已撤销或签署版本过旧 | 开始/提交返回409 XG_CONSENT_REQUIRED，不写作答 |

撤销不会删除已经保存的作答或历史；本人仍可按 T06 的白名单读取历史。放弃填卡入口不要求同意仍有效，以便用户撤销后退出填卡；实际放弃状态流转仍由 T09 实现。

## 与作答及随访的集成

`POST /events/start`、`POST /events` 先完成 T05 的身份、周期、角色和事件归属检查，再检查该周期**来访**的同意。咨询师填写 M3 时检查的是来访的 assessment 同意，不是咨询师自己的签署记录；错误响应不返回来访签署版本、时间或历史。

无有效同意时，`/prompts/next` 返回 `{ "prompts": [] }`。默认活动周期检查 assessment，已关闭周期检查 followup；支持显式 scope 供后续结案卡入口使用。当前完整卡片排程尚未实现，有效同意只会走到501，不能把501解释为可推送/已提交。

T09–T12 的提交/校验/计分尚未开放，通过同意检查的作答请求仍返回501，不写入未经完整校验的答案。现有逻辑没有发布文案、创建同意、伪造默认答案或自动签署的兜底。

## 并发与后续事务要求

签署/撤销的状态与历史在同一事务提交；并发相同请求只追加一次动作，不同请求带同一旧修订号时只允许一个成功。

数据层提供 `runWithConsent(visitorId, scope, work)`：在同一事务中读取必需版本和当前签署，并写入用途级版本锚点及来访用途状态锚点，再执行 work。它返回可随业务记录保存的签署动作ID、版本和正文哈希。

T09/T10 必须把真正的作答写入放进该 work 的 tx；不能先单独 assertCurrent 再在另一个事务保存，也不能在回调里调用会自行开新事务的 insertEvent。业务失败会连同锚点一起回滚，用户侧 revision 不因正常业务使用而变化。

T16/T17 的随访任务领取和 T19 后续数据处理应在相应执行点核对该用途；本项未实现这些后台任务。用途级写入锚点是明确的串行化点，真实环境下的并发正确性和吞吐需要在 T10/T21 验证，不能用本地串行内存模型替代。

## 正式文案与发布边界

本次未取得四评专用的定稿文案。仓库旧的准入评估弹窗不自动等于 assessment/followup 的正式同意，也不继承其 sessionStorage 标记。当前先完成工程机制；正式文案后续单独确认并由可信运维入口发布。

发布入口是服务端内部 `store.consent.publishPolicy({scope, version, title, content, published_by, expected_revision})`，没有开放网页/客户端发布路由。发布前须核对目标环境、正式全文、版本和发布人；应用启动不会自动创建文案。测试夹具中的 TEST ONLY 文案不能用于生产。

已声明16个私有集合及历史查询索引；本次没有创建云端集合/索引、发布真实文案或部署容器。

## 交付与验证

- [版本、状态与审计数据层](../../cloudrun/xiaopingu-api/assessment/consent.js)
- [同意 API 与推卡前置检查](../../cloudrun/xiaopingu-api/assessment/consent-http.js)
- [场景与权限测试](../../cloudrun/xiaopingu-api/assessment/consent.test.js)

执行 `npm run test:cloudbase`：82项全部通过，本项新增21项（19项同意场景及2项实际安装SDK的离线协议验证）。覆盖无配置、版本升级、正文不可覆盖、撤销/再同意、旧请求重放、修订冲突、并发重复、事务失败回滚、管理员只读、他人越权、两种用途、M3检查来访同意、推卡拦截、正文完整性，以及版本/签署/业务写入同事务。

通过的是本地逻辑及离线SDK契约；真实云数据库并发、微信实际交互和正式同意文案仍需后续联调与发布前确认。下一项为 T08：保存历史计分依据。
