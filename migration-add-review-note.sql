-- ============================================
-- 小平菇 · assessments 表新增审核备注字段
-- 在 Supabase SQL Editor 中执行
-- 日期：2026-06-01
-- ============================================

-- 新增字段：审核备注（咨询师审批匹配申请时可填写拒绝理由等）
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS match_request_reviewed_note TEXT;

-- 验证
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'assessments' AND column_name = 'match_request_reviewed_note';
