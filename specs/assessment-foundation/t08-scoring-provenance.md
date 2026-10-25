# T08：保存历史计分依据

日期：2026-10-25。状态：本地实现与验证完成，未发布云端题库/规则，未部署。

本文保留 T08 交付时的范围和测试记录。T09 已接通实际开始/提交/放弃接口及基础计分，当前状态见 [T09 交付说明](t09-event-lifecycle.md)。

## 结果

每个新作答事件首次创建时，服务端在同一事务里读取已发布的题库、规则及本周期配置，保存完整 `basis`。之后发布新版、修改关注点或切换选修，都不会改变已有事件的依据；同一事件重复请求也不重新取最新版本。

当前 HTTP 开始/提交流程仍受 T07 及 T09–T12 的边界约束，尚未开放写入。T08 接入的是内部事件创建原语；后续填卡页必须展示该事件已冻结的题目，再按同一依据校验/提交，不能展示最新题库却使用另一份历史快照计分。

## 每份事件保存的内容

| 内容 | 保存字段与说明 |
|---|---|
| 题目版本 | item_version、完整题库内容哈希 item_hash |
| 规则版本 | rule_version、rule_hash、完整 rules 定义及 engine_id |
| 发布组合 | release_revision，记录本次使用的题库/规则组合 |
| 卡片元数据 | 名称、阶段、填写角色、时机、引导语 |
| 实际题目 | 本次题干、原始题干 source_text、锚点、选项顺序与分值、题型、实际排序、必答和适用状态 |
| 选修状态 | optional_enabled、实际 enabled_optional_codes、独立 optional_max；核心 primary_max 保持固定量程 |
| 动态题面 | 本次 focus_text、来源、focus_revision；实际 s7 的 text 同时固定 |
| 个案配置 | config_revision，与独立的配置历史关联 |
| 归属 | match_id、visitor_id、counselor_id、event_id、节次与随访轮次 |
| 完整性 | captured_at 和整个依据对象的 basis_hash |

哈希使用排序后的 JSON 对象键计算，数组顺序保留。数据库改变对象键的顺序不会导致误报；改变选项顺序则会改变哈希。哈希用于内容一致性校验，不是数字签名或物理不可篡改存储。

历史依据嵌入事件，不依赖审计时再查询“当前题库”。读取时验证内容哈希、规则哈希和事件/周期归属。检测到改写或把另一事件的依据复制过来时，返回错误，不静默重新生成依据。

## 已纳入的定义

- [题库 JSON](../../cloudrun/xiaopingu-api/assessment/definitions/items-v3-2.json)：从用户提供的 `【修改版V3.2】04 seed_items.sql` 提取42题与7张卡片；没有执行 SQL，没有改写原始交付包。
- M0 明确组合 s1–s7 与 b1–b3/r1/r2/d1 共13题；M1 核心7题，选修整组追加3题；服务评价包含3个计分项及1个开放文本项。
- 题面、锚点、单选标签/值按原文件保留，包括原文件的空锚点。这里没有补造缺失文案。
- [规则定义](../../cloudrun/xiaopingu-api/assessment/definitions/rules-t03-v1.json)：按已确认 T03 记录核心分组、ORS组合、补足分组、量程、选修分离、首节不适用、质量参数、时间间隔和预警阈值/语义。
- 当前初始版本标识为 items-v3-2 / rules-t03-v1，engine_id 为 xg-core-t03-v1。

规则定义是可校验的 JSON 契约，不是来自数据库的任意可执行代码。T12 才实现/验证相应计分引擎；本项不宣称已完成计分或历史分数复算。后续必须根据历史 engine_id 与冻结规则选择正确实现，不能自动回退到最新算法。

当前结构契约固定7张卡片及42个题号、既定题型/分组/量程；允许通过新版本修改题面、选项文案及受支持的阈值/耗时等参数。新增题号、改变选项数值、分组或量程需显式升级结构/引擎契约，不能只改一个配置值后沿用旧解析器。

## 动态题面、选修与首节 p6

每周期配置由 optional_enabled 和 focus_text 组成，默认为关闭选修、使用题库默认题面。实际配置变化会新增历史记录，同时推进周期内配置修订号。

focus_revision 与配置总修订号分开：只改变选修时，focus_revision 不变；主题甲→主题乙→主题甲则会产生新的主题修订，不能复用以前的主题版本。配置历史保存修改人、时间和内容哈希，不能通过本服务覆盖旧修订。

