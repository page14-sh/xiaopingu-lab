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
  user_agent TEXT,
  -- 偏好与扩展字段
  filled_by TEXT,                     -- 本人/家长/监护人/其他
  is_minor BOOLEAN DEFAULT false,
  visitor_city TEXT,
  gender_pref TEXT,                   -- male/female/any
  age_pref TEXT,                      -- senior/mid/peer
  orientation_pref TEXT,              -- friendly/experienced/any
  comm_style TEXT,                    -- warm/direct/professional
  view_token TEXT UNIQUE,
  -- C-NIP 偏好
  cnip_structure TEXT,                -- structured/balanced/open
  cnip_emotion TEXT,                  -- emotional/balanced/rational
  cnip_timefocus TEXT,                -- past/balanced/present
  cnip_warmth TEXT,                   -- warm/balanced/direct
  cnip_homework TEXT,                 -- yes/neutral/no
  cnip_relational TEXT                -- discuss/neutral/skip
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
  service_settings TEXT[],         -- ['个体咨询','伴侣咨询','家庭治疗','团体咨询']
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
  review_status TEXT NOT NULL DEFAULT 'pending',  -- pending/approved/rejected
  review_note TEXT,
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  -- 联系（可选）
  contact_wechat TEXT,
  contact_phone TEXT,
  -- 编辑与诚信
  edit_token TEXT UNIQUE,
  orientation_friendly TEXT[],       -- ['LGBTQ+友善','跨性别友善'...]
  client_gender_pref TEXT,           -- male_only/female_only/空
  client_age_prefs TEXT[],           -- ['6-12岁','12-18岁','成人','老年']
  comm_styles TEXT[],                -- ['温暖共情','直接高效','专业客观']
  has_violation BOOLEAN DEFAULT false,
  violation_detail TEXT,
  has_incident BOOLEAN DEFAULT false,
  incident_detail TEXT,
  integrity_confirm BOOLEAN DEFAULT false,
  deep_review BOOLEAN DEFAULT false, -- 加深审核标记
  -- C-NIP 偏好（多选）
  cnip_styles TEXT[],                -- {structured, balanced, open}
  cnip_emotion_focus TEXT[],         -- {emotional, balanced, rational}
  cnip_time TEXT[],                  -- {past, balanced, present}
  cnip_stance TEXT[],                -- {warm, balanced, challenging}
  cnip_homework TEXT[],              -- {yes, neutral, no}
  cnip_relational TEXT[]             -- {discuss, neutral, skip}
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

// 通用请求函数（含自动重试）
function _xpg_fetch(url, options, retries) {
  retries = retries || 1;
  return fetch(url, options).then(function(r) { return r; }).catch(function(e) {
    if (retries > 0) {
      console.warn('[小平菇] 请求失败，' + retries + '秒后重试:', url);
      return new Promise(function(resolve) { setTimeout(resolve, retries * 1000); })
        .then(function() { return _xpg_fetch(url, options, retries - 1); });
    }
    throw e;
  });
}

function getSupabaseHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_CONFIG.anonKey,
    'Authorization': 'Bearer ' + SUPABASE_CONFIG.anonKey,
    'Prefer': 'return=representation'
  };
}

// 写操作 header（不含 return=representation，避免 INSERT/PATCH 后 SELECT 被 RLS 拦截）
function getSupabaseWriteHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_CONFIG.anonKey,
    'Authorization': 'Bearer ' + SUPABASE_CONFIG.anonKey
  };
}

// 轻量 toast 通知（当页面无 showToast 时使用）
var _xpg_toast_timer = null;
function _xpg_toast(msg, type) {
  var el = document.getElementById('_xpg_toast_el');
  if (!el) {
    el = document.createElement('div');
    el.id = '_xpg_toast_el';
    el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999;padding:10px 20px;border-radius:10px;font-size:13px;color:#fff;opacity:0;transition:opacity 0.3s;pointer-events:none;max-width:90%;text-align:center';
    document.body.appendChild(el);
  }
  clearTimeout(_xpg_toast_timer);
  el.textContent = msg;
  el.style.background = type === 'error' ? '#E24B4A' : '#5C7A52';
  el.style.opacity = '1';
  _xpg_toast_timer = setTimeout(function() { el.style.opacity = '0'; }, 3500);
}

