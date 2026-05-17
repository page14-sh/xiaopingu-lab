-- ============================================
-- 补全所有咨询师 C-NIP 偏好画像
-- 前置条件：先执行 migration-add-cnip-fields.sql
-- 策略：按咨询取向智能分配 C-NIP 风格
-- ============================================

-- CBT 倾向 → structured + rational + present + direct + yes
UPDATE counselors
SET cnip_styles = ARRAY['structured', 'balanced'],
    cnip_emotion_focus = ARRAY['rational', 'balanced'],
    cnip_time = ARRAY['present', 'balanced'],
    cnip_stance = ARRAY['direct', 'balanced'],
    cnip_homework = ARRAY['yes', 'neutral'],
    cnip_relational = ARRAY['neutral', 'discuss']
WHERE 'CBT' = ANY(approaches) AND cnip_styles IS NULL;

-- 精神动力学 → open + emotional + past + warm + no
UPDATE counselors
SET cnip_styles = ARRAY['open', 'balanced'],
    cnip_emotion_focus = ARRAY['emotional', 'balanced'],
    cnip_time = ARRAY['past', 'balanced'],
    cnip_stance = ARRAY['warm', 'balanced'],
    cnip_homework = ARRAY['no', 'neutral'],
    cnip_relational = ARRAY['discuss', 'neutral']
WHERE '精神动力学' = ANY(approaches) AND cnip_styles IS NULL;

-- 人本主义 → open + emotional + present + warm + no
UPDATE counselors
SET cnip_styles = ARRAY['open'],
    cnip_emotion_focus = ARRAY['emotional'],
    cnip_time = ARRAY['present', 'balanced'],
    cnip_stance = ARRAY['warm'],
    cnip_homework = ARRAY['no'],
    cnip_relational = ARRAY['discuss']
WHERE '人本主义' = ANY(approaches) AND cnip_styles IS NULL;

-- EMDR → structured + emotional + past + warm + neutral
UPDATE counselors
SET cnip_styles = ARRAY['structured'],
    cnip_emotion_focus = ARRAY['emotional', 'balanced'],
    cnip_time = ARRAY['past'],
    cnip_stance = ARRAY['warm', 'challenging'],
    cnip_homework = ARRAY['neutral'],
    cnip_relational = ARRAY['discuss', 'neutral']
WHERE 'EMDR' = ANY(approaches) AND cnip_styles IS NULL;

-- ACT → balanced + balanced + present + warm + yes
UPDATE counselors
SET cnip_styles = ARRAY['balanced', 'open'],
    cnip_emotion_focus = ARRAY['balanced'],
    cnip_time = ARRAY['present'],
    cnip_stance = ARRAY['warm', 'balanced'],
    cnip_homework = ARRAY['yes', 'neutral'],
    cnip_relational = ARRAY['discuss', 'neutral']
WHERE 'ACT' = ANY(approaches) AND cnip_styles IS NULL;

-- DBT → structured + emotional + present + direct + yes
UPDATE counselors
SET cnip_styles = ARRAY['structured', 'balanced'],
    cnip_emotion_focus = ARRAY['emotional', 'balanced'],
    cnip_time = ARRAY['present'],
    cnip_stance = ARRAY['direct', 'warm'],
    cnip_homework = ARRAY['yes'],
    cnip_relational = ARRAY['neutral', 'discuss']
WHERE 'DBT' = ANY(approaches) AND cnip_styles IS NULL;

-- EFT → open + emotional + present + warm + neutral
UPDATE counselors
SET cnip_styles = ARRAY['open', 'balanced'],
    cnip_emotion_focus = ARRAY['emotional'],
    cnip_time = ARRAY['present', 'past'],
    cnip_stance = ARRAY['warm'],
    cnip_homework = ARRAY['neutral'],
    cnip_relational = ARRAY['discuss']
WHERE 'EFT' = ANY(approaches) AND cnip_styles IS NULL;

-- 家庭治疗 → balanced + balanced + past + warm + yes
UPDATE counselors
SET cnip_styles = ARRAY['balanced', 'structured'],
    cnip_emotion_focus = ARRAY['balanced', 'emotional'],
    cnip_time = ARRAY['past', 'present'],
    cnip_stance = ARRAY['warm', 'direct'],
    cnip_homework = ARRAY['yes', 'neutral'],
    cnip_relational = ARRAY['discuss']
