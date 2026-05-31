-- ============================================
-- 小平菇 · assessments 表新增匹配申请状态字段
-- 在 Supabase SQL Editor 中执行
-- ============================================

-- 新增字段：匹配申请状态及审批记录
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS match_request_status TEXT DEFAULT 'pending';
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS match_request_reviewed_at TIMESTAMPTZ;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS match_request_reviewed_by TEXT;

-- 将已有匹配申请（match_request_name 不为空）的状态统一设为 pending
UPDATE assessments 
SET match_request_status = 'pending'
WHERE match_request_name IS NOT NULL 
  AND (match_request_status IS NULL OR match_request_status = '');

-- 验证
SELECT id, visitor_name, match_request_name, match_request_status, match_request_reviewed_at
FROM assessments
WHERE match_request_name IS NOT NULL
ORDER BY created_at DESC
LIMIT 10;