// 保存评估数据
function saveAssessment(data) {
  if (!SUPABASE_CONFIG.enableDataCollection || !SUPABASE_CONFIG.url) return Promise.resolve(null);
  return _xpg_fetch(SUPABASE_CONFIG.url + '/rest/v1/assessments', {
    method: 'POST',
    headers: getSupabaseHeaders(),
    body: JSON.stringify(data)
  }).then(function(r) {
    if (r.ok) { console.log('[小平菇] 评估数据已保存'); return r.json(); }
    else { console.warn('[小平菇] 保存失败:', r.status, r.statusText); (typeof showToast==='function'?showToast:_xpg_toast)('评估数据保存失败，请检查网络后重试','error'); return null; }
  }).catch(function(e) { console.warn('[小平菇] 网络错误:', e); (typeof showToast==='function'?showToast:_xpg_toast)('网络异常，评估数据未保存','error'); return null; });
}

// 保存咨询师档案（不含 return=representation，避免 pending 记录被 RLS 拦截）
function saveCounselor(data) {
  if (!SUPABASE_CONFIG.enableDataCollection || !SUPABASE_CONFIG.url) return Promise.resolve(data);
  return _xpg_fetch(SUPABASE_CONFIG.url + '/rest/v1/counselors', {
    method: 'POST',
    headers: getSupabaseWriteHeaders(),
    body: JSON.stringify(data)
  }).then(function(r) {
    if (r.ok) return data; // 返回输入数据，供调用方取 edit_token
    else throw new Error('HTTP ' + r.status);
  });
}

// 更新咨询师档案（不含 return=representation）
function updateCounselor(id, data) {
  if (!SUPABASE_CONFIG.enableDataCollection || !SUPABASE_CONFIG.url) return Promise.resolve();
  return _xpg_fetch(SUPABASE_CONFIG.url + '/rest/v1/counselors?id=eq.' + id, {
    method: 'PATCH',
    headers: getSupabaseWriteHeaders(),
    body: JSON.stringify({ ...data, updated_at: new Date().toISOString() })
  }).then(function(r) {
    if (r.ok) return true;
    else throw new Error('HTTP ' + r.status);
  }).catch(function(e) { console.warn('[小平菇] 更新失败:', e); (typeof showToast==='function'?showToast:_xpg_toast)('档案更新失败，请重试','error'); });
}

// 审核咨询师档案
function reviewCounselor(id, status, note, reviewer) {
  if (!SUPABASE_CONFIG.enableDataCollection || !SUPABASE_CONFIG.url) return Promise.resolve();
  return _xpg_fetch(SUPABASE_CONFIG.url + '/rest/v1/counselors?id=eq.' + id, {
    method: 'PATCH',
    headers: getSupabaseHeaders(),
    body: JSON.stringify({
      review_status: status,
      review_note: note || null,
      reviewed_at: new Date().toISOString(),
      reviewed_by: reviewer || 'admin',
      updated_at: new Date().toISOString()
    })
  }).then(function(r) {
    if (r.ok) return r.json();
    else throw new Error('HTTP ' + r.status);
  }).catch(function(e) { console.warn('[小平菇] 审核失败:', e); (typeof showToast==='function'?showToast:_xpg_toast)('审核操作失败','error'); });
}

// 按 view_token 获取评估记录（用于查看模式）
function getAssessmentByToken(token) {
  if (!SUPABASE_CONFIG.enableDataCollection || !SUPABASE_CONFIG.url) return Promise.resolve(null);
  return fetch(SUPABASE_CONFIG.url + '/rest/v1/assessments?view_token=eq.' + encodeURIComponent(token) + '&select=*', {
    headers: {
      'apikey': SUPABASE_CONFIG.anonKey,
      'Authorization': 'Bearer ' + SUPABASE_CONFIG.anonKey
    }
  }).then(function(r) { return r.json(); })
    .then(function(data) { return Array.isArray(data) && data.length > 0 ? data[0] : null; })
    .catch(function(e) { console.warn('[小平菇] 获取评估记录失败:', e); return null; });
}

