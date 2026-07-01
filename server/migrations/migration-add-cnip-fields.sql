-- ============================================
-- C-NIP 偏好画像字段迁移
-- 基于 Cooper-Norcross Inventory of Preferences (C-NIP) v1.1
-- 6 维度：咨询风格 / 情绪处理 / 时间取向 / 关系风格 / 作业倾向 / 关系讨论
-- ============================================

-- 1. 来访者评估表：6 个 TEXT 字段（三档单选）
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS cnip_structure TEXT;     -- structured / balanced / open
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS cnip_emotion TEXT;      -- emotional / balanced / rational
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS cnip_timefocus TEXT;    -- past / balanced / present
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS cnip_warmth TEXT;       -- warm / balanced / direct
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS cnip_homework TEXT;     -- yes / neutral / no
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS cnip_relational TEXT;   -- discuss / neutral / skip

-- 2. 咨询师档案表：6 个 TEXT[] 字段（多选，可适应多种风格）
ALTER TABLE counselors ADD COLUMN IF NOT EXISTS cnip_styles TEXT[];       -- {structured, balanced, open}
ALTER TABLE counselors ADD COLUMN IF NOT EXISTS cnip_emotion_focus TEXT[]; -- {emotional, balanced, rational}
ALTER TABLE counselors ADD COLUMN IF NOT EXISTS cnip_time TEXT[];         -- {past, balanced, present}
ALTER TABLE counselors ADD COLUMN IF NOT EXISTS cnip_stance TEXT[];       -- {warm, balanced, challenging}
ALTER TABLE counselors ADD COLUMN IF NOT EXISTS cnip_homework TEXT[];     -- {yes, neutral, no}
ALTER TABLE counselors ADD COLUMN IF NOT EXISTS cnip_relational TEXT[];   -- {discuss, neutral, skip}

-- 3. 索引（可选，加速匹配查询）
-- CREATE INDEX IF NOT EXISTS idx_assessments_cnip ON assessments(cnip_structure, cnip_emotion, cnip_warmth);
-- CREATE INDEX IF NOT EXISTS idx_counselors_cnip ON counselors USING GIN(cnip_styles, cnip_emotion_focus, cnip_stance);
