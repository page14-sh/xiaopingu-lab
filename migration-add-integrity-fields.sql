-- migration-add-integrity-fields.sql
-- 给 counselors 表添加诚信声明相关字段
-- 在 Supabase SQL Editor 中执行此文件

ALTER TABLE counselors
  ADD COLUMN IF NOT EXISTS has_violation       TEXT    DEFAULT '否',
  ADD COLUMN IF NOT EXISTS violation_detail    TEXT    DEFAULT '',
  ADD COLUMN IF NOT EXISTS has_incident        TEXT    DEFAULT '否',
  ADD COLUMN IF NOT EXISTS incident_detail     TEXT    DEFAULT '',
  ADD COLUMN IF NOT EXISTS needs_deep_review   BOOLEAN DEFAULT false;

-- 索引：快速筛选需加深审核的咨询师
CREATE INDEX IF NOT EXISTS idx_counselors_needs_deep_review
  ON counselors (needs_deep_review)
  WHERE needs_deep_review = true;

-- 验证
SELECT
  COUNT(*) AS total_counselors,
  COUNT(has_violation) AS has_violation_col,
  COUNT(needs_deep_review) AS has_flag_col
FROM counselors
LIMIT 1;
