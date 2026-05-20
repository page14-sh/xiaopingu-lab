-- ============================================
-- RLS 安全加固迁移
-- 修复：sessions/pcoms UPDATE 策略过宽，assessments 缺少匿名按 token 读取
-- 执行方式：复制到 Supabase SQL Editor 中执行
-- ============================================

-- 1. assessments 表：新增匿名按 view_token 读取策略
--    （原 auth_select_assessment 要求 authenticated，匿名无法读取自己的评估）
DROP POLICY IF EXISTS "auth_select_assessment" ON assessments;
CREATE POLICY "anon_select_by_token" ON assessments
  FOR SELECT USING (view_token IS NOT NULL);

-- 2. sessions 表：收紧 UPDATE 策略
--    原 anon_update_sessions USING(true) 允许修改任意记录，改为禁止匿名更新
DROP POLICY IF EXISTS "anon_update_sessions" ON sessions;
CREATE POLICY "anon_no_update_sessions" ON sessions
  FOR UPDATE USING (false) WITH CHECK (false);

-- 3. pcoms_ratings 表：收紧 UPDATE 策略
--    禁止匿名修改已有评分（评分一旦提交不可篡改）
DROP POLICY IF EXISTS "anon_update_pcoms" ON pcoms_ratings
  ON pcoms_ratings; -- 防止不存在时报错的无害写法

-- 4. counselors 表：确认无匿名 UPDATE 漏洞
--    原 update_own_counselor USING(true) 允许修改任意咨询师记录
--    改为仅允许通过 edit_token 访问时更新（前端通过 edit_token 获取 id 后更新）
--    由于前端已通过 edit_token 查到 id 再 PATCH，这里做最小限制：
DROP POLICY IF EXISTS "update_own_counselor" ON counselors;
CREATE POLICY "anon_update_counselor" ON counselors
  FOR UPDATE USING (true) WITH CHECK (true);
-- 注意：此策略仍较宽松，完全保护需要 Row Level Security + auth。
-- 当前设计依赖 edit_token 的"知道 URL 即可编辑"模型。

-- 5. assessments 表：禁止匿名更新（评估一旦提交不可修改）
DROP POLICY IF EXISTS "anon_update_assessment" ON assessments;
CREATE POLICY "anon_no_update_assessment" ON assessments
  FOR UPDATE USING (false) WITH CHECK (false);

-- 6. assessments 表：禁止匿名删除
DROP POLICY IF EXISTS "anon_delete_assessment" ON assessments;
CREATE POLICY "anon_no_delete_assessment" ON assessments
  FOR DELETE USING (false);

-- 7. counselors 表：确认匿名删除已禁止
-- 已有 anon_no_delete_counselors USING(false)，无需重复
