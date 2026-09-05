const config = require('./config');

const fallbackDemoCounselors = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    name: '本地演示咨询师',
    credential_level: '二级',
    years_experience: 8,
    education: '硕士',
    city: '上海',
    approaches: ['CBT', 'ACT'],
    service_settings: ['个体咨询'],
    specialties: ['emotion', 'relationship'],
    populations: ['成人', '青少年'],
    severity_levels: ['轻度', '中度'],
    session_formats: ['视频咨询', '线下面询'],
    fee_min: 400,
    fee_budget_level: 'mid',
    bio_short: '本地演示账号使用的咨询师档案',
    is_active: true,
    review_status: 'approved'
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    name: '调试咨询师',
    credential_level: '心理治疗师',
    years_experience: 12,
    education: '博士',
    city: '杭州',
    approaches: ['家庭治疗', 'EFT', 'CBT', 'DBT'],
    service_settings: ['个体咨询', '家庭咨询'],
    specialties: ['relationship', 'marriage', 'family', 'adolescent', 'crisis'],
    populations: ['成人', '青少年', '家庭'],
    severity_levels: ['轻度', '中度', '重度'],
    session_formats: ['视频咨询', '线下面询'],
    fee_min: 600,
    fee_budget_level: 'high',
    bio_short: '用于展示推荐咨询师排序、危机风险承接和家庭系统方向。',
    is_active: true,
    review_status: 'approved'
  }
];

