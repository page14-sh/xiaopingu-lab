-- ============================================
-- 小平菇 · Supabase 建表脚本
-- 复制到 SQL Editor 执行
-- ============================================

-- 1. 来访者评估数据表
CREATE TABLE assessments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  visitor_name TEXT,
  visitor_age INTEGER,
  visitor_gender TEXT,
  visitor_occupation TEXT,
  prev_counseling TEXT,
  budget TEXT,
  preferred_formats TEXT[],
  expects TEXT[],
  issues TEXT[],
  description TEXT,
  duration TEXT,
  score_mood INTEGER DEFAULT 0,
  score_anxiety INTEGER DEFAULT 0,
  score_sleep INTEGER DEFAULT 0,
  score_function INTEGER DEFAULT 0,
  score_relation INTEGER DEFAULT 0,
  total_score INTEGER DEFAULT 0,
  severity TEXT,
  specials TEXT[],
  crisis_level TEXT,
  user_agent TEXT
);

-- 2. 咨询师档案表
CREATE TABLE counselors (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  -- 基本信息
  name TEXT NOT NULL,
  credential_level TEXT,
  years_experience INTEGER DEFAULT 0,
  education TEXT,
  license_number TEXT,
  city TEXT,
  -- 咨询取向
  approaches TEXT[],
  approach_primary TEXT,
  training_background TEXT,
  supervision_hours INTEGER DEFAULT 0,
  personal_therapy_hours INTEGER DEFAULT 0,
  ethics_training TEXT,
  certifications TEXT[],
  -- 擅长领域
  specialties TEXT[],
  populations TEXT[],
  severity_levels TEXT[],
  -- 咨询方式
  session_formats TEXT[],
  session_duration TEXT,
  fee_min INTEGER DEFAULT 0,
  fee_budget_level TEXT,
  available_slots TEXT,
  -- 简介
  bio_short TEXT,
  bio_full TEXT,
  -- 状态
  is_active BOOLEAN DEFAULT true,
  -- 公益服务意愿
  public_welfare BOOLEAN DEFAULT false,
  -- 联系（可选）
  contact_wechat TEXT,
  contact_phone TEXT
);

-- 3. RLS 策略
ALTER TABLE assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE counselors ENABLE ROW LEVEL SECURITY;

-- 评估：匿名可插入
CREATE POLICY "anon_insert_assessment" ON assessments
  FOR INSERT WITH CHECK (true);

-- 评估：认证用户可查询
CREATE POLICY "auth_select_assessment" ON assessments
  FOR SELECT USING (auth.role() = 'authenticated');

-- 咨询师：匿名可读（用于匹配展示）
CREATE POLICY "anon_read_counselor" ON counselors
  FOR SELECT USING (is_active = true);

-- 咨询师：匿名可插入（录入）
CREATE POLICY "anon_insert_counselor" ON counselors
  FOR INSERT WITH CHECK (true);

-- 咨询师：通过 ID 更新（编辑自己的档案）
CREATE POLICY "update_own_counselor" ON counselors
  FOR UPDATE USING (true);

-- 4. 索引（加速匹配查询）
CREATE INDEX idx_counselors_active ON counselors(is_active);
CREATE INDEX idx_counselors_specialties ON counselors USING GIN(specialties);
CREATE INDEX idx_counselors_approaches ON counselors USING GIN(approaches);
CREATE INDEX idx_counselors_budget ON counselors(fee_budget_level);