// 按 edit_token 获取咨询师档案（用于编辑模式）
function getCounselorByToken(token) {
  if (!SUPABASE_CONFIG.enableDataCollection || !SUPABASE_CONFIG.url) return Promise.resolve(null);
  return fetch(SUPABASE_CONFIG.url + '/rest/v1/counselors?edit_token=eq.' + encodeURIComponent(token) + '&select=*', {
    headers: {
      'apikey': SUPABASE_CONFIG.anonKey,
      'Authorization': 'Bearer ' + SUPABASE_CONFIG.anonKey
    }
  }).then(function(r) { return r.json(); })
    .then(function(data) { return Array.isArray(data) && data.length > 0 ? data[0] : null; })
    .catch(function(e) { console.warn('[小平菇] 获取咨询师失败:', e); return null; });
}

// 匹配咨询师（核心匹配算法）
// 权重分配：议题30% + 取向20% + 程度15% + 城市10% + 门槛10% + 方式10% + 经济5% = 100%
function matchCounselors(assessment) {
  if (!SUPABASE_CONFIG.enableDataCollection || !SUPABASE_CONFIG.url) return Promise.resolve([]);

  return _xpg_fetch(SUPABASE_CONFIG.url + '/rest/v1/counselors?is_active=eq.true&review_status=eq.approved&select=*', {
    headers: getSupabaseHeaders()
  }).then(function(r) {
    if (!r.ok) { console.warn('[小平菇] 咨询师查询失败:', r.status); return []; }
    return r.json();
  })
  .then(function(counselors) {
    if (!Array.isArray(counselors)) return [];
    return counselors.map(function(c) {
      var score = 0;
      var details = [];

      // 1. 议题匹配 30%
      if (c.specialties && assessment.issues && assessment.issues.length > 0) {
        var overlap = assessment.issues.filter(function(i) {
          return c.specialties.indexOf(i) >= 0;
        });
        var issueScore = (overlap.length / assessment.issues.length) * 30;
        score += issueScore;
        if (overlap.length > 0) {
          details.push('议题匹配: ' + overlap.length + '/' + assessment.issues.length);
        }
      }

      // 2. 取向匹配 20%
      if (c.approaches && assessment.recommendedApproaches) {
        var approachMatch = assessment.recommendedApproaches.filter(function(a) {
          return c.approaches.indexOf(a) >= 0;
        });
        if (approachMatch.length > 0) {
          score += Math.min(20, approachMatch.length * 10);
          details.push('取向匹配: ' + approachMatch.join('/'));
        }
      }

      // 3. 程度承接 15%
      if (c.severity_levels) {
        var severityMap = { '轻度': 'mild', '中度': 'moderate', '重度': 'severe' };
        var clientLevel = severityMap[assessment.severity] || assessment.severity;
        var levelMap = { 'mild': '轻度', 'moderate': '中度', 'severe': '重度' };
        if (c.severity_levels.indexOf(levelMap[clientLevel]) >= 0 || c.severity_levels.indexOf(assessment.severity) >= 0) {
          score += 15;
          details.push('程度承接: 可承接' + assessment.severity);
        }
      }

      // 4. 门槛匹配 10%（核心硬性条件，不满足扣20分）
      var thresholdMet = true;
      if (assessment.minYears && c.years_experience < assessment.minYears) thresholdMet = false;
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
        score = Math.max(0, score - 20);
        details.push('门槛匹配: 部分不满足（排序靠后）');
      }

      // 5. 城市匹配 10%
      if (assessment.visitor_city && c.city) {
        var cityLower = assessment.visitor_city.toLowerCase();
        var cCityLower = c.city.toLowerCase();
        if (cCityLower.indexOf(cityLower) >= 0 || cityLower.indexOf(cCityLower) >= 0) {
          score += 10;
          details.push('城市匹配: ' + c.city);
        }
      }

      // 6. 咨询方式匹配 10%
      if (assessment.visitor_formats && assessment.visitor_formats.length > 0 && c.session_formats) {
        var formatOverlap = assessment.visitor_formats.filter(function(f) {
          return c.session_formats.indexOf(f) >= 0;
        });
        if (formatOverlap.length > 0) {
          score += 10;
          details.push('方式匹配: ' + formatOverlap.join('/'));
        }
      }

      // 7. 经济匹配 5%
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

      // 8. 性别偏好匹配 5%
      if (assessment.gender_pref && c.gender) {
        var gpMap = { 'male': 'male', 'female': 'female' };
        if (gpMap[assessment.gender_pref] === c.gender) {
          score += 5;
          details.push('性别偏好: 符合');
        }
        // 来访者要求不限(any)时，任何性别都加分（但已在gender_pref=''时不触发）
      }

      // 9. 咨询师性别偏好与来访者匹配 3%
      if (c.client_gender_pref) {
        var visitorGender = assessment.visitor_gender || '';
        var genderMatchOk = true;
        if (c.client_gender_pref === 'male_only' && visitorGender !== '男' && visitorGender !== 'male') genderMatchOk = false;
        if (c.client_gender_pref === 'female_only' && visitorGender !== '女' && visitorGender !== 'female') genderMatchOk = false;
        if (genderMatchOk && c.client_gender_pref !== '') {
          score += 3;
          details.push('咨询师偏好: 符合');
        }
      }

      // 10. 年龄偏好匹配 5%
      if (assessment.age_pref && c.years_experience) {
        var agePref = assessment.age_pref;
        if (agePref === 'older' && c.years_experience >= 10) {
          score += 5;
          details.push('年龄偏好: 资深咨询师');
        } else if (agePref === 'younger' && c.years_experience <= 5) {
          score += 5;
          details.push('年龄偏好: 新锐咨询师');
        } else if (agePref === 'peer' && c.years_experience >= 3 && c.years_experience <= 10) {
          score += 5;
          details.push('年龄偏好: 同龄相仿');
        }
      }

      // 11. 来访者年龄段与咨询师偏好匹配 3%
      if (c.client_age_prefs && c.client_age_prefs.length > 0 && assessment.visitor_age) {
        var age = parseInt(assessment.visitor_age);
        if (age) {
          var ageGroupMatch = false;
          c.client_age_prefs.forEach(function(g) {
            if (g.indexOf('6-12') >= 0 && age >= 6 && age <= 12) ageGroupMatch = true;
            if (g.indexOf('12-18') >= 0 && age >= 12 && age <= 18) ageGroupMatch = true;
            if (g.indexOf('18-35') >= 0 && age >= 18 && age <= 35) ageGroupMatch = true;
            if (g.indexOf('35-55') >= 0 && age >= 35 && age <= 55) ageGroupMatch = true;
            if (g.indexOf('55+') >= 0 && age >= 55) ageGroupMatch = true;
          });
          if (ageGroupMatch) {
            score += 3;
            details.push('年龄阶段: 在偏好范围内');
          }
        }
      }

      // 12. 性取向友善匹配 5%
      if (assessment.orientation_pref && c.orientation_friendly) {
        if (assessment.orientation_pref === 'friendly' && c.orientation_friendly.length > 0) {
          score += 5;
          details.push('LGBTQ+友善: 具备友好能力');
        } else if (assessment.orientation_pref === 'experienced') {
          // 需要性少数经验：检查是否有具体性取向友好标记
          var hasSpecific = c.orientation_friendly.filter(function(v) {
            return v !== '异性恋';
          }).length > 0;
          if (hasSpecific) {
            score += 5;
            details.push('LGBTQ+经验: 具备性少数相关经验');
          }
        }
      }

      // 沟通风格匹配（+5分）
      if (assessment.comm_style && c.comm_styles && c.comm_styles.length > 0) {
        var commMap = {
          'talkative': 'listening',
          'guided': 'guided',
          'shy': 'leading',
          'collaborative': 'collaborative',
          'directive': 'directive'
        };
        var matchedStyle = commMap[assessment.comm_style];
        if (matchedStyle && c.comm_styles.indexOf(matchedStyle) >= 0) {
          score += 5;
          details.push('沟通风格: 匹配');
        }
      }

      // ===== C-NIP 咨询风格匹配（6维度，共+20分） =====
      var cnip = assessment.cnip || {};
      var cnipScore = 0;
      var cnipDetails = [];

      // 咨询结构（+4分）：来访者偏好与咨询师提供匹配
      if (cnip.cnip_structure && c.cnip_styles && c.cnip_styles.length > 0) {
        if (c.cnip_styles.indexOf(cnip.cnip_structure) >= 0) {
          cnipScore += 4;
        } else if (c.cnip_styles.indexOf('balanced') >= 0 && cnip.cnip_structure !== 'balanced') {
          cnipScore += 2; // 咨询师有 balanced，兼容大部分来访者
        }
      }

      // 情感深度（+4分）
      if (cnip.cnip_emotion && c.cnip_emotion_focus && c.cnip_emotion_focus.length > 0) {
        if (c.cnip_emotion_focus.indexOf(cnip.cnip_emotion) >= 0) {
          cnipScore += 4;
        } else if (c.cnip_emotion_focus.indexOf('balanced') >= 0 && cnip.cnip_emotion !== 'balanced') {
          cnipScore += 2;
        }
      }

      // 时间取向（+3分）
      if (cnip.cnip_timefocus && c.cnip_time && c.cnip_time.length > 0) {
        if (c.cnip_time.indexOf(cnip.cnip_timefocus) >= 0) {
          cnipScore += 3;
        } else if (c.cnip_time.indexOf('balanced') >= 0 && cnip.cnip_timefocus !== 'balanced') {
          cnipScore += 1;
        }
      }

      // 咨询师立场（+3分）
      if (cnip.cnip_warmth && c.cnip_stance && c.cnip_stance.length > 0) {
        if (c.cnip_stance.indexOf(cnip.cnip_warmth) >= 0) {
          cnipScore += 3;
        } else if (c.cnip_stance.indexOf('balanced') >= 0 && cnip.cnip_warmth !== 'balanced') {
          cnipScore += 1;
        }
      }

      // 课后作业（+3分）
      if (cnip.cnip_homework && c.cnip_homework && c.cnip_homework.length > 0) {
        if (c.cnip_homework.indexOf(cnip.cnip_homework) >= 0) {
          cnipScore += 3;
        }
      }

      // 咨访关系讨论（+3分）
      if (cnip.cnip_relational && c.cnip_relational && c.cnip_relational.length > 0) {
        if (c.cnip_relational.indexOf(cnip.cnip_relational) >= 0) {
          cnipScore += 3;
        }
      }

      if (cnipScore > 0) {
        score += Math.min(20, cnipScore);
        details.push('咨询风格: +' + cnipScore + '分');
      }

      // 14. 未成年人优先（家长代填时，只保留擅长儿童青少年的咨询师）
      // 注意：这不是加分，而是排序优先——在最终排序时给未成年人专长咨询师加权

      return {
        counselor: c,
        matchScore: Math.min(145, Math.round(score)),
        matchDetails: details
      };
    })
    .filter(function(item) { return item.matchScore > 0; })
    .sort(function(a, b) {
      // 家长代填 + 未成年人：擅长儿童青少年的咨询师排序优先
      if (assessment.filled_by === 'parent' && assessment.is_minor) {
        var aYouth = a.counselor.client_age_prefs && a.counselor.client_age_prefs.some(function(g) { return g.indexOf('6-12') >= 0 || g.indexOf('12-18') >= 0; });
        var bYouth = b.counselor.client_age_prefs && b.counselor.client_age_prefs.some(function(g) { return g.indexOf('6-12') >= 0 || g.indexOf('12-18') >= 0; });
        if (aYouth && !bYouth) return -1;
        if (!aYouth && bYouth) return 1;
      }
      return b.matchScore - a.matchScore;
    });
  })
  .catch(function(e) {
    console.warn('[小平菇] 匹配查询失败:', e);
    return [];
  });
}

