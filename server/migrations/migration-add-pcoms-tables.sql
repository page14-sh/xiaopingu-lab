-- ============================================
-- PCOMS 循证追踪模块 - 数据表迁移
-- 执行前请确保 assessments 和 counselors 表已存在
-- ============================================

-- 1. 会话表：记录每次咨询的元信息
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id UUID REFERENCES assessments(id) ON DELETE SET NULL,
  counselor_id UUID REFERENCES counselors(id) ON DELETE SET NULL,
  visitor_name TEXT,
  session_number INTEGER DEFAULT 1,
  session_date DATE DEFAULT CURRENT_DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. PCOMS 评分表：ORS + SRS 的每次评分
CREATE TABLE IF NOT EXISTS pcoms_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('ORS', 'SRS')),
  item_individual REAL NOT NULL CHECK (item_individual >= 0 AND item_individual <= 10),
  item_interpersonal REAL NOT NULL CHECK (item_interpersonal >= 0 AND item_interpersonal <= 10),
  item_social REAL NOT NULL CHECK (item_social >= 0 AND item_social <= 10),
  item_overall REAL NOT NULL CHECK (item_overall >= 0 AND item_overall <= 10),
  total_score REAL NOT NULL GENERATED ALWAYS AS (
    item_individual + item_interpersonal + item_social + item_overall
  ) STORED,
  clinical_change TEXT CHECK (clinical_change IN ('improved', 'no_change', 'worsening')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. 索引
CREATE INDEX IF NOT EXISTS idx_sessions_assessment ON sessions(assessment_id);
CREATE INDEX IF NOT EXISTS idx_sessions_counselor ON sessions(counselor_id);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(session_date DESC);
CREATE INDEX IF NOT EXISTS idx_pcoms_session ON pcoms_ratings(session_id);
CREATE INDEX IF NOT EXISTS idx_pcoms_type ON pcoms_ratings(type);

-- 4. RLS 启用
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pcoms_ratings ENABLE ROW LEVEL SECURITY;

-- 5. RLS 策略 - sessions 表
-- 匿名用户可读（通过分享链接查看）
CREATE POLICY "anon_read_sessions" ON sessions
  FOR SELECT USING (true);

-- 匿名用户可写入（来访者提交会话记录）
CREATE POLICY "anon_insert_sessions" ON sessions
  FOR INSERT WITH CHECK (true);

-- 禁止匿名删除
CREATE POLICY "anon_no_delete_sessions" ON sessions
  FOR DELETE USING (false);

-- 匿名用户可更新
CREATE POLICY "anon_update_sessions" ON sessions
  FOR UPDATE USING (true) WITH CHECK (true);

-- 6. RLS 策略 - pcoms_ratings 表
-- 匿名用户可读
CREATE POLICY "anon_read_pcoms" ON pcoms_ratings
  FOR SELECT USING (true);

-- 匿名用户可写入
CREATE POLICY "anon_insert_pcoms" ON pcoms_ratings
  FOR INSERT WITH CHECK (true);

-- 禁止匿名删除
CREATE POLICY "anon_no_delete_pcoms" ON pcoms_ratings
  FOR DELETE USING (false);

-- 7. 注释
COMMENT ON TABLE sessions IS 'PCOMS 会话追踪表 - 记录每次咨询的元信息';
COMMENT ON TABLE pcoms_ratings IS 'PCOMS 评分表 - ORS结果评分 + SRS联盟评分';
COMMENT ON COLUMN pcoms_ratings.type IS 'ORS=Outcome Rating Scale, SRS=Session Rating Scale';
COMMENT ON COLUMN pcoms_ratings.clinical_change IS 'improved=改善(ORS变化>=+5), worsening=恶化(ORS变化<=-5), no_change=无显著变化';
