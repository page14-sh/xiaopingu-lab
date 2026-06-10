const { listMyAssessments } = require('../../utils/api');

Page({
  data: {
    loading: true,
    assessments: []
  },

  onShow() {
    this.load();
  },

  load() {
    const app = getApp();
    this.setData({ loading: true });
    app.ensureVisitor().then((visitor) => {
      return listMyAssessments(visitor.openid);
    }).then((rows) => {
      const assessments = (rows || []).map((item) => ({
        ...item,
        created_at_text: item.created_at ? item.created_at.slice(0, 10) : ''
      }));
      this.setData({ assessments });
    }).catch((err) => {
      wx.showModal({ title: '加载失败', content: err.message || '请稍后重试', showCancel: false });
    }).finally(() => {
      this.setData({ loading: false });
    });
  },

  openPcoms(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/pcoms/index?aid=${id}` });
  }
});
