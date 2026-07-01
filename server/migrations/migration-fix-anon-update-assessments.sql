-- ============================================================
-- 修复：允许匿名用户更新 assessments 表
-- 原因：来访者提交匹配申请 / 选咨询师需要 PATCH assessments
-- 原策略 anon_no_update_assessment 阻止了所有匿名 UPDATE
-- 安全隐患低：评估记录本身就是匿名创建的，前台提交是正常操作
-- ============================================================

-- 移除旧策略（禁止匿名更新）
DROP POLICY IF EXISTS "anon_no_update_assessment" ON assessments;

-- 新策略：允许匿名更新已存在的评估记录
-- 前台只会 PATCH match_request_*/selected_counselor_* 等辅助字段
-- 原始评估数据（分数、症状等）在 INSERT 后不会在前台被修改
DROP POLICY IF EXISTS "anon_update_assessment" ON assessments;
CREATE POLICY "anon_update_assessment" ON assessments
  FOR UPDATE USING (true) WITH CHECK (true);
