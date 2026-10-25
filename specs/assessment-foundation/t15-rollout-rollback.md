# T15｜阶段开关、提醒展示与回滚

日期：2026-10-25。状态：本地实现与专项验收完成；未部署、未向真实用户发送提醒。

后续T16已将collection_paused接入随访到期入队，并将待填卡片占位入口替换为真实排程读取。见 [T16说明](t16-close-followup.md)。

后续T17已支持提醒处理状态查询、ack/CST、私人站内信与发送worker；默认pending保留已查看但未完成的提醒。本文未开放功能的描述为T15交付时状态，当前契约见 [T17说明](t17-notification-delivery.md)。

## 交付内容

新增全局阶段策略、单案有效策略、周期内咨询师提醒视图、开关修订历史，以及紧急回滚和新开卡暂停守卫。原始信号计算、组合结果和历史证据始终独立于提醒开关。

默认值：enable_reminder=false、enable_cst=false、emergency_stop=false、collection_paused=false。安全线始终可见，safety_always_on仅作为只读不变量返回，不提供关闭接口。

新增私有集合xg_rollout_policy和xg_rollout_history，集合声明共28个；已有xg_case_switches继续用于周期级开关。GET不会初始化配置；首次新开卡可创建revision=0的默认并发锁记录，不能将此理解为打开提醒。客户端直接数据库权限要求不变，旧通用REST未开放这些集合。

## 生效优先级

| 情况 | 普通L1 | 普通L2 | 普通L3 | DISSOC安全提示 |
| --- | --- | --- | --- | --- |
| 阶段一：全局关、单案关 | 可见 | 隐藏 | 隐藏 | 可见 |
| 全局关、单案提醒开 | 可见 | 仅该案可见 | 隐藏 | 可见 |
| 全局提醒开 | 可见 | 可见 | 可见 | 可见 |
| emergency_stop=true | 隐藏 | 隐藏 | 隐藏 | 可见 |

全局/单案的enable_cst使用“或”关系，但只对**实际可见的L2/L3**附加CST步骤；L1不附CST。紧急停用覆盖所有CST开关，包括安全提示上的CST展示。安全提示本身仍保留。

这解决原包回滚描述中的冲突：只把全局enable_reminder设为false，仍可能被已开启的单案开关放开L2。真正暂停普通提醒须同时启用emergency_stop，不能把“回到阶段一”误当作“完全关闭普通提醒”。

单案接口不存在enable_l3，也不能设置全局开关或关闭安全线。咨询师只可修改自己当前周期的两个既有开关，不能操作同一来访的另一周期。

## 全局管理接口

### 读取与修改

`GET /v1/xg/admin/rollout`

`POST /v1/xg/admin/rollout`

```json
{
  "expected_revision": 0,
  "enable_reminder": true,
  "enable_cst": true,
  "reason": "经审阅进入下一阶段"
}
```

允许局部修改enable_reminder、enable_cst、emergency_stop、collection_paused，必须是布尔值。expected_revision必填，reason非空且不超过500字符。只允许管理员，作者来自会话；拒绝客户端身份字段、safety_always_on、enable_l3及其他未知字段。

返回保存值、revision、只读安全不变量、stage、更新时间、作者及原因。stage是派生值（phase_one/phase_two/emergency_paused），不额外保存一个可能与开关矛盾的阶段号。采集暂停独立于stage。

变更与追加历史在同一事务保存。过期修订返回409 `XG_ROLLOUT_CONFLICT`，当前版本的相同变更重试不增加修订；无实际变化也不重复留痕。全局版本推进后重试旧变更不会将配置倒退。新开卡使用的access_revision不消耗管理员的语义revision。

### 紧急回滚

`POST /v1/xg/admin/rollout/rollback`

```json
{ "expected_revision": 1, "reason": "暂停普通提醒，保留采集和审计" }
```

在一个事务内设置enable_reminder=false、enable_cst=false、emergency_stop=true，并记录rollback历史。collection_paused维持原值，单案保存值不被批量抹掉；原始答卷、计分、组合、规则版本和历史数据不删除、不回写、不重新入队。

解除紧急停用须管理员显式设置emergency_stop=false。解除后保留的单案开关会重新生效：全局仍关时，已自开的案可恢复L2，但普通L3仍不可见。恢复前可通过case-switch读取保存值与effective值确认效果。