WHERE '家庭治疗' = ANY(approaches) AND cnip_styles IS NULL;

-- 正念 → balanced + balanced + present + warm + yes
UPDATE counselors
SET cnip_styles = ARRAY['balanced', 'open'],
    cnip_emotion_focus = ARRAY['balanced'],
    cnip_time = ARRAY['present'],
    cnip_stance = ARRAY['warm', 'balanced'],
    cnip_homework = ARRAY['yes', 'neutral'],
    cnip_relational = ARRAY['neutral', 'discuss']
WHERE '正念' = ANY(approaches) AND cnip_styles IS NULL;

-- 短程焦点/SFBT → structured + rational + present + directive + yes
UPDATE counselors
SET cnip_styles = ARRAY['structured', 'balanced'],
    cnip_emotion_focus = ARRAY['rational', 'balanced'],
    cnip_time = ARRAY['present'],
    cnip_stance = ARRAY['direct', 'balanced'],
    cnip_homework = ARRAY['yes', 'neutral'],
    cnip_relational = ARRAY['neutral', 'skip']
WHERE ('短程焦点' = ANY(approaches) OR '焦点解决短期治疗（SFBT）' = ANY(approaches)) AND cnip_styles IS NULL;

-- 叙事治疗 → open + emotional + present + warm + neutral
UPDATE counselors
SET cnip_styles = ARRAY['open'],
    cnip_emotion_focus = ARRAY['emotional', 'balanced'],
    cnip_time = ARRAY['present', 'past'],
    cnip_stance = ARRAY['warm', 'balanced'],
    cnip_homework = ARRAY['neutral'],
    cnip_relational = ARRAY['discuss']
WHERE '叙事治疗' = ANY(approaches) AND cnip_styles IS NULL;

-- 格式塔 → open + emotional + present + warm + neutral
UPDATE counselors
SET cnip_styles = ARRAY['open', 'balanced'],
    cnip_emotion_focus = ARRAY['emotional'],
    cnip_time = ARRAY['present'],
    cnip_stance = ARRAY['warm', 'challenging'],
    cnip_homework = ARRAY['neutral'],
    cnip_relational = ARRAY['discuss']
WHERE '格式塔' = ANY(approaches) AND cnip_styles IS NULL;

-- 躯体治疗 → balanced + emotional + present + warm + neutral
UPDATE counselors
SET cnip_styles = ARRAY['balanced', 'open'],
    cnip_emotion_focus = ARRAY['emotional', 'balanced'],
    cnip_time = ARRAY['present', 'past'],
    cnip_stance = ARRAY['warm'],
    cnip_homework = ARRAY['neutral'],
    cnip_relational = ARRAY['discuss', 'neutral']
WHERE '躯体治疗' = ANY(approaches) AND cnip_styles IS NULL;

-- 艺术治疗/沙盘 → open + emotional + past + warm + no
UPDATE counselors
SET cnip_styles = ARRAY['open'],
    cnip_emotion_focus = ARRAY['emotional'],
    cnip_time = ARRAY['past', 'present'],
    cnip_stance = ARRAY['warm'],
    cnip_homework = ARRAY['no', 'neutral'],
    cnip_relational = ARRAY['discuss']
WHERE ('艺术治疗' = ANY(approaches) OR '沙盘游戏' = ANY(approaches) OR '游戏治疗' = ANY(approaches) OR '发展游戏治疗' = ANY(approaches)) AND cnip_styles IS NULL;

-- 兜底：其余未分配的给通用 balanced
UPDATE counselors
SET cnip_styles = ARRAY['balanced'],
    cnip_emotion_focus = ARRAY['balanced'],
    cnip_time = ARRAY['balanced'],
    cnip_stance = ARRAY['balanced'],
    cnip_homework = ARRAY['neutral'],
    cnip_relational = ARRAY['neutral']
WHERE cnip_styles IS NULL;

-- 验证
SELECT COUNT(*) AS total,
       COUNT(cnip_styles) AS has_cnip,
       COUNT(*) - COUNT(cnip_styles) AS missing_cnip
FROM counselors WHERE is_active = true AND review_status = 'approved';
