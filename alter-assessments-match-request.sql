-- ============================================
-- 小平菇 · assessments 表新增匹配申请字段
-- 在 Supabase SQL Editor 中执行
-- ============================================

-- 新增字段：存储来访者对咨询师的匹配申请
ALTER TABLE assessments ADD COLUMN match_request_name TEXT;
ALTER TABLE assessments ADD COLUMN match_request_contact TEXT;
ALTER TABLE assessments ADD COLUMN match_request_cid UUID REFERENCES counselors(id);

-- 验证
SELECT id, visitor_name, match_request_name, match_request_contact, match_request_cid
FROM assessments
ORDER BY created_at DESC
LIMIT 5;