### 历史审计

`GET /v1/xg/admin/rollout/history?scope=global&revision=2`

`GET /v1/xg/admin/rollout/history?scope=case&match_id=...&revision=1`

仅管理员可读，返回变更前后值、范围、修订、操作者、原因、动作和时间。历史采用确定主键追加保存，不覆盖已有修订，不提供DELETE或任意写入入口。

## 单案设置兼容

原 `GET/POST /v1/xg/case-switch` 继续存在，POST只允许咨询师本人周期。

```json
{
  "match_id": "cycle-id",
  "enable_reminder": true,
  "enable_cst": true,
  "expected_revision": 0,
  "reason": "为本案启用复核流程"
}
```

新增revision及effective返回值，包含全局/单案修订、各级可见性、有效CST、安全线和采集暂停状态。保存为true但被紧急停用压住时，effective会明确为false。

为兼容T05既有调用，expected_revision和reason在单案POST仍为可选；新调用应携带修订号，以拒绝过期变更。不带修订号的旧调用按事务中的最新值合并局部布尔补丁，不能保证阻止同字段旧请求的迟到覆盖。两种调用均有修订历史，重复相同保存值不追加记录。

## 咨询师提醒视图

`GET /v1/xg/counselor/inbox?match_id=...`

必填match_id。可选session_no、alert_type（outcome/alliance/stability/dissociation）、limit（1–200，默认50）、offset（0–100000，默认0）。这是按周期授权的读取，不提供跨周期无范围扫描。

- 来访403；咨询师限自己的周期，管理员仍须指定周期；所有响应no-store。
- 使用T13/T14真实计算结果。组合降为L1的OUT-DROP按L1展示，原始L2仍留在管理员审计中；普通提醒视图不泄露被隐藏的原始等级。
- 安全提示以稳定signal_id去重，M0安全信号被多个节次引用也只显示一次。
- 全局与单案开关在候选结果组装后的同一读取事务中获取，避免重算期间发生回滚后仍使用旧开关。
- 过滤权限、等级和查询条件后才分页，不返回隐藏条目总数。
- 输出仅含稳定alert_id、周期/节次/事件ID、类型、有效等级、安全标记、来源提交时间、组合修订、固定中性提示和可用CST步骤。没有分数、原始答案、完整规则或运行时凭据。
- source_submitted_at明确是源答卷提交时间，不冒充发送或处理时间。

此接口是计算结果驱动的提醒视图，尚不是有已读/关闭状态的通知台账；status=open等处理状态查询暂不支持。实际ack、CST回写、发送通道、发送前再次检查策略及失败重试均由T17衔接。启用展示不等于已经推送消息或自动启动督导。

## 暂停采集与完整性

collection_paused=true时，新 `/events/start` 返回409 `XG_COLLECTION_PAUSED`，`/prompts/next` 返回空列表。开始操作与暂停配置共享数据库冲突锚点，避免两个互不关联的写事务绕过开关。

已存在的尝试仍可恢复、提交、拒绝后修正或放弃；已提交请求仍可幂等重试。查看历史、撤销同意、计算及结案不受此开关删除或改写。关闭collection_paused后恢复新开卡。

普通紧急回滚默认不暂停采集。需要停止新开卡时，管理员单独修改collection_paused；它不自动恢复或擦除其他开关。未来T16调度也须沿用此采集策略，当前已接入已有推卡占位入口。

## 验收

运行 `npm run test:cloudbase`：**307项通过，0失败**，T15新增23项，原284项保留。专项见 [rollout.test.js](../../cloudrun/xiaopingu-api/assessment/rollout.test.js)。

覆盖全局/单案/紧急停用矩阵及CST组合、默认不写库、安全不变量、阶段一分页、单案只开L2、普通L3全局限制、紧急回滚/恢复、原始数据不变、派生L1不泄露原等级、安全去重、暂停新卡但保留已有操作、结案、全局/单案修订与审计、并发更新、回滚期间读取、作者/范围/参数权限及暂停推卡。

安装版SDK模拟传输还验证新开卡与暂停冲突锚点处于同一事务。未重跑真库MVCC测试；T21需联调新增集合、客户端拒绝规则和实际并发，T17需接入发送前策略复核。已做语法检查、集合声明一致性及CloudBase安全审查；未部署或改变实际环境配置。
