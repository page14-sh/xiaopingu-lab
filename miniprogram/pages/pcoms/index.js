const { createSession, savePcomsRating } = require('../../utils/api');

Page({
  data: {
    assessmentId: '',
    submitting: false,
    ors: { individual: 5, interpersonal: 5, social: 5, overall: 5 },
    srs: { relationship: 8, goals: 8, approach: 8, overall: 8 },
    orsItems: [
      { key: 'individual', label: '个人状态' },
      { key: 'interpersonal', label: '人际关系' },
      { key: 'social', label: '社会角色' },
      { key: 'overall', label: '总体状态' }
    ],
    srsItems: [
      { key: 'relationship', label: '咨询关系' },
      { key: 'goals', label: '目标与主题' },
      { key: 'approach', label: '方法与过程' },
      { key: 'overall', label: '整体感受' }
    ]
  },

  onLoad(query) {
    this.setData({ assessmentId: query.aid || '' });
  },

  onScoreChange(e) {
    const group = e.currentTarget.dataset.group;
    const key = e.currentTarget.dataset.key;
    this.setData({ [`${group}.${key}`]: e.detail.value });
  },

  submit() {
    if (!this.data.assessmentId) {
      wx.showModal({ title: '缺少评估 ID', content: '请从我的评估进入评分。', showCancel: false });
      return;
    }
    if (this.data.submitting) return;
    this.setData({ submitting: true });

    createSession({
      assessment_id: this.data.assessmentId,
      visitor_name: '微信来访者',
      session_number: 1
    }).then((rows) => {
      const session = Array.isArray(rows) ? rows[0] : rows;
      if (!session || !session.id) throw new Error('会话创建失败');
      const ors = this.data.ors;
      const srs = this.data.srs;
      return Promise.all([
        savePcomsRating({
          session_id: session.id,
          type: 'ORS',
          item_individual: ors.individual,
          item_interpersonal: ors.interpersonal,
          item_social: ors.social,
          item_overall: ors.overall
        }),
        savePcomsRating({
          session_id: session.id,
          type: 'SRS',
          item_individual: srs.relationship,
          item_interpersonal: srs.goals,
          item_social: srs.approach,
          item_overall: srs.overall
        })
      ]);
    }).then(() => {
      wx.showToast({ title: '已提交', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 800);
    }).catch((err) => {
      wx.showModal({ title: '提交失败', content: err.message || '请稍后重试', showCancel: false });
    }).finally(() => {
      this.setData({ submitting: false });
    });
  }
});
