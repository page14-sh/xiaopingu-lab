Page({
  data: {
    expertOpen: false,
    evidenceOpen: false
  },

  togglePanel(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ [key]: !this.data[key] });
  },

  startAssessment() {
    wx.navigateTo({ url: '/pages/assessment/index' });
  },

  openRecords() {
    wx.navigateTo({ url: '/pages/my/index' });
  }
});
