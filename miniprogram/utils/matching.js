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

function scoreCounselor(assessment, counselor) {
  const issues = assessment.issues || [];
  const approaches = recommendedApproaches(issues);
  let score = 0;
  const details = [];
  const specialties = counselor.specialties || [];
  const overlap = issues.filter((i) => specialties.includes(i));
  if (issues.length && overlap.length) {
    score += Math.round(overlap.length / issues.length * 40);
    details.push(`议题匹配 ${overlap.length}/${issues.length}`);
  }
  const approachOverlap = approaches.filter((a) => (counselor.approaches || []).includes(a));
  if (approachOverlap.length) {
    score += Math.min(30, approachOverlap.length * 15);
    details.push(approachOverlap.join('/'));
  }
  if ((counselor.severity_levels || []).includes(assessment.severity)) {
    score += 15;
    details.push('承接程度匹配');
  }
  if (assessment.budget && counselor.fee_budget_level === assessment.budget) {
    score += 10;
    details.push('预算匹配');
  }
  if (assessment.visitor_city && counselor.city && counselor.city.indexOf(assessment.visitor_city) >= 0) {
    score += 5;
    details.push('同城');
  }
  return { score, details };
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
  }).sort((a, b) => b.matchScore - a.matchScore).slice(0, limit);
}

module.exports = {
  recommendedApproaches,
  buildReferralAdvice,
  buildCounselorMatches
};
