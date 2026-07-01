-- ============================================
-- 小平菇 · 数据修复脚本
-- 在 Supabase SQL Editor 中执行
-- ============================================

-- ========== 1. 修复 severity_levels 格式 ==========
-- 将旧中文描述统一为三级制（轻度/中度/重度）

-- 1a. 所有非空 severity_levels 统一更新为三级制
UPDATE counselors
SET severity_levels = ARRAY['轻度','中度','重度']
WHERE severity_levels != '{}';

-- 1b. 空数组补全（白吉等）
UPDATE counselors
SET severity_levels = ARRAY['轻度','中度','重度']
WHERE severity_levels = '{}' OR severity_levels IS NULL;

-- ========== 2. 清理重复咨询师记录 ==========
-- 钱雨欢：保留最早一条（id: 40f828a8），删除另外两条
DELETE FROM counselors WHERE id = '1d6142d3-9370-4d97-aa48-47ba7828eed9';
DELETE FROM counselors WHERE id = '8f09718f-3a78-4eec-983f-fadd473f2284';
DELETE FROM counselors WHERE id = '30b7e8c8-72e9-4051-9ad9-16324c24d0be';

-- 王勤：保留最早一条（id: 0ae18959），删除重复
DELETE FROM counselors WHERE id = 'b32a2430-32da-49ad-a115-47834b84e6a8';

-- 钱烨：保留最早一条（id: b5fa5052），删除重复
DELETE FROM counselors WHERE id = '4703f765-78c4-41d7-a330-64bdfc294a6b';

-- 马俊萍：保留最早一条（id: 45ecceb9），删除重复
DELETE FROM counselors WHERE id = 'e91750af-9f1a-48e3-b145-a8249689b5d9';

-- ========== 3. 验证修复结果 ==========
SELECT name, city, severity_levels, is_active, fee_min
FROM counselors
WHERE is_active = true
ORDER BY created_at;
