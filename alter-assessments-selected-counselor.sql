-- ============================================
-- 小平菇 · assessments 表新增选咨询师字段
-- 在 Supabase SQL Editor 中执行
-- ============================================

-- 新增字段：记录来访者选定的咨询师
ALTER TABLE assessments ADD COLUMN selected_counselor_id UUID REFERENCES counselors(id);
ALTER TABLE assessments ADD COLUMN selected_counselor_name TEXT;
ALTER TABLE assessments ADD COLUMN selected_at TIMESTAMPTZ;

-- 验证
SELECT id, visitor_name, selected_counselor_id, selected_counselor_name, selected_at
FROM assessments
WHERE selected_counselor_id IS NOT NULL
ORDER BY created_at DESC
LIMIT 5;
