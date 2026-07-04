const { createAssessment, listApprovedCounselors, updateAssessment } = require('../../utils/api');
const config = require('../../utils/config');

const issueOptionsSeed = [
  ['emotion', '情绪困扰'],
  ['relationship', '关系困境'],
  ['trauma', '创伤经历'],
  ['growth', '自我成长'],
  ['adolescent', '青少年问题'],
  ['marriage', '婚姻伴侣'],
  ['personality', '人格成长/发展性议题'],
  ['crisis', '危机状态'],
  ['workplace', '职场困扰'],
  ['eating', '进食障碍'],
  ['addiction', '成瘾行为'],
  ['grief', '丧亲哀伤'],
  ['sexual', '性心理议题'],
  ['somatic', '心身困扰'],
  ['family', '家庭系统']
];

const formatOptionsSeed = [
  ['线下面询', '线下面询'],
  ['视频咨询', '视频咨询'],
  ['语音咨询', '语音咨询'],
  ['文字咨询', '文字咨询']
];

const expectOptionsSeed = [
  ['understand', '了解自己'],
  ['solve', '解决问题'],
  ['support', '情感支持'],
  ['relationship_improve', '改善关系'],
  ['emotion_manage', '情绪管理'],
  ['career_develop', '职业发展'],
  ['crisis', '危机处理']
];

const specialOptionsSeed = [
  ['medication', '目前正在服用精神类药物'],
  ['diagnosed', '已有精神科诊断'],
  ['substance', '存在物质滥用/成瘾'],
  ['medical', '有慢性躯体疾病']
];

function optionLabels(items) {
  return items.map((item) => item.label);
}

