-- 添加 edit_token 字段到 counselors 表
-- 执行后，新注册的咨询师会自动获得专属编辑链接

ALTER TABLE counselors ADD COLUMN IF NOT EXISTS edit_token TEXT UNIQUE;

-- 创建唯一索引，加速按 token 查询
CREATE UNIQUE INDEX IF NOT EXISTS idx_counselors_edit_token 
  ON counselors(edit_token);

-- 确认 UPDATE RLS 策略已存在（已存在可跳过）
-- CREATE POLICY IF NOT EXISTS anon_update_counselors 
--   ON counselors FOR UPDATE TO anon USING (true) WITH CHECK (true);
-- 注：supabase-config.js 中已有 update_own_counselor 策略（USING true），anon 角色可 UPDATE