function uniq(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function recommendedApproaches(issues) {
  const out = [];
  if (issues.includes('personality') || issues.includes('crisis')) out.push('DBT', '精神动力学');
  if (issues.includes('trauma')) out.push('EMDR', 'CBT');
  if (issues.includes('relationship') || issues.includes('marriage') || issues.includes('family')) out.push('家庭治疗', 'EFT');
  if (issues.includes('emotion') || issues.includes('workplace') || issues.includes('somatic') || issues.includes('sexual')) out.push('CBT', 'ACT');
  if (issues.includes('adolescent')) out.push('家庭治疗', 'CBT');
  if (issues.includes('eating') || issues.includes('addiction')) out.push('CBT', 'DBT');
  if (issues.includes('growth') || issues.includes('grief')) out.push('人本主义');
  return Array.from(new Set(out.length ? out : ['CBT']));
}

function buildReferralAdvice(assessment) {
  const issues = assessment.issues || [];
  const specials = assessment.specials || [];
  const crisis = assessment.crisis_level || 'safe';
  const total = Number(assessment.total_score || 0);
  const cards = [];
  let minYears = 1;
  let minCredential = '';
  const approaches = [];
  const addApproaches = (items) => items.forEach((item) => {
    if (!approaches.includes(item)) approaches.push(item);
  });
  const add = (card) => {
    cards.push({
      ...card,
      tags: card.tags || [],
      require: card.require || []
    });
    if (card.approaches) addApproaches(card.approaches);
    if (card.minYears) minYears = Math.max(minYears, card.minYears);
    if (card.minCredential) minCredential = card.minCredential;
  };

  if (crisis === 'active' || crisis === 'action') {
    add({
      top: true,
      badge: '紧急转介',
      tone: 'red',
      title: '立即转介：危机干预专业机构',
      desc: '当前存在自伤/自杀风险，普通心理咨询不适用。建议立即联系危机干预机构或精神科急诊。',
      tags: ['危机干预资质', '注册心理师', '精神科联动', '安全评估'],
      require: ['从业年限：8年+', '危机干预专项培训', '精神科医疗团队协作'],
      approaches: ['DBT'],
      minYears: 8,
      minCredential: '注册心理师'
    });
  } else if (crisis === 'passive') {
    add({
      top: true,
      badge: '优先处理',
      tone: 'amber',
      title: '优先安排：有危机倾向的支持性咨询',
      desc: '存在消极念头，需优先安排具备危机风险评估能力的咨询师。',
      tags: ['DBT取向', '危机风险评估', '安全计划制定'],
      require: ['从业年限：5年+', '危机评估培训', 'DBT/CBT取向优先'],
      approaches: ['DBT', 'CBT'],
      minYears: 5
    });
  }

  if (specials.includes('diagnosed') || specials.includes('medication') || issues.includes('personality')) {
    add({
      top: !cards.length,
      badge: '医心联动',
      tone: 'amber',
      title: '建议：精神科-咨询联合模式',
      desc: '存在精神科诊断或人格成长/发展性议题，建议采用联合工作模式。',
      tags: ['DBT取向', '精神动力学', '精神科协作', '长程咨询'],
      require: ['从业年限：8年+', '注册心理师级别', '需与精神科协作'],
      approaches: ['DBT', '精神动力学'],
      minYears: 8,
      minCredential: '注册心理师'
    });
  }
  if (issues.includes('relationship') || issues.includes('marriage')) {
    add({
      top: !cards.length,
      badge: '推荐',
      tone: 'green',
      title: '推荐取向：关系/婚姻咨询',
      desc: '关系类议题推荐具备家庭治疗培训背景的咨询师。',
      tags: ['家庭治疗取向', 'EFT婚姻治疗', '系统式治疗'],
      require: ['从业年限：3年+', '家庭/婚姻咨询专项培训'],
      approaches: ['家庭治疗', 'EFT'],
      minYears: 3
    });
  }
  if (issues.includes('adolescent') || /中小学|青少年|学生/.test(assessment.visitor_occupation || '')) {
    add({
      top: !cards.length,
      badge: '推荐',
      tone: 'green',
      title: '推荐取向：青少年专项咨询',
      desc: '青少年问题推荐具备儿童青少年专项培训的咨询师。',
      tags: ['青少年专项', '家庭治疗', 'CBT取向'],
      require: ['从业年限：3年+', '青少年/儿童专项培训'],
      approaches: ['家庭治疗', 'CBT'],
      minYears: 3
    });
  }
  if (issues.includes('emotion') || Number(assessment.score_mood || 0) >= 3 || Number(assessment.score_anxiety || 0) >= 3) {
    add({
      top: !cards.length,
      badge: total >= 15 ? '建议优先' : '推荐',
      tone: total >= 15 ? 'amber' : 'green',
      title: '推荐取向：CBT / ACT 认知行为疗法',
      desc: '情绪困扰首选循证证据较充分的认知行为疗法。',
      tags: ['CBT取向', 'ACT取向', '短程结构化', '循证支持'],
      require: ['从业年限：1年+', '二级咨询师及以上', total >= 15 ? '建议先精神科评估' : '无特殊限制'],
      approaches: ['CBT', 'ACT']
    });
  }
  if (issues.includes('family')) {
    add({
      top: !cards.length,
      badge: '推荐',
      tone: 'green',
      title: '推荐取向：家庭系统治疗',
      desc: '家庭系统议题推荐具备家庭治疗培训背景的咨询师。',
      tags: ['家庭治疗取向', '系统式治疗', '鲍恩家庭系统'],
      require: ['从业年限：5年+', '家庭治疗专项培训', '建议家庭成员参与'],
      approaches: ['家庭治疗'],
      minYears: 5
    });
  }
  if (issues.includes('workplace')) {
    add({
      top: !cards.length,
      badge: '推荐',
      tone: 'green',
      title: '推荐取向：EAP / 组织心理学方向',
      desc: '职场困扰推荐具备 EAP 或组织心理学背景的咨询师。',
      tags: ['EAP经验', 'CBT取向', '职业规划'],
      require: ['从业年限：3年+', 'EAP或企业心理服务经验'],
      approaches: ['CBT'],
      minYears: 3
    });
  }
  if (issues.includes('growth') || (!issues.length && !cards.length)) {
    add({
      top: !cards.length,
      badge: '推荐',
      tone: 'green',
      title: '推荐取向：人本主义 / 存在主义咨询',
      desc: '自我成长类议题适合人本主义或存在主义取向。',
      tags: ['人本主义', '存在主义', '来访者中心', '中长程'],
      require: ['从业年限：1年+', '二/三级咨询师均可', '无特殊限制'],
      approaches: ['人本主义']
    });
  }

  if (!cards.length) {
    add({
      top: true,
      badge: '通用推荐',
      tone: 'green',
      title: '推荐进行初始评估咨询',
      desc: '建议先预约 1-2 次初始评估。',
      tags: ['初始评估', '1-2次探索'],
      require: ['从业年限：2年+', '二级咨询师及以上'],
      approaches: ['CBT'],
      minYears: 2
    });
  }

  return {
    cards: cards.slice(0, 3).map((card) => ({
      ...card,
      tag_text: card.tags.join(' · '),
      require_text: card.require.join(' · ')
    })),
    recommendedApproaches: uniq(approaches.length ? approaches : recommendedApproaches(issues)),
    minYears,
    minCredential
  };
}

function feeText(level, fee) {
  const map = {
    low: '300元以内',
    mid: '300-600元',
    high: '600-1000元',
    premium: '1000元以上'
  };
  return fee ? `${fee}元/次` : (map[level] || '费用待确认');
}

function getLocalDemoCounselorIds() {
  if (Array.isArray(config.localDemoCounselorIds) && config.localDemoCounselorIds.length) {
    return config.localDemoCounselorIds;
  }
  return config.localDemoCounselorId ? [config.localDemoCounselorId] : [];
}

// ===== 匹配算法 v2.0：3项硬性过滤 + 11维度100分制（与Web端统一）=====
// 硬性过滤：门槛匹配 / 严重程度承接 / 性取向友善
// 计分：议题22 + C-NIP风格18 + 取向14 + 城市12 + 方式8 + 沟通7 +
//       经济6 + 性别5 + 年龄4 + 年龄段2 + 咨询师性别偏好2 = 100
// 阈值：高匹配 ≥70 / 中匹配 ≥45

var _credRank = { '三级': 1, '二级': 2, '心理治疗师': 3, '社会工作师（初级）': 1, '社会工作师（中级）': 2, '社会工作师（高级）': 3, '精神科医生': 4, '注册心理师': 3, '督导师': 4 };
var _severityMap = { '轻度': 'mild', '中度': 'moderate', '重度': 'severe' };
var _levelMap = { 'mild': '轻度', 'moderate': '中度', 'severe': '重度' };
var _budgetRank = { 'low': 1, 'mid': 2, 'high': 3, 'premium': 4 };
var _commMap = { 'talkative': 'listening', 'guided': 'guided', 'shy': 'leading', 'collaborative': 'collaborative', 'directive': 'directive' };

function scoreCounselor(assessment, counselor) {
  var issues = assessment.issues || [];
  var approaches = recommendedApproaches(issues);
  var score = 0;
  var details = [];
  var c = counselor;

  // ===== 硬性过滤层（不达标 = 直接排除）=====

  // F1. 门槛匹配
  if (assessment.minYears && c.years_experience < assessment.minYears) {
    return { score: 0, details: ['硬性过滤: 从业年限不足'], filtered: true };
  }
  if (assessment.minCredential) {
    if ((_credRank[c.credential_level] || 0) < (_credRank[assessment.minCredential] || 0)) {
      return { score: 0, details: ['硬性过滤: 资质等级不足'], filtered: true };
    }
  }

  // F2. 严重程度承接
  if (assessment.severity && c.severity_levels && c.severity_levels.length > 0) {
    var clientLevel = _severityMap[assessment.severity] || assessment.severity;
    if (c.severity_levels.indexOf(_levelMap[clientLevel]) < 0 && c.severity_levels.indexOf(assessment.severity) < 0) {
      return { score: 0, details: ['硬性过滤: 无法承接' + assessment.severity + '程度'], filtered: true };
    }
  }

  // F3. 性取向友善
  if (assessment.orientation_pref && assessment.orientation_pref !== 'any' && assessment.orientation_pref !== '') {
    if (!c.orientation_friendly || c.orientation_friendly.length === 0) {
      return { score: 0, details: ['硬性过滤: 缺少LGBTQ+友善标记'], filtered: true };
    }
    if (assessment.orientation_pref === 'experienced') {
      var hasSpecific = (c.orientation_friendly || []).filter(function(v) { return v !== '异性恋'; }).length > 0;
      if (!hasSpecific) {
        return { score: 0, details: ['硬性过滤: 缺少性少数专项经验'], filtered: true };
      }
    }
  }

  // ===== 计分排序层（11维度，满分100）=====

  // 1. 议题匹配（22分）
  var specialties = c.specialties || [];
  if (issues.length > 0) {
    var overlap = issues.filter(function(i) { return specialties.indexOf(i) >= 0; });
    if (overlap.length > 0) {
      score += Math.round((overlap.length / issues.length) * 22);
      details.push('议题匹配: ' + overlap.length + '/' + issues.length);
    }
  }

  // 2. C-NIP 咨询风格匹配（18分）
  var cnip = assessment.cnip || {};
  var cnipScore = 0;
  if (cnip.cnip_structure && c.cnip_styles && c.cnip_styles.length > 0) {
    if (c.cnip_styles.indexOf(cnip.cnip_structure) >= 0) cnipScore += 4;
    else if (c.cnip_styles.indexOf('balanced') >= 0 && cnip.cnip_structure !== 'balanced') cnipScore += 2;
  }
  if (cnip.cnip_emotion && c.cnip_emotion_focus && c.cnip_emotion_focus.length > 0) {
    if (c.cnip_emotion_focus.indexOf(cnip.cnip_emotion) >= 0) cnipScore += 4;
    else if (c.cnip_emotion_focus.indexOf('balanced') >= 0 && cnip.cnip_emotion !== 'balanced') cnipScore += 2;
  }
  if (cnip.cnip_timefocus && c.cnip_time && c.cnip_time.length > 0) {
    if (c.cnip_time.indexOf(cnip.cnip_timefocus) >= 0) cnipScore += 3;
    else if (c.cnip_time.indexOf('balanced') >= 0 && cnip.cnip_timefocus !== 'balanced') cnipScore += 1;
  }
  if (cnip.cnip_warmth && c.cnip_stance && c.cnip_stance.length > 0) {
    if (c.cnip_stance.indexOf(cnip.cnip_warmth) >= 0) cnipScore += 3;
    else if (c.cnip_stance.indexOf('balanced') >= 0 && cnip.cnip_warmth !== 'balanced') cnipScore += 1;
  }
  if (cnip.cnip_homework && c.cnip_homework && c.cnip_homework.length > 0) {
    if (c.cnip_homework.indexOf(cnip.cnip_homework) >= 0) cnipScore += 2;
  }
  if (cnip.cnip_relational && c.cnip_relational && c.cnip_relational.length > 0) {
    if (c.cnip_relational.indexOf(cnip.cnip_relational) >= 0) cnipScore += 2;
  }
  if (cnipScore > 0) {
    score += Math.min(18, cnipScore);
    details.push('C-NIP风格: +' + cnipScore + '分');
  }

  // 3. 取向匹配（14分）
  var counselorApproaches = c.approaches || [];
  var approachOverlap = approaches.filter(function(a) { return counselorApproaches.indexOf(a) >= 0; });
  if (approachOverlap.length > 0) {
    score += Math.min(14, approachOverlap.length * 7);
    details.push('取向匹配: ' + approachOverlap.join('/'));
  }

  // 4. 城市匹配（12分）
  if (assessment.visitor_city && c.city) {
    var cityLower = String(assessment.visitor_city).toLowerCase();
    var cCityLower = String(c.city).toLowerCase();
    if (cCityLower.indexOf(cityLower) >= 0 || cityLower.indexOf(cCityLower) >= 0) {
      score += 12;
      details.push('同城: ' + c.city);
    }
  }

  // 5. 咨询方式匹配（8分）
  if (assessment.visitor_formats && assessment.visitor_formats.length > 0 && c.session_formats) {
    var formatOverlap = assessment.visitor_formats.filter(function(f) { return c.session_formats.indexOf(f) >= 0; });
    if (formatOverlap.length > 0) {
      score += 8;
      details.push('方式匹配: ' + formatOverlap.join('/'));
    }
  }

  // 6. 沟通风格匹配（7分）
  if (assessment.comm_style && c.comm_styles && c.comm_styles.length > 0) {
    var matchedStyle = _commMap[assessment.comm_style];
    if (matchedStyle && c.comm_styles.indexOf(matchedStyle) >= 0) {
      score += 7;
      details.push('沟通风格: 匹配');
    }
  }

  // 7. 经济匹配（6分）
  if (assessment.budget && c.fee_budget_level) {
    var clientRank = _budgetRank[assessment.budget] || 0;
    var counselorRank = _budgetRank[c.fee_budget_level] || 0;
    if (clientRank > 0 && counselorRank > 0) {
      if (counselorRank <= clientRank) {
        score += 6;
        details.push('经济匹配: 费用在可承受范围内');
      } else if (counselorRank === clientRank + 1) {
        score += 3;
        details.push('经济匹配: 费用略高于预期');
      }
    }
  }

  // 8. 性别偏好匹配（5分）
  if (assessment.gender_pref && c.gender) {
    var gpMap = { 'male': 'male', 'female': 'female' };
    if (gpMap[assessment.gender_pref] === c.gender) {
      score += 5;
      details.push('性别偏好: 符合');
    }
  }

  // 9. 年龄偏好匹配（4分）
  if (assessment.age_pref && c.years_experience) {
    var agePref = assessment.age_pref;
    if (agePref === 'older' && c.years_experience >= 10) {
      score += 4; details.push('年龄偏好: 资深咨询师');
    } else if (agePref === 'younger' && c.years_experience <= 5) {
      score += 4; details.push('年龄偏好: 新锐咨询师');
    } else if (agePref === 'peer' && c.years_experience >= 3 && c.years_experience <= 10) {
      score += 4; details.push('年龄偏好: 同龄相仿');
    }
  }

  // 10. 来访者年龄段与咨询师偏好匹配（2分）
  if (c.client_age_prefs && c.client_age_prefs.length > 0 && assessment.visitor_age) {
    var age = parseInt(assessment.visitor_age);
    if (age) {
      var ageGroupMatch = false;
      (c.client_age_prefs || []).forEach(function(g) {
        if (g.indexOf('6-12') >= 0 && age >= 6 && age <= 12) ageGroupMatch = true;
        if (g.indexOf('12-18') >= 0 && age >= 12 && age <= 18) ageGroupMatch = true;
        if (g.indexOf('18-35') >= 0 && age >= 18 && age <= 35) ageGroupMatch = true;
        if (g.indexOf('35-55') >= 0 && age >= 35 && age <= 55) ageGroupMatch = true;
        if (g.indexOf('55+') >= 0 && age >= 55) ageGroupMatch = true;
      });
      if (ageGroupMatch) {
        score += 2;
        details.push('年龄阶段: 在偏好范围内');
      }
    }
  }

  // 11. 咨询师性别偏好与来访者匹配（2分）
  if (c.client_gender_pref) {
    var visitorGender = assessment.visitor_gender || '';
    var genderMatchOk = true;
    if (c.client_gender_pref === 'male_only' && visitorGender !== '男' && visitorGender !== 'male') genderMatchOk = false;
    if (c.client_gender_pref === 'female_only' && visitorGender !== '女' && visitorGender !== 'female') genderMatchOk = false;
    if (genderMatchOk && c.client_gender_pref !== '') {
      score += 2;
      details.push('咨询师偏好: 符合');
    }
  }

  return { score: Math.min(100, score), details: details };
}

function buildCounselorMatches(assessment, counselors, limit = 2) {
  const demoIds = getLocalDemoCounselorIds();
  const byId = {};
  (counselors || []).concat(fallbackDemoCounselors).forEach((c) => {
    if (c && c.id && !byId[c.id]) byId[c.id] = c;
  });
  const source = Object.values(byId).filter((c) => {
    if (!c || !c.id) return false;
    if (demoIds.length) return demoIds.includes(c.id);
    return c.is_active !== false && c.review_status === 'approved';
  });

  return source.map((counselor) => {
    const scored = scoreCounselor(assessment, counselor);
    // 被硬性过滤的咨询师不参与推荐
    if (scored.filtered) {
      return null;
    }
    const matchScore = Math.min(100, scored.score || (demoIds.includes(counselor.id) ? 35 : 0));
    return {
      ...counselor,
      matchScore,
      matchDetails: scored.details,
      match_details_text: scored.details.length ? scored.details.join(' · ') : '本地演示推荐',
      fee_text: feeText(counselor.fee_budget_level, counselor.fee_min),
      first_format: (counselor.session_formats || [])[0] || '咨询方式待确认',
      meta_text: [counselor.credential_level, counselor.city, counselor.years_experience ? `${counselor.years_experience}年经验` : ''].filter(Boolean).join(' · ')
    };
  }).filter(function(item) { return item !== null && item.matchScore > 0; })
    .sort((a, b) => {
      // 未成年人优先排序
      if (assessment.filled_by === 'parent' && assessment.is_minor) {
        var aYouth = (a.client_age_prefs || []).some(function(g) { return g.indexOf('6-12') >= 0 || g.indexOf('12-18') >= 0; });
        var bYouth = (b.client_age_prefs || []).some(function(g) { return g.indexOf('6-12') >= 0 || g.indexOf('12-18') >= 0; });
        if (aYouth && !bYouth) return -1;
        if (!aYouth && bYouth) return 1;
      }
      return b.matchScore - a.matchScore;
    }).slice(0, limit);
}

module.exports = {
  recommendedApproaches,
  buildReferralAdvice,
  buildCounselorMatches
};
