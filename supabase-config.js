// ========== Supabase 配置 ==========
// 实验室数据收集 + 咨询师精准匹配
//
// 启用步骤：
// 1. 在 https://supabase.com 创建免费项目
// 2. 在 SQL Editor 中执行下方建表 SQL
// 3. 填入您的 SUPABASE_URL 和 SUPABASE_ANON_KEY
// 4. 将 enableDataCollection 改为 true

var SUPABASE_CONFIG = {
  enableDataCollection: true,
  url: 'https://csvhikdiliwqoacitlag.supabase.co',
  anonKey: 'sb_publishable_atXq0SmWEiEY6UMouG4dLw_ouXN2U6B'
};

/*
===========================================
  Supabase SQL — 复制到 SQL Editor 执行
===========================================

-- 1. 来访者评估数据表
CREATE TABLE assessments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  visitor_name TEXT,
  visitor_age INTEGER,
  visitor_gender TEXT,
  visitor_occupation TEXT,
  prev_counseling TEXT,
  budget TEXT,                       -- low/mid/high/premium/空
  preferred_formats TEXT[],          -- ['线下面询','视频咨询','语音咨询','文字咨询']
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
  credential_level TEXT,          -- 三级/二级/注册心理师/精神科医生
  years_experience INTEGER DEFAULT 0,
  education TEXT,                 -- 学士/硕士/博士/医学学位
  license_number TEXT,
  city TEXT,
  -- 咨询取向
  approaches TEXT[],              -- ['CBT','ACT','DBT','EMDR'...]
  approach_primary TEXT,          -- 首选取向
  training_background TEXT,       -- 受训背景
  supervision_hours INTEGER DEFAULT 0,
  personal_therapy_hours INTEGER DEFAULT 0,
  ethics_training TEXT,               -- 是/否/进行中
  certifications TEXT[],          -- ['危机干预','EMDR认证'...]
  -- 擅长领域
  specialties TEXT[],             -- ['情绪困扰','关系困境'...]
  populations TEXT[],             -- ['成人','青少年'...]
  severity_levels TEXT[],         -- ['轻度','中度','重度','需精神科联合']
  -- 咨询方式
  session_formats TEXT[],         -- ['线下面询','视频咨询','语音咨询']
  session_duration TEXT,          -- 50分钟/60分钟/90分钟
  fee_min INTEGER DEFAULT 0,            -- 单次费用（元）
  fee_budget_level TEXT,               -- low/mid/high/premium
  available_slots TEXT,           -- 可预约时段
  -- 简介
  bio_short TEXT,                 -- 一句话简介
  bio_full TEXT,                  -- 详细介绍
  -- 状态
  is_active BOOLEAN DEFAULT true,
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

*/

// ========== API 封装 ==========

function getSupabaseHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_CONFIG.anonKey,
    'Authorization': 'Bearer ' + SUPABASE_CONFIG.anonKey,
    'Prefer': 'return=representation'
  };
}

// 保存评估数据
function saveAssessment(data) {
  if (!SUPABASE_CONFIG.enableDataCollection || !SUPABASE_CONFIG.url) return Promise.resolve();
  return fetch(SUPABASE_CONFIG.url + '/rest/v1/assessments', {
    method: 'POST',
    headers: getSupabaseHeaders(),
    body: JSON.stringify(data)
  }).then(function(r) {
    if (r.ok) { console.log('[小平菇] 评估数据已保存'); return r.json(); }
    else console.warn('[小平菇] 保存失败:', r.status, r.statusText);
  }).catch(function(e) { console.warn('[小平菇] 网络错误:', e); });
}

// 保存咨询师档案
function saveCounselor(data) {
  if (!SUPABASE_CONFIG.enableDataCollection || !SUPABASE_CONFIG.url) return Promise.resolve();
  return fetch(SUPABASE_CONFIG.url + '/rest/v1/counselors', {
    method: 'POST',
    headers: getSupabaseHeaders(),
    body: JSON.stringify(data)
  }).then(function(r) {
    if (r.ok) return r.json();
    else throw new Error('HTTP ' + r.status);
  }).catch(function(e) { console.warn('[小平菇] 保存失败:', e); });
}

// 更新咨询师档案
function updateCounselor(id, data) {
  if (!SUPABASE_CONFIG.enableDataCollection || !SUPABASE_CONFIG.url) return Promise.resolve();
  return fetch(SUPABASE_CONFIG.url + '/rest/v1/counselors?id=eq.' + id, {
    method: 'PATCH',
    headers: getSupabaseHeaders(),
    body: JSON.stringify({ ...data, updated_at: new Date().toISOString() })
  }).then(function(r) {
    if (r.ok) return r.json();
    else throw new Error('HTTP ' + r.status);
  }).catch(function(e) { console.warn('[小平菇] 更新失败:', e); });
}