// ========== PCOMS 循证追踪 ==========

// 创建会话
function createSession(data) {
  if (!SUPABASE_CONFIG.enableDataCollection || !SUPABASE_CONFIG.url) return Promise.resolve(null);
  return _xpg_fetch(SUPABASE_CONFIG.url + '/rest/v1/sessions', {
    method: 'POST',
    headers: getSupabaseHeaders(),
    body: JSON.stringify(data)
  }).then(function(r) {
    if (r.ok) return r.json();
    else throw new Error('HTTP ' + r.status);
  }).then(function(data) { return data[0] || null; })
    .catch(function(e) { console.warn('[小平菇] 创建会话失败:', e); (typeof showToast==='function'?showToast:_xpg_toast)('会话创建失败，评分可能未保存','error'); return null; });
}

// 保存 PCOMS 评分（ORS 或 SRS）
function savePcomsRating(data) {
  if (!SUPABASE_CONFIG.enableDataCollection || !SUPABASE_CONFIG.url) return Promise.resolve(null);
  return _xpg_fetch(SUPABASE_CONFIG.url + '/rest/v1/pcoms_ratings', {
    method: 'POST',
    headers: getSupabaseHeaders(),
    body: JSON.stringify(data)
  }).then(function(r) {
    if (r.ok) return r.json();
    else throw new Error('HTTP ' + r.status);
  }).then(function(data) { return data[0] || null; })
    .catch(function(e) { console.warn('[小平菇] 保存PCOMS评分失败:', e); (typeof showToast==='function'?showToast:_xpg_toast)('评分保存失败，请重试','error'); return null; });
}

