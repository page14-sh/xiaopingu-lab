const { createAssessment, listApprovedCounselors, updateAssessment } = require('../../utils/api');
const config = require('../../utils/config');

const issueOptionsSeed = [
  ['emotion', '情绪困扰'],
  ['relationship', '关系困境'],
  ['trauma', '创伤经历'],
  ['growth', '自我成长'],
  ['adolescent', '青少年问题'],
  ['marriage', '婚姻伴侣'],
  ['workplace', '职场困扰'],
  ['family', '家庭系统']
];

const formatOptionsSeed = [
  ['线下面询', '线下面询'],
  ['视频咨询', '视频咨询'],
  ['语音咨询', '语音咨询'],
  ['文字咨询', '文字咨询']
];

Page({
  data: {
    submitting: false,
    form: {
      visitor_name: '',
      visitor_age: '',
      visitor_city: '',
      description: ''
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
    crisisLabels: ['无明显危机', '消极念头', '主动自伤/自杀想法', '已有行动风险'],
    crisisValues: ['safe', 'passive', 'active', 'action'],
    crisisIndex: 0,
    budgetLabels: ['暂不填写', '200元以下', '200-400元', '400-800元', '800元以上'],
    budgetValues: ['', 'low', 'mid', 'high', 'premium'],
    budgetIndex: 0
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ [`form.${key}`]: e.detail.value });
  },

  onScoreChange(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ [`scores.${key}`]: e.detail.value });
  },

  onCrisisChange(e) {
    this.setData({ crisisIndex: Number(e.detail.value) });
  },

  onBudgetChange(e) {
    this.setData({ budgetIndex: Number(e.detail.value) });
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

  severity(total) {
    if (total >= 15) return '重度';
    if (total >= 8) return '中度';
    return '轻度';
  },

  recommendedApproaches(issues) {
    const out = [];
    if (issues.includes('trauma')) out.push('EMDR', 'CBT');
    if (issues.includes('relationship') || issues.includes('marriage') || issues.includes('family')) out.push('家庭治疗', 'EFT');
    if (issues.includes('emotion')) out.push('CBT', 'ACT');
    if (issues.includes('adolescent')) out.push('家庭治疗', 'CBT');
    return Array.from(new Set(out.length ? out : ['CBT']));
  },

  submitAssessment() {
    if (this.data.submitting) return;
    const app = getApp();
    this.setData({ submitting: true });

    app.ensureVisitor().then((visitor) => {
      const issues = this.data.issueOptions.filter((i) => i.active).map((i) => i.value);
      const formats = this.data.formatOptions.filter((i) => i.active).map((i) => i.value);
      const s = this.data.scores;
      const total = s.mood + s.anxiety + s.sleep + s.function + s.relation;
      const payload = {
        visitor_name: this.data.form.visitor_name || '微信来访者',
        visitor_age: Number(this.data.form.visitor_age) || null,
        visitor_city: this.data.form.visitor_city,
        preferred_formats: formats,
        issues,
        description: this.data.form.description,
        score_mood: s.mood,
        score_anxiety: s.anxiety,
        score_sleep: s.sleep,
        score_function: s.function,
        score_relation: s.relation,
        total_score: total,
        severity: this.severity(total),
        crisis_level: this.data.crisisValues[this.data.crisisIndex],
        budget: this.data.budgetValues[this.data.budgetIndex]
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
