-- ============================================
-- 小平菇 · 小程序评估提交字段补齐
-- 原因：小程序提交 assessments 时会写入 view_token / visitor_city。
-- 若线上表缺少这些列，Supabase REST 会返回 400 并导致提交失败。
-- ============================================

ALTER TABLE assessments ADD COLUMN IF NOT EXISTS view_token TEXT;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS visitor_city TEXT;

CREATE INDEX IF NOT EXISTS idx_assessments_view_token ON assessments(view_token);
CREATE INDEX IF NOT EXISTS idx_assessments_visitor_city ON assessments(visitor_city);

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'assessments'
  AND column_name IN ('view_token', 'visitor_city');