// 获取某次评估的所有会话
function getSessionsByAssessment(assessmentId) {
  if (!SUPABASE_CONFIG.enableDataCollection || !SUPABASE_CONFIG.url) return Promise.resolve([]);
  return fetch(SUPABASE_CONFIG.url + '/rest/v1/sessions?assessment_id=eq.' + assessmentId + '&select=*&order=session_number.asc', {
    headers: {
      'apikey': SUPABASE_CONFIG.anonKey,
      'Authorization': 'Bearer ' + SUPABASE_CONFIG.anonKey
    }
  }).then(function(r) { return r.json(); })
    .then(function(data) { return Array.isArray(data) ? data : []; })
    .catch(function(e) { console.warn('[小平菇] 获取会话列表失败:', e); return []; });
}

// 获取某次会话的所有 PCOMS 评分
function getPcomsRatingsBySession(sessionId) {
  if (!SUPABASE_CONFIG.enableDataCollection || !SUPABASE_CONFIG.url) return Promise.resolve([]);
  return fetch(SUPABASE_CONFIG.url + '/rest/v1/pcoms_ratings?session_id=eq.' + sessionId + '&select=*&order=created_at.asc', {
    headers: {
      'apikey': SUPABASE_CONFIG.anonKey,
      'Authorization': 'Bearer ' + SUPABASE_CONFIG.anonKey
    }
  }).then(function(r) { return r.json(); })
    .then(function(data) { return Array.isArray(data) ? data : []; })
    .catch(function(e) { console.warn('[小平菇] 获取PCOMS评分失败:', e); return []; });
}

