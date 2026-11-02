# 咨询师照片：私有 CloudBase 云存储

## 存储与访问

沿用 CloudRun 的 `TCB_ENV`、`CLOUDBASE_APIKEY` 和 `XPG_COLLECTION_PREFIX`，不向浏览器下发云存储密钥，不新增公共上传接口，也不修改私有桶权限。正式和 preview 各自使用数据前缀作为对象路径的一部分：

`counselor-photos/{namespace}/{counselor_id}/{photo_daily|photo_license}/{random_uuid}.jpg`

文件名不包含姓名、证件号或原始文件名。数据库照片数组保存 `cloud://` 文件标识；接口读取时先进行身份校验和敏感字段过滤，再返回 `{file_id, url, expires_at}`。前端保存时仅回传 `file_id`，不把临时 URL 存入数据库。

- 生活照：本人、管理员可读；其他访问者只能读取已审核、启用的咨询师资料。
- 证书照：仅本人和管理员的有效会话能取得链接。匿名注册响应只返回新档案 ID、编辑凭证和审核状态，不返回证书链接。
- 临时链接请求有效期为 300 秒。持有链接者在有效期内可访问，因此仍须避免转发；页面采用 `no-referrer`，资料接口采用 `Cache-Control: no-store`。管理员每次打开详情都会重新读取；退出登录时清空详情和灯箱。
- 接受每类最多 2 张 JPG/PNG/WebP；每张输入 Data URL 不超过 260,000 字符。服务端校验实际图像格式、限制解码像素、转为最长边 900 像素 JPEG，去除 EXIF/GPS/ICC 等元数据。SVG、任意网络 URL、伪装图片和动画不接受。
- 文件引用必须已属于同一档案、同一部署空间、同一照片类别；证书引用不能改作生活照。服务端不请求客户端提供的图片 URL。

## 保存、旧数据和清理

照片随原有资料 POST/PATCH 上传，在云存储成功后才提交档案。保存失败明确报错，浏览器不会把新照片写入 localStorage，也不会显示提交成功；页面内的照片保留供重试。旧浏览器草稿读取到内存后从 localStorage 移除。

旧数据库 Base64 照片继续可读，提交包含该照片的资料保存请求时迁移到对象存储。不批量改写历史资料和备份。迁移后再次保存复用文件标识，不重复上传。

更新照片时使用事务比较旧照片快照，拒绝其他窗口提交的过期快照。替换/移除成功后删除原对象；保存失败则回读档案，只清理未被引用的新对象。数据库写入超时且无法确认是否提交时，保守保留私有对象，避免误删已提交照片。

清理失败记录固定告警 `XPG_PHOTO_CLEANUP_REQUIRED`，不记录文件 ID、URL、照片内容或云端凭据。运维应核对对应命名空间对象与当前档案引用，人工清理确认无引用的对象；当前没有新增自动清理任务。删除历史档案的既有禁令不变。

## 验证

```sh
npm test --prefix cloudrun/xiaopingu-api
npm run test:legacy-security
node scripts/verify-private-photos.cjs --run-cloud
node scripts/verify-private-photos-browser.cjs
```

云端验证读取本机忽略文件 `.env.v2-runtime.json`，仅使用合成图片和 `xg_preview_photosmoke_` 路径，不读写真实数据库；验证签名读取、无签名拒绝、元数据清除，并在 finally 中删除测试对象。浏览器验证使用内存数据和存储，需要 Playwright；可通过 `NODE_PATH` 使用已安装包，通过 `XPG_CHROMIUM_PATH` 指定 Chrome 可执行文件。

## 发布顺序

先发布兼容字符串/新对象两种照片格式的前端（`legacy-web/supabase-config.js`、`admin.html`、`counselor.html`、`index.html`、`my-assessment.html`），再部署带 `sharp` 依赖的 CloudRun 后端。部署保留现有环境变量与私有桶 ACL。正式服务为 `xiaopingu-assessment`，演示账号转发的 preview 服务也需部署同版后端，二者对象目录隔离。

回滚时须使用兼容云存储引用的版本；已迁移记录不能由只认识 Base64 的旧后端编辑，否则可能丢失照片引用。不得通过开放公有读或恢复旧数据库来规避回滚兼容问题。