// 匹配咨询师（核心匹配算法）
function matchCounselors(assessment) {
  if (!SUPABASE_CONFIG.enableDataCollection || !SUPABASE_CONFIG.url) return Promise.resolve([]);

  return fetch(SUPABASE_CONFIG.url + '/rest/v1/counselors?is_active=eq.true&select=*', {
    headers: {
      'apikey': SUPABASE_CONFIG.anonKey,
      'Authorization': 'Bearer ' + SUPABASE_CONFIG.anonKey
    }
  }).then(function(r) { return r.json(); })
  .then(function(counselors) {
    return counselors.map(function(c) {
      var score = 0;
      var details = [];

      // 1. 议题匹配 35%
      if (c.specialties && assessment.issues && assessment.issues.length > 0) {
        var overlap = assessment.issues.filter(function(i) {
          return c.specialties.indexOf(i) >= 0;
        });
        var issueScore = (overlap.length / assessment.issues.length) * 35;
        score += issueScore;
        if (overlap.length > 0) {
          details.push('议题匹配: ' + overlap.length + '/' + assessment.issues.length);
        }
      }

      // 2. 取向匹配 25%
      if (c.approaches && assessment.recommendedApproaches) {
        var approachMatch = assessment.recommendedApproaches.filter(function(a) {
          return c.approaches.indexOf(a) >= 0;
        });
        if (approachMatch.length > 0) {
          score += Math.min(25, approachMatch.length * 12.5);
          details.push('取向匹配: ' + approachMatch.join('/'));
        }
      }

      // 3. 程度承接 20%
      if (c.severity_levels) {
        var severityMap = { '轻度': 'mild', '中度': 'moderate', '重度': 'severe' };
        var clientLevel = severityMap[assessment.severity] || assessment.severity;
        var levelMap = { 'mild': '轻度', 'moderate': '中度', 'severe': '重度' };
        if (c.severity_levels.indexOf(levelMap[clientLevel]) >= 0 || c.severity_levels.indexOf(assessment.severity) >= 0) {
          score += 20;
          details.push('程度承接: 可承接' + assessment.severity);
        }
      }

      // 4. 门槛匹配 10%（核心硬性条件，不满足扣20分）
      var thresholdMet = true;
      // 从业年限
      if (assessment.minYears && c.years_experience < assessment.minYears) thresholdMet = false;
      // 资质等级
      if (assessment.minCredential) {
        var credRank = { '三级': 1, '二级': 2, '心理治疗师': 3, '社会工作师（初级）': 1, '社会工作师（中级）': 2, '社会工作师（高级）': 3, '精神科医生': 4 };
        if ((credRank[c.credential_level] || 0) < (credRank[assessment.minCredential] || 0)) {
          thresholdMet = false;
        }
      }
      if (thresholdMet) {
        score += 10;
        details.push('门槛匹配: 满足要求');
      } else {
        // 不满足硬性门槛时大幅扣分，使其排序靠后但不完全排除
        score = Math.max(0, score - 20);
        details.push('门槛匹配: 部分不满足（排序靠后）');
      }

      // 5. 咨询方式匹配 10%
      if (assessment.preferred_formats && assessment.preferred_formats.length > 0 && c.session_formats) {
        var formatOverlap = assessment.preferred_formats.filter(function(f) {
          return c.session_formats.indexOf(f) >= 0;
        });
        if (formatOverlap.length > 0) {
          score += 10;
          details.push('方式匹配: ' + formatOverlap.join('/'));
        }
      }

      // 6. 经济匹配 5%
      if (assessment.budget && c.fee_budget_level) {
        var budgetRank = { 'low': 1, 'mid': 2, 'high': 3, 'premium': 4 };
        var clientRank = budgetRank[assessment.budget] || 0;
        var counselorRank = budgetRank[c.fee_budget_level] || 0;
        if (clientRank > 0 && counselorRank > 0) {
          if (counselorRank <= clientRank) {
            score += 5;
            details.push('经济匹配: 费用在可承受范围内');
          } else if (counselorRank === clientRank + 1) {
            score += 2;
            details.push('经济匹配: 费用略高于预期');
          }
        }
      }

      return {
        counselor: c,
        matchScore: Math.min(100, Math.round(score)),
        matchDetails: details
      };
    })
    .filter(function(item) { return item.matchScore > 0; })
    .sort(function(a, b) { return b.matchScore - a.matchScore; });
  })
  .catch(function(e) {
    console.warn('[小平菇] 匹配查询失败:', e);
    return [];
  });
}