M1 开启选修后实际保存10题，核心 primary_max 仍为70，选修单独为30。M0 仍为13题，不因为周期选修开启而追加 s8–s10。

首节 M3 的 p6 保留原题和选项，但明确记录 applicable=false、required=false 及 first_session_no_previous；完整主分量程为 null，并记录 total/pct/diff_post 应为空的规则。第二节起恢复普通六题规则，不伪造“持平=5”作答。

## 持久化和可信配置入口

新增4个私有集合，当前总声明数20个：

| 集合 | 主键 | 约束 |
|---|---|---|
| xg_item_versions | item_version | 同版本内容不可覆盖 |
| xg_rule_versions | rule_version | 同版本规则不可覆盖 |
| xg_assessment_release | current | 当前组合与发布修订号 |
| xg_case_assessment_configs | hash(match_id, revision) | 每周期配置历史，仅追加 |

当前配置修订号保存在 xg_matches 的 assessment_config_revision 中；配置历史与周期指针在同一事务更新。

仅提供可信服务端配置方法，没有开放客户端发布或修改题库路由：

- `store.provenance.publishVersions({item_version, rule_version, catalog, rules, published_by, expected_revision})`：同时发布两个不可变版本和当前组合，支持发布修订冲突检测；可复用已有且内容完全一致的版本。
- `store.provenance.setCaseConfig(matchId, {optional_enabled, focus_text, changed_by, expected_revision})`：写入该周期新配置修订，禁止改已结案周期。后续若接咨询师操作界面，必须先复用 T05 的身份与周期归属校验，不能让客户端直接调用存储层。

缺少已发布题库/规则时，新事件创建返回503 XG_BASIS_NOT_CONFIGURED，事务不会留下部分作答、成功名额或档案。应用启动不会自动发布版本；只有测试夹具预置定义。

客户端提供 basis、basis_hash、item_version、rule_version、optional_enabled 或 focus_text，不能替代服务端依据；内部事件插入原语也明确拒绝这些外带字段。

## 历史审计和读取权限

新增 `GET /v1/xg/admin/event-basis?match_id=…&event_id=…`，仅管理员可读，仍须提供匹配的周期和事件，禁止任意字段投影及重复查询参数。继承 T06 的 no-store 响应头。

正常事件返回 available=true 及完整 basis；旧事件没有依据时返回 available=false、reason=not_captured、basis=null。不会用今天的题库/规则伪造旧时依据，也不会因此改写旧数据。

专业端作答/趋势/阶段快照只增加 `basis_ref`：题库版本、规则版本、依据哈希、配置修订号、主题修订号和选修状态。它不包含原始题面、动态关注点全文或规则正文。来访的历史列表不返回这些字段，保持 T06 的原白名单。

版本标记供后续界面显示关注点或规则的变化位置；本次未实现图表标注 UI，也没有把不同量程的阶段分数连成同一曲线。

## 后续任务需要遵守的边界

- T09：start 创建事件时冻结并返回本次题面；提交/放弃流转保留原 basis，不重新抓取当前发布版本。
- T10：幂等与同意事务集成时，把同意校验、依据捕获和事件写入放到一致的事务边界；不要调用多个独立事务拼接一个提交。
- T11：必答、选项、首节 p6 不适用、选修题量均依据事件快照校验。
- T12：按冻结的 engine_id、规则定义和实际启用题目计分；对旧的 not_captured 记录明确拒绝自动复算或要求另行核对，不能猜测历史版本。
- T14/T19：预警复核和模型分析要引用相应事件的规则/题面版本；实际业务算法仍在对应任务实现。

## 验证与发布状态

- [依据捕获、版本发布与审计](../../cloudrun/xiaopingu-api/assessment/provenance.js)
- [事件存储接入](../../cloudrun/xiaopingu-api/assessment/repository.js)
- [专项测试](../../cloudrun/xiaopingu-api/assessment/provenance.test.js)

`npm run test:cloudbase`：97项全部通过，本项新增15项（14项版本/快照/权限场景及1项实际安装SDK的离线保存读取验证）。覆盖新版本不改旧事件、版本不可覆盖、动态主题与选修分离、首节 p6、缺配置拒绝、旧依据独立读取、内容/归属篡改、客户端伪造、旧记录不补造、事务回滚和管理员审计权限。

本项只修改本地代码与定义文件，没有执行原 SQL、创建云集合或发布正式题库/规则。真实 CloudBase 事务并发、表单展示链路及计分复算仍需后续任务验证。下一项为 T09：修正开始、提交、拒绝、放弃状态流转。
