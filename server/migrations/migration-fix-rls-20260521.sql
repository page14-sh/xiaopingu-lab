-- ============================================
-- 小平菇 RLS 策略修复
-- 请在 Supabase SQL Editor 中执行此文件
-- 日期：2026-05-21
-- ============================================

-- 1. 删除旧的 SELECT 策略（如果存在）
DROP POLICY IF EXISTS "auth_select_assessment" ON assessments;

-- 2. 允许匿名查询评估数据（admin 后台需要）
--    如果不存在则创建，存在则跳过
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE policyname = 'anon_select_assessment' AND tablename = 'assessments'
  ) THEN
    CREATE POLICY "anon_select_assessment" ON assessments
      FOR SELECT USING (true);
  END IF;
END $$;

-- 3. 允许匿名更新评估数据（匹配申请 PATCH 需要）
--    如果不存在则创建，存在则跳过
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE policyname = 'anon_update_assessment' AND tablename = 'assessments'
  ) THEN
    CREATE POLICY "anon_update_assessment" ON assessments
      FOR UPDATE USING (true);
  END IF;
END $$;