// 获取某次评估的所有 PCOMS 评分（含会话信息，用于趋势分析）
function getPcomsTrend(assessmentId) {
  if (!SUPABASE_CONFIG.enableDataCollection || !SUPABASE_CONFIG.url) return Promise.resolve([]);
  // 两步查询：先获取该评估的所有 session ID，再查询 ratings（避免嵌套子查询不兼容）
  return getSessionsByAssessment(assessmentId).then(function(sessions) {
    if (!sessions || sessions.length === 0) return [];
    var ids = sessions.map(function(s) { return s.id; }).join(',');
    return fetch(SUPABASE_CONFIG.url + '/rest/v1/pcoms_ratings?session_id=in.(' + ids + ')&select=session_id,type,item_individual,item_interpersonal,item_social,item_overall,total_score,clinical_change,created_at&order=created_at.asc', {
      headers: {
        'apikey': SUPABASE_CONFIG.anonKey,
        'Authorization': 'Bearer ' + SUPABASE_CONFIG.anonKey
      }
    }).then(function(r) { return r.json(); })
    .then(function(data) { return Array.isArray(data) ? data : []; });
  }).catch(function(e) { console.warn('[小平菇] 获取PCOMS趋势失败:', e); return []; });
}

/*
-- PCOMS 循证追踪表结构（migration-add-pcoms-tables.sql）
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id UUID REFERENCES assessments(id) ON DELETE SET NULL,
  counselor_id UUID REFERENCES counselors(id) ON DELETE SET NULL,
  visitor_name TEXT,
  session_number INTEGER DEFAULT 1,
  session_date DATE DEFAULT CURRENT_DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE pcoms_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('ORS', 'SRS')),
  item_individual REAL NOT NULL CHECK (item_individual >= 0 AND item_individual <= 10),
  item_interpersonal REAL NOT NULL CHECK (item_interpersonal >= 0 AND item_interpersonal <= 10),
  item_social REAL NOT NULL CHECK (item_social >= 0 AND item_social <= 10),
  item_overall REAL NOT NULL CHECK (item_overall >= 0 AND item_overall <= 10),
  total_score REAL NOT NULL GENERATED ALWAYS AS (item_individual + item_interpersonal + item_social + item_overall) STORED,
  clinical_change TEXT CHECK (clinical_change IN ('improved', 'no_change', 'worsening')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
*/
