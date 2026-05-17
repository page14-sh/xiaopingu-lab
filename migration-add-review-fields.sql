-- ===========================================
-- 咨询师资质审核字段迁移
-- 在 Supabase SQL Editor 中执行
-- ===========================================

-- 1. 添加审核字段
ALTER TABLE counselors
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS review_note TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT;

-- 2. 批量将现有咨询师设为 approved（避免影响现有数据）
UPDATE counselors SET review_status = 'approved'
  WHERE review_status = 'pending' OR review_status IS NULL;

-- 3. 添加索引
CREATE INDEX IF NOT EXISTS idx_counselors_review_status
  ON counselors (review_status);

-- 4. 更新 RLS 策略：只让已审核通过的咨询师被匿名用户看到
DROP POLICY IF EXISTS "anon_read_counselor" ON counselors;
CREATE POLICY "anon_read_counselor" ON counselors
  FOR SELECT USING (is_active = true AND review_status = 'approved');
