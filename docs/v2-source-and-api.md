# v2 源码位置与前端接入契约

当前后端源码：`cloudrun/xiaopingu-api/`。业务入口 `app.js` / `index.js`；通用四评接口在 `assessment/http.js`，迁移后的登录、旧页面兼容、档案与运营看板在 `portal/http.js`、`portal/repository.js`、`portal/legacy-rest.js`。页面发布源码为 `legacy-web/`，不是旧 `web/`。

正式 API：`https://xiaopingu-assessment-308810-6-1300577165.sh.run.tcloudbase.com`。
测试 API：`https://xiaopingu-assessment-preview-308810-6-1300577165.sh.run.tcloudbase.com`，只含合成数据。

## 三种标识不能混用

| 标识 | 用途 | 不能做什么 |
| --- | --- | --- |
| 评估 id / view_token（UUID） | 旧初评及对应历史读取 | 不能登录为新版来访者、签署或填卡 |
| 新版独立填写凭证 `xpg2_…` | 交换来访者短期会话 | 不能作为咨询师或管理员凭据 |
| 咨询师 id（UUID） | 指定申请对象、筛选本人申请 | 不能登录；登录必须用本人 edit_token 编辑码 |

人员请求使用 `Authorization: Bearer <服务端返回的 token>`。不要填 `dev-local-key`、评估号、咨询师 id 或直接把编辑码当作 Bearer token。不要从浏览器缓存的角色名称推定服务端权限。

## 登录

- `POST /auth/visitor-receipt`：`{"credential":"<独立填写凭证>"}`，返回 `token`、`expires_at`、`visitor_id`、`read_only:false`。
- `POST /auth/history`：`{"credential":"<旧完整 view_token>"}`，返回只读历史 token，aud 为 `xg-history`，不能访问四评写接口。
- `POST /auth/counselor`：`{"credential":"<本人编辑码>"}`，返回 `token`、`counselor`、`expires_in`。咨询师入驻尚未审核时只能编辑本人资料，不能承接申请或填四评。
- `POST /auth/admin`：`{"password":"<后台密码>"}`，返回管理员 token。测试后台与正式后台分开。
- `GET /v1/xg/me`：验证 token 并返回服务端 `id`、`role`、`auth_method`；无权访问返回 401/403。过期会话应重新登录。

## 首次初评与申请

1. 浏览器使用 `crypto.getRandomValues(new Uint8Array(32))` 生成 256 位秘密，base64url 编码后加 `xpg2_` 前缀。先私下保存；不要使用 Math.random、UUID 或评估号作为填写秘密。
2. `POST /rest/v1/assessments`，传初评表单、客户端 UUID `id` 和 `client_claim_secret`。返回数组中的记录；服务端在事务中绑定身份，不把明文秘密保存到初评记录或返回给咨询师。
3. 已登录来访者再次初评时带原来访 token，新初评归入原身份。首次提交重试必须使用相同 `id` 和 `client_claim_secret`，不同秘密碰撞返回 409，不能将任意 409 当成成功。
4. 用该独立凭证调用 `/auth/visitor-receipt` 获取 token。
5. `GET /rest/v1/counselors?is_active=eq.true&review_status=eq.approved` 查询可申请咨询师。
6. `PATCH /rest/v1/assessments?id=eq.<assessment_id>`，携带本人来访 token，body 为 `match_request_cid`、`match_request_name`、`match_request_contact`。初评超出准入范围时不能申请。

仅持旧评估链接的人需要平台核验并交付新版填写凭证；不能通过旧链接自动认领新的写权限。

## 咨询师审批

- 本人 token 查询：`GET /rest/v1/assessments?match_request_cid=eq.<counselor_id>&order=created_at.desc`。
- 审批：`PATCH /rest/v1/assessments?id=eq.<assessment_id>`，body：`{"match_request_status":"approved","match_request_reviewed_note":"备注"}`。拒绝用 `rejected`。
- 审批通过后，兼容接口会幂等批准申请并创建新版咨询周期，响应记录带 `match_id`。
- 直接使用原生 `/v1/xg/match-requests/:id/approve` 后，还需调用原生 `/v1/xg/matches` 建立周期；不要混淆两套接口的返回行为。
- 本人 ID 不匹配、令牌过期、演示别名、未通过入驻审核、没有真实所属关系都不能通过放宽前端条件来解决。
- 旧已批准历史记录不会自动开新周期。无 current_request_id 的历史审批会提示重新申请；不得伪造周期。

## 四评与结果

- `GET /v1/xg/portal/cases`：本人可见的初评、申请和周期；管理员可见全部。`request_counselor_id` 用于决定是否展示本人审批按钮，服务器仍重新校验权限。
- `GET /v1/xg/me/consent?scope=assessment` / `followup` 读取当前文案；POST 同路径需版本、文案哈希、agreed、channel、client_event_id、expected_revision，由本人主动确认。
- `GET /v1/xg/prompts/next?match_id=…&session_no=…&scope=…` 返回当前可填卡。不能绕开同意、节次或随访到期限制。
- `POST /v1/xg/events/start` 返回冻结 form；题目、适用状态、选项和校验范围以响应为准。
- `POST /v1/xg/events` 提交。client_event_id 代表一次尝试，request_id 代表一次操作；网络重试复用同一操作 ID，改答案换 request_id。
- `POST /v1/xg/events/abandon` 的 reason 为 `user_exit` / `page_leave` / `timeout`，不是任意字符串。
- `GET /v1/xg/events?match_id=…`：来访只看保存状态；咨询师查看本人周期 M2/M3 允许字段；管理员查看具体记录与计分结果。
- `GET /v1/xg/trend`、`/person-compare`：咨询师/管理员查看趋势和阶段结果。
- `GET/POST /v1/xg/portal/case-config`：人工关注点和选修；POST 要 expected_revision。
- `POST /v1/xg/portal/close`：咨询师/管理员传 match_id、session_no；结案后按真实时间安排随访。

完整原生四评契约参见 `specs/assessment-foundation/api-contract.md`。

## 运营后台

- `GET /rest/v1/counselors` + 管理员 token：全部咨询师，包含待审、已通过、已拒绝和停用记录；匿名查询只会返回可匹配人员，两者不是同一个口径。
- `GET /v1/xg/portal/board` + 管理员 token：新版周期与作答数量、咨询师关联，不返回密钥或原始答案。
- `GET /v1/xg/admin/stats` + 管理员 token：版本化统计结果。`metrics.<key>.status` 区分 available / suppressed / unavailable；比例读 value，分布读 p50/p90。小样本按不同来访者人数隐藏，不能拿对象当旧版数字。
- 原 `/xg/cases`、`/xg/stats` 不是 v2 契约，前端不要继续调用。

原生错误通常为 `{"error":{"code":"XG_…","message":"…"}}`；portal/兼容接口可能是平铺 `code/message`。调用端同时读取两种错误外形。无权限不应显示为空列表或吞掉错误。

## 固定演示账号适配

`POST /api/auth/account` 仅存在于本机独立测试平台（8796；验收另用 8797），请求为 `{role, username, password}`。服务端校验固定测试账号后调用 preview 正常角色认证接口，返回实际角色令牌；来访者同时获得其独立填写凭证。该路由不在正式 CloudRun 中提供，正式凭证规则没有改变。账号映射和密码保存在被 Git 忽略的 `.private/test-chain/`，不随静态站点发布。