Page({
  data: {
    submitting: false,
    form: {
      visitor_name: '',
      visitor_age: '',
      visitor_city: '',
      description: '',
      occupation_other: ''
    },
    scores: {
      mood: 0,
      anxiety: 0,
      sleep: 0,
      function: 0,
      relation: 0
    },
    scoreItems: [
      { key: 'mood', label: '情绪低落' },
      { key: 'anxiety', label: '焦虑紧张' },
      { key: 'sleep', label: '睡眠困难' },
      { key: 'function', label: '功能受损' },
      { key: 'relation', label: '人际紧张' }
    ],
    issueOptions: issueOptionsSeed.map(([value, label]) => ({ value, label, active: false })),
    formatOptions: formatOptionsSeed.map(([value, label]) => ({ value, label, active: false })),
    expectOptions: expectOptionsSeed.map(([value, label]) => ({ value, label, active: false })),
    specialOptions: specialOptionsSeed.map(([value, label]) => ({ value, label, active: false })),
    genderOptions: [
      { value: '', label: '请选择' },
      { value: 'male', label: '男' },
      { value: 'female', label: '女' },
      { value: 'ta', label: 'TA' },
      { value: 'lgbtq', label: 'LGBTQ+' },
      { value: 'other', label: '其他/不便透露' }
    ],
    genderLabels: [],
    genderIndex: 0,
    filledByOptions: [
      { value: 'self', label: '本人填写' },
      { value: 'parent', label: '家长 / 监护人代填' }
    ],
    filledByLabels: [],
    filledByIndex: 0,
    occupationOptions: [
      { value: '', label: '请选择' },
      { value: 'student_k12', label: '在校学生（中小学）' },
      { value: 'student_college', label: '在校学生（大学及以上）' },
      { value: 'worker', label: '在职人员' },
      { value: 'parent_role', label: '家长' },
      { value: 'freelance', label: '自由职业 / 待业' },
      { value: 'retired', label: '退休人员' },
      { value: 'other', label: '其他' }
    ],
    occupationLabels: [],
    occupationIndex: 0,
    showOccupationOther: false,
    prevCounselingOptions: [
      { value: 'no', label: '否，这是第一次' },
      { value: 'yes_brief', label: '是，接受过简短咨询（5次以内）' },
      { value: 'yes_long', label: '是，接受过系统咨询（5次以上）' },
      { value: 'psychiatric', label: '是，曾就诊精神科或接受心理治疗' }
    ],
    prevCounselingLabels: [],
    prevCounselingIndex: 0,
    crisisLabels: ['无明显危机', '消极念头', '主动自伤/自杀想法', '已有行动风险'],
    crisisValues: ['safe', 'passive', 'active', 'action'],
    crisisIndex: 0,
    crisisWarningVisible: false,
    budgetOptions: [
      { value: '', label: '不介意 / 未考虑' },
      { value: 'low', label: '希望控制在 300元/次 以内' },
      { value: 'mid', label: '可接受 300-600元/次' },
      { value: 'high', label: '可接受 600-1000元/次' },
      { value: 'premium', label: '1000元/次 以上均可' }
    ],
    budgetLabels: [],
    budgetIndex: 0,
    genderPrefOptions: [
      { value: '', label: '不限 / 随机匹配' },
      { value: 'male', label: '希望是男性咨询师' },
      { value: 'female', label: '希望是女性咨询师' },
      { value: 'any', label: '咨询师性别不重要' }
    ],
    genderPrefLabels: [],
    genderPrefIndex: 0,
    agePrefOptions: [
      { value: '', label: '不限' },
      { value: 'older', label: '偏年长（更有经验感）' },
      { value: 'younger', label: '偏年轻（更容易亲近）' },
      { value: 'peer', label: '同龄相仿（更易共情）' }
    ],
    agePrefLabels: [],
    agePrefIndex: 0,
    orientationPrefOptions: [
      { value: '', label: '不需要' },
      { value: 'friendly', label: '希望咨询师对 LGBTQ+ 友善' },
      { value: 'experienced', label: '需要性少数相关经验的咨询师' }
    ],
    orientationPrefLabels: [],
    orientationPrefIndex: 0,
    commStyleOptions: [
      { value: '', label: '不限' },
      { value: 'talkative', label: '我想多说，希望咨询师多听' },
      { value: 'guided', label: '我不知道从哪说起，需要咨询师引导' },
      { value: 'shy', label: '我不太善于表达，需要咨询师带动' },
      { value: 'collaborative', label: '我想和咨询师平等交流、一起探讨' },
      { value: 'directive', label: '我希望咨询师多给建议和反馈' }
    ],
    commStyleLabels: [],
    commStyleIndex: 0,
    durationOptions: [
      { value: 'recent', label: '近期才出现（1个月以内）' },
      { value: 'months', label: '几个月（1-6个月）' },
      { value: 'half_year', label: '半年到一年' },
      { value: 'years', label: '1年以上' },
      { value: 'childhood', label: '从小就有（儿童/青少年期开始）' }
    ],
    durationLabels: [],
    durationIndex: 0,
    cnipOptions: {
      structure: [
        { value: 'structured', label: '有方向感' },
        { value: 'balanced', label: '适度引导' },
        { value: 'open', label: '自由探索' }
      ],
      emotion: [
        { value: 'emotional', label: '深入感受' },
        { value: 'balanced', label: '两者兼顾' },
        { value: 'rational', label: '聚焦解决' }
      ],
      timefocus: [
        { value: 'past', label: '探讨过去' },
        { value: 'balanced', label: '两者兼顾' },
        { value: 'present', label: '关注当下' }
      ],
      warmth: [
        { value: 'warm', label: '温和支持' },
        { value: 'balanced', label: '两者兼顾' },
        { value: 'direct', label: '坦诚直接' }
      ],
      homework: [
        { value: 'yes', label: '愿意' },
        { value: 'neutral', label: '无所谓' },
        { value: 'no', label: '不太愿意' }
      ],
      relational: [
        { value: 'discuss', label: '想讨论' },
        { value: 'neutral', label: '无所谓' },
        { value: 'skip', label: '不需要' }
      ]
    },
    cnip: {
      structure: '',
      emotion: '',
      timefocus: '',
      warmth: '',
      homework: '',
      relational: ''
    }
  },

  onLoad() {
    this.setData({
      genderLabels: optionLabels(this.data.genderOptions),
      filledByLabels: optionLabels(this.data.filledByOptions),
      occupationLabels: optionLabels(this.data.occupationOptions),
      prevCounselingLabels: optionLabels(this.data.prevCounselingOptions),
      budgetLabels: optionLabels(this.data.budgetOptions),
      genderPrefLabels: optionLabels(this.data.genderPrefOptions),
      agePrefLabels: optionLabels(this.data.agePrefOptions),
      orientationPrefLabels: optionLabels(this.data.orientationPrefOptions),
      commStyleLabels: optionLabels(this.data.commStyleOptions),
      durationLabels: optionLabels(this.data.durationOptions)
    });
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ [`form.${key}`]: e.detail.value });
  },

  onScoreChange(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ [`scores.${key}`]: Number(e.detail.value) });
  },

  onPickerChange(e) {
    const key = e.currentTarget.dataset.key;
    const index = Number(e.detail.value);
    const patch = { [key]: index };
    if (key === 'occupationIndex') {
      const option = this.data.occupationOptions[index] || {};
      patch.showOccupationOther = option.value === 'other';
    }
    this.setData(patch);
  },

  onCrisisChange(e) {
    const crisisIndex = Number(e.detail.value);
    this.setData({
      crisisIndex,
      crisisWarningVisible: crisisIndex >= 2
    });
  },

  toggleIssue(e) {
    const value = e.currentTarget.dataset.value;
    const issueOptions = this.data.issueOptions.map((item) => item.value === value ? { ...item, active: !item.active } : item);
    this.setData({ issueOptions });
  },

  toggleFormat(e) {
    const value = e.currentTarget.dataset.value;
    const formatOptions = this.data.formatOptions.map((item) => item.value === value ? { ...item, active: !item.active } : item);
    this.setData({ formatOptions });
  },

  toggleExpect(e) {
    const value = e.currentTarget.dataset.value;
    const expectOptions = this.data.expectOptions.map((item) => item.value === value ? { ...item, active: !item.active } : item);
    this.setData({ expectOptions });
  },

  toggleSpecial(e) {
    const value = e.currentTarget.dataset.value;
    const specialOptions = this.data.specialOptions.map((item) => item.value === value ? { ...item, active: !item.active } : item);
    this.setData({ specialOptions });
  },

  selectCnip(e) {
    const key = e.currentTarget.dataset.key;
    const value = e.currentTarget.dataset.value;
    this.setData({ [`cnip.${key}`]: this.data.cnip[key] === value ? '' : value });
  },

  severity(total) {
    if (total >= 15) return '重度';
    if (total >= 8) return '中度';
    return '轻度';
  },

  recommendedApproaches(issues) {
    const out = [];
    if (issues.includes('personality') || issues.includes('crisis')) out.push('DBT', '精神动力学');
    if (issues.includes('trauma')) out.push('EMDR', 'CBT');
    if (issues.includes('relationship') || issues.includes('marriage') || issues.includes('family')) out.push('家庭治疗', 'EFT');
    if (issues.includes('emotion') || issues.includes('workplace') || issues.includes('somatic') || issues.includes('sexual')) out.push('CBT', 'ACT');
    if (issues.includes('adolescent')) out.push('家庭治疗', 'CBT');
    if (issues.includes('eating') || issues.includes('addiction')) out.push('CBT', 'DBT');
    if (issues.includes('growth') || issues.includes('grief')) out.push('人本主义');
    return Array.from(new Set(out.length ? out : ['CBT']));
  },

  submitAssessment() {
    if (this.data.submitting) return;
    const app = getApp();
    this.setData({ submitting: true });

    app.ensureVisitor().then((visitor) => {
      const issues = this.data.issueOptions.filter((i) => i.active).map((i) => i.value);
      const formats = this.data.formatOptions.filter((i) => i.active).map((i) => i.value);
      const expects = this.data.expectOptions.filter((i) => i.active).map((i) => i.value);
      const specials = this.data.specialOptions.filter((i) => i.active).map((i) => i.value);
      const s = this.data.scores;
      const total = s.mood + s.anxiety + s.sleep + s.function + s.relation;
      const gender = this.data.genderOptions[this.data.genderIndex] || {};
      const filledBy = this.data.filledByOptions[this.data.filledByIndex] || {};
      const occupation = this.data.occupationOptions[this.data.occupationIndex] || {};
      const occupationText = occupation.value === 'other'
        ? (this.data.form.occupation_other || '其他')
        : (occupation.value ? occupation.label : '');
      const prevCounseling = this.data.prevCounselingOptions[this.data.prevCounselingIndex] || {};
      const budget = this.data.budgetOptions[this.data.budgetIndex] || {};
      const genderPref = this.data.genderPrefOptions[this.data.genderPrefIndex] || {};
      const agePref = this.data.agePrefOptions[this.data.agePrefIndex] || {};
      const orientationPref = this.data.orientationPrefOptions[this.data.orientationPrefIndex] || {};
      const commStyle = this.data.commStyleOptions[this.data.commStyleIndex] || {};
      const duration = this.data.durationOptions[this.data.durationIndex] || {};
      const payload = {
        visitor_name: this.data.form.visitor_name || '微信来访者',
        visitor_age: Number(this.data.form.visitor_age) || null,
        visitor_gender: gender.value ? gender.label : '',
        visitor_occupation: occupationText,
        visitor_city: this.data.form.visitor_city,
        filled_by: filledBy.value || 'self',
        prev_counseling: prevCounseling.label || '',
        budget: budget.value || '',
        preferred_formats: formats,
        gender_pref: genderPref.value || '',
        age_pref: agePref.value || '',
        orientation_pref: orientationPref.value || '',
        comm_style: commStyle.value || '',
        cnip_structure: this.data.cnip.structure,
        cnip_emotion: this.data.cnip.emotion,
        cnip_timefocus: this.data.cnip.timefocus,
        cnip_warmth: this.data.cnip.warmth,
        cnip_homework: this.data.cnip.homework,
        cnip_relational: this.data.cnip.relational,
        expects,
        issues,
        description: this.data.form.description,
        duration: duration.label || '',
        score_mood: s.mood,
        score_anxiety: s.anxiety,
        score_sleep: s.sleep,
        score_function: s.function,
        score_relation: s.relation,
        total_score: total,
        severity: this.severity(total),
        specials,
        crisis_level: this.data.crisisValues[this.data.crisisIndex],
        user_agent: 'wechat-miniprogram'
      };

      return createAssessment(visitor, payload).then((assessment) => {
        if (config.localDemoCounselorId) {
          return updateAssessment(assessment.id, {
            match_request_name: assessment.visitor_name,
            match_request_contact: visitor.openid,
            match_request_cid: config.localDemoCounselorId,
            match_request_status: 'pending'
          }).then(() => ({
            ...assessment,
            match_request_name: assessment.visitor_name,
            match_request_contact: visitor.openid,
            match_request_cid: config.localDemoCounselorId,
            match_request_status: 'pending'
          }));
        }
        return assessment;
      }).then((assessment) => {
        wx.setStorageSync('xpg_last_assessment', assessment);
        return listApprovedCounselors().then((counselors) => ({ assessment, counselors }));
      });
    }).then(({ assessment, counselors }) => {
      const issues = assessment.issues || [];
      const approaches = this.recommendedApproaches(issues);
      const matches = (counselors || []).map((c) => {
        let score = 0;
        const details = [];
        const specialties = c.specialties || [];
        const overlap = issues.filter((i) => specialties.includes(i));
        if (issues.length && overlap.length) {
          score += Math.round(overlap.length / issues.length * 40);
          details.push(`议题 ${overlap.length}/${issues.length}`);
        }
        const appOverlap = approaches.filter((a) => (c.approaches || []).includes(a));
        if (appOverlap.length) {
          score += Math.min(30, appOverlap.length * 15);
          details.push(appOverlap.join('/'));
        }
        if ((c.severity_levels || []).includes(assessment.severity)) score += 15;
        if (assessment.budget && c.fee_budget_level === assessment.budget) score += 10;
        if (assessment.visitor_city && c.city && c.city.indexOf(assessment.visitor_city) >= 0) score += 5;
        return { ...c, matchScore: score, matchDetails: details };
      }).filter((c) => c.matchScore > 0).sort((a, b) => b.matchScore - a.matchScore).slice(0, 3);

      wx.setStorageSync(`xpg_matches_${assessment.id}`, matches);
      wx.showToast({ title: '评估已保存', icon: 'success' });
      wx.switchTab({ url: '/pages/my/index' });
    }).catch((err) => {
      wx.showModal({ title: '提交失败', content: err.message || '请稍后重试', showCancel: false });
    }).finally(() => {
      this.setData({ submitting: false });
    });
  }
});
